import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { KeyframePosition, PropAction, Scene } from '../types/movie';
import {
  applyActionCelBlendedToRig,
  applyCostumeToRig,
  applyGroupColorOverride,
  applyPropActionTransform,
  applyRigColorOverride,
  buildTdtTextGroup,
  instantiateTemplateRig,
  loadAction,
  loadBackgroundView,
  LoadedBackgroundView,
  loadTemplate,
  ParsedAction,
  TemplateRig,
} from '../services/threeDmmEngine';
import { sound3DMM } from '../services/soundLibrary';
import { assetUrl } from '../utils/assetUrl';

export type StageEntityType = 'actor' | 'prop' | 'tdt';

export interface LivePlayheadState {
  sceneIndex: number;
  frame: number;
  renderFrame: number;
}

interface Viewport3DProps {
  sceneData: Scene;
  sceneIndex?: number;
  totalScenes?: number;
  activeViewNumber?: number;
  currentFrame: number;
  renderFrame?: number;
  isPlaying?: boolean;
  livePlayheadRef?: React.MutableRefObject<LivePlayheadState>;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null, type: StageEntityType | null) => void;
  onStageViewReady?: (view: LoadedBackgroundView) => void;
  moveUpDownMode: boolean;
  onToggleMoveUpDown: () => void;
  rotateMode: boolean;
  onToggleRotateMode: () => void;
  isRecordingMovement: boolean;
  onBeginRecordingAtFrame: (
    entityId: string,
    type: StageEntityType,
    startFrame: number,
    pos: KeyframePosition
  ) => void;
  onRecordMovementStep: (
    entityId: string,
    type: StageEntityType,
    frame: number,
    pos: KeyframePosition,
    advancePlayhead: boolean
  ) => void;
  onMoveEntityAtFrame: (
    entityId: string,
    type: StageEntityType,
    frame: number,
    pos: KeyframePosition,
    deltaX: number,
    deltaY: number,
    deltaZ: number
  ) => void;
}

// Reusable scratchpads (zero per-frame allocations)
const _camRightXZ = new THREE.Vector3();
const _camForwardXZ = new THREE.Vector3();
const _worldPosTmp = new THREE.Vector3();
const _screenPtA = new THREE.Vector3();
const _screenPtB = new THREE.Vector3();
const _eulerRotA = new THREE.Euler(0, 0, 0, 'YXZ');
const _eulerRotB = new THREE.Euler(0, 0, 0, 'YXZ');
const _eulerRotOut = new THREE.Euler(0, 0, 0, 'YXZ');
const _quatRotA = new THREE.Quaternion();
const _quatRotB = new THREE.Quaternion();
const _dragBox = new THREE.Box3();
const _dragSize = new THREE.Vector3();
const _dragCenter = new THREE.Vector3();

// Small/close movements (<= 22 units) interpolate smoothly along a curved path;
// farther/bigger jumps (> 22 units) snap without interpolation.
const INTERP_JUMP_THRESHOLD = 22.0;

function disposeRig(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && mesh.geometry.attributes?.position?.count === 0) {
      mesh.geometry.dispose();
    }
  });
}

function storageToWorld(
  sceneData: Scene,
  bgView: LoadedBackgroundView | null,
  kf: { x: number; y: number; z: number; rotX?: number; rotY?: number; rotZ?: number },
  outPos: THREE.Vector3
): number {
  if (sceneData.coordMode === 'world' || !bgView) {
    outPos.set(kf.x, kf.y, kf.z);
    return kf.rotY || 0;
  }
  const o = bgView.stageOrigin;
  const r = bgView.camRightXZ;
  const f = bgView.camForwardXZ;
  outPos.set(
    o.x + r.x * kf.x - f.x * kf.z,
    o.y + kf.y,
    o.z + r.z * kf.x - f.z * kf.z
  );
  const facingCamRotY = Math.atan2(-f.x, -f.z);
  return facingCamRotY + (kf.rotY || 0);
}

function worldToStorage(
  sceneData: Scene,
  bgView: LoadedBackgroundView | null,
  wx: number,
  wy: number,
  wz: number,
  worldRotY: number,
  rotX = 0,
  rotZ = 0
): KeyframePosition {
  if (sceneData.coordMode === 'world' || !bgView) {
    return {
      x: wx,
      y: wy,
      z: wz,
      rotY: worldRotY,
      ...(Math.abs(rotX) > 1e-4 ? { rotX } : {}),
      ...(Math.abs(rotZ) > 1e-4 ? { rotZ } : {}),
    };
  }
  const o = bgView.stageOrigin;
  const r = bgView.camRightXZ;
  const f = bgView.camForwardXZ;
  const dx = wx - o.x;
  const dy = wy - o.y;
  const dz = wz - o.z;
  // Exact 2x2 solve for [r.x, -f.x; r.z, -f.z] * [sx; sz] = [dx; dz]
  const det = r.x * -f.z - -f.x * r.z;
  let sx = dx;
  let sz = dz;
  if (Math.abs(det) > 1e-6) {
    sx = (-f.z * dx + f.x * dz) / det;
    sz = (-r.z * dx + r.x * dz) / det;
  }
  const facingCamRotY = Math.atan2(-f.x, -f.z);
  return {
    x: sx,
    y: dy,
    z: sz,
    rotY: worldRotY - facingCamRotY,
    ...(Math.abs(rotX) > 1e-4 ? { rotX } : {}),
    ...(Math.abs(rotZ) > 1e-4 ? { rotZ } : {}),
  };
}

export function resolveActiveCameraAtFrame(
  sceneData: Scene,
  frame: number
): { icam: number; yaw: number; pitch: number } {
  const cuts = sceneData.cameraCuts;
  if (!cuts || cuts.length === 0) {
    return {
      icam: sceneData.icam,
      yaw: sceneData.cameraAngle.yaw,
      pitch: sceneData.cameraAngle.pitch,
    };
  }
  let chosen: (typeof cuts)[number] | null = null;
  for (let i = 0; i < cuts.length; i++) {
    if (cuts[i].frame <= frame && (!chosen || cuts[i].frame >= chosen.frame)) {
      chosen = cuts[i];
    }
  }
  if (!chosen) {
    return {
      icam: sceneData.icam,
      yaw: sceneData.cameraAngle.yaw,
      pitch: sceneData.cameraAngle.pitch,
    };
  }
  return {
    icam: chosen.icam,
    yaw: chosen.yaw ?? sceneData.cameraAngle.yaw,
    pitch: chosen.pitch ?? sceneData.cameraAngle.pitch,
  };
}

export function resolveActorActionAtFrame(
  actor: Scene['actors'][number],
  frame: number
): { anid: number; actionName: string; startFrame: number; celOffset: number; freeze: boolean } {
  const akfs = actor.actionKeyframes;
  if (!akfs) {
    return { anid: actor.anid, actionName: actor.actionName, startFrame: 0, celOffset: 0, freeze: false };
  }
  const frames = Object.keys(akfs).map(Number).sort((a, b) => a - b);
  let chosenFrame = -1;
  for (const f of frames) {
    if (f <= frame) chosenFrame = f;
    else break;
  }
  if (chosenFrame >= 0) {
    return {
      anid: akfs[chosenFrame].anid,
      actionName: akfs[chosenFrame].actionName,
      startFrame: chosenFrame,
      celOffset: akfs[chosenFrame].celOffset ?? 0,
      freeze: Boolean(akfs[chosenFrame].freeze),
    };
  }
  return { anid: actor.anid, actionName: actor.actionName, startFrame: 0, celOffset: 0, freeze: false };
}

export function resolvePropActionAtFrame(
  prop: Scene['props'][number],
  frame: number
): { action: PropAction; anid?: number; startFrame: number; celOffset: number; freeze: boolean } {
  const akfs = prop.actionKeyframes;
  if (!akfs) {
    return { action: prop.action, anid: prop.anid, startFrame: 0, celOffset: 0, freeze: false };
  }
  const frames = Object.keys(akfs).map(Number).sort((a, b) => a - b);
  let chosenFrame = -1;
  for (const f of frames) {
    if (f <= frame) chosenFrame = f;
    else break;
  }
  if (chosenFrame >= 0) {
    return {
      action: akfs[chosenFrame].action,
      anid: akfs[chosenFrame].anid,
      startFrame: chosenFrame,
      celOffset: akfs[chosenFrame].celOffset ?? 0,
      freeze: Boolean(akfs[chosenFrame].freeze),
    };
  }
  return { action: prop.action, anid: prop.anid, startFrame: 0, celOffset: 0, freeze: false };
}

function evalMonotoneHermiteSegment(
  p1: number,
  p2: number,
  u: number,
  dt: number,
  hasPrev: boolean,
  p0: number,
  dtPrev: number,
  hasNext: boolean,
  p3: number,
  dtNext: number
): number {
  const safeDt = Math.max(1e-4, dt);
  const vCur = (p2 - p1) / safeDt;

  let m1 = 0;
  if (hasPrev) {
    const vPrev = (p1 - p0) / Math.max(1e-4, dtPrev);
    if (vPrev * vCur > 0) {
      const w1 = 2 * safeDt + dtPrev;
      const w2 = safeDt + 2 * dtPrev;
      m1 = ((w1 + w2) / (w1 / vPrev + w2 / vCur)) * safeDt;
    }
  }

  let m2 = 0;
  if (hasNext) {
    const vNext = (p3 - p2) / Math.max(1e-4, dtNext);
    if (vCur * vNext > 0) {
      const w1 = 2 * dtNext + safeDt;
      const w2 = dtNext + 2 * safeDt;
      m2 = ((w1 + w2) / (w1 / vCur + w2 / vNext)) * safeDt;
    }
  }

  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p1 +
    (u3 - 2 * u2 + u) * m1 +
    (-2 * u3 + 3 * u2) * p2 +
    (u3 - u2) * m2
  );
}

function lerpShortestAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}

function dist3D(a: KeyframePosition, b: KeyframePosition): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

const _colA = new THREE.Color();
const _colB = new THREE.Color();
const _colMix = new THREE.Color();

function lerpColorHex(hexA?: string, hexB?: string, t = 0): string | undefined {
  if (!hexA && !hexB) return undefined;
  const a = hexA || hexB!;
  const b = hexB || hexA!;
  if (a.toLowerCase() === b.toLowerCase() || t <= 0) return a;
  if (t >= 1) return b;
  _colA.set(a);
  _colB.set(b);
  _colMix.copy(_colA).lerp(_colB, t);
  return '#' + _colMix.getHexString();
}

/**
 * Resolves entity transform & color at frame (supports 60+ FPS fractional subframes!)
 * with C1-continuous, overshoot-free time-aware monotone cubic Hermite interpolation
 * for smooth multi-keyframe paths (<= 22 units), and clean snap for farther jumps (> 22 units).
 */
export function resolveInterpolatedKeyframe(
  keyframes: Record<number, KeyframePosition>,
  frame: number,
  defaultColor?: string
): KeyframePosition {
  if (keyframes[frame]) return keyframes[frame];
  const frames = Object.keys(keyframes).map(Number).sort((a, b) => a - b);
  if (frames.length === 0) return { x: 0, y: 0, z: 0, rotY: 0 };
  if (frame <= frames[0]) return keyframes[frames[0]];
  if (frame >= frames[frames.length - 1]) return keyframes[frames[frames.length - 1]];

  let i = 0;
  while (i + 1 < frames.length && frames[i + 1] <= frame) i++;
  const f1 = frames[i];
  const f2 = frames[i + 1];
  const p1 = keyframes[f1];
  const p2 = keyframes[f2];

  // Resolve inherited colors for color interpolation
  let c1 = p1.color;
  if (!c1) {
    for (let k = i - 1; k >= 0; k--) {
      if (keyframes[frames[k]].color) {
        c1 = keyframes[frames[k]].color;
        break;
      }
    }
    if (!c1) c1 = defaultColor;
  }
  const c2 = p2.color || c1;

  // Hidden segments or larger/farther movements snap cleanly with no interpolation
  const dist = dist3D(p1, p2);
  if (p1.visible === false || p2.visible === false || dist > INTERP_JUMP_THRESHOLD) {
    return c1 && p1.color !== c1 ? { ...p1, color: c1 } : p1;
  }

  const dt = Math.max(1e-4, f2 - f1);
  const rawT = Math.max(0, Math.min(1, (frame - f1) / dt));

  const hasPrev =
    i > 0 &&
    keyframes[frames[i - 1]].visible !== false &&
    dist3D(keyframes[frames[i - 1]], p1) <= INTERP_JUMP_THRESHOLD;
  const hasNext =
    i + 2 < frames.length &&
    keyframes[frames[i + 2]].visible !== false &&
    dist3D(p2, keyframes[frames[i + 2]]) <= INTERP_JUMP_THRESHOLD;
  const p0 = hasPrev ? keyframes[frames[i - 1]] : p1;
  const p3 = hasNext ? keyframes[frames[i + 2]] : p2;
  const dtPrev = hasPrev ? f1 - frames[i - 1] : dt;
  const dtNext = hasNext ? frames[i + 2] - f2 : dt;

  const s1x = p1.scaleX ?? 1;
  const s1y = p1.scaleY ?? 1;
  const s1z = p1.scaleZ ?? 1;
  const s2x = p2.scaleX ?? 1;
  const s2y = p2.scaleY ?? 1;
  const s2z = p2.scaleZ ?? 1;

  let x: number;
  let y: number;
  let z: number;
  let sx: number;
  let sy: number;
  let sz: number;
  let rotT: number;

  if (!hasPrev && !hasNext) {
    // Isolated 2-keyframe move: smooth S-curve from rest to rest + fixed gentle XZ arc
    const easeT = rawT * rawT * (3 - 2 * rawT);
    x = p1.x + (p2.x - p1.x) * easeT;
    y = p1.y + (p2.y - p1.y) * easeT;
    z = p1.z + (p2.z - p1.z) * easeT;

    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const chordXZ = Math.hypot(dx, dz);
    if (chordXZ > 0.15) {
      const perpX = -dz / chordXZ;
      const perpZ = dx / chordXZ;
      const arcAmt = Math.sin(Math.PI * easeT) * Math.min(chordXZ * 0.14, 1.5);
      x += perpX * arcAmt;
      z += perpZ * arcAmt;
    }

    sx = s1x + (s2x - s1x) * easeT;
    sy = s1y + (s2y - s1y) * easeT;
    sz = s1z + (s2z - s1z) * easeT;
    rotT = easeT;
  } else {
    // Connected multi-keyframe path: C1-continuous, monotone (zero overshoot / zero stop-and-go pulse)
    x = evalMonotoneHermiteSegment(p1.x, p2.x, rawT, dt, hasPrev, p0.x, dtPrev, hasNext, p3.x, dtNext);
    y = evalMonotoneHermiteSegment(p1.y, p2.y, rawT, dt, hasPrev, p0.y, dtPrev, hasNext, p3.y, dtNext);
    z = evalMonotoneHermiteSegment(p1.z, p2.z, rawT, dt, hasPrev, p0.z, dtPrev, hasNext, p3.z, dtNext);

    const s0x = p0.scaleX ?? 1;
    const s0y = p0.scaleY ?? 1;
    const s0z = p0.scaleZ ?? 1;
    const s3x = p3.scaleX ?? 1;
    const s3y = p3.scaleY ?? 1;
    const s3z = p3.scaleZ ?? 1;
    sx = Math.max(0.05, evalMonotoneHermiteSegment(s1x, s2x, rawT, dt, hasPrev, s0x, dtPrev, hasNext, s3x, dtNext));
    sy = Math.max(0.05, evalMonotoneHermiteSegment(s1y, s2y, rawT, dt, hasPrev, s0y, dtPrev, hasNext, s3y, dtNext));
    sz = Math.max(0.05, evalMonotoneHermiteSegment(s1z, s2z, rawT, dt, hasPrev, s0z, dtPrev, hasNext, s3z, dtNext));
    rotT = rawT;
  }

  const mixedColor = c1 || c2 ? lerpColorHex(c1, c2, rotT) : undefined;

  _eulerRotA.set(p1.rotX || 0, p1.rotY || 0, p1.rotZ || 0, 'YXZ');
  _eulerRotB.set(p2.rotX || 0, p2.rotY || 0, p2.rotZ || 0, 'YXZ');
  _quatRotA.setFromEuler(_eulerRotA);
  _quatRotB.setFromEuler(_eulerRotB);
  _quatRotA.slerp(_quatRotB, rotT);
  _eulerRotOut.setFromQuaternion(_quatRotA, 'YXZ');

  return {
    x,
    y,
    z,
    ...(Math.abs(_eulerRotOut.x) > 1e-4 ? { rotX: _eulerRotOut.x } : {}),
    rotY: _eulerRotOut.y,
    ...(Math.abs(_eulerRotOut.z) > 1e-4 ? { rotZ: _eulerRotOut.z } : {}),
    scaleX: sx,
    scaleY: sy,
    scaleZ: sz,
    visible: p1.visible,
    ...(mixedColor ? { color: mixedColor } : {}),
  };
}

function distToSegment2D(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-4) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

export const Viewport3D: React.FC<Viewport3DProps> = ({
  sceneData,
  sceneIndex = 0,
  totalScenes = 1,
  activeViewNumber,
  currentFrame,
  renderFrame,
  isPlaying = false,
  livePlayheadRef,
  selectedEntityId,
  onSelectEntity,
  onStageViewReady,
  moveUpDownMode,
  onToggleMoveUpDown,
  rotateMode,
  onToggleRotateMode,
  isRecordingMovement,
  onBeginRecordingAtFrame,
  onRecordMovementStep,
  onMoveEntityAtFrame,
}) => {
  const wellRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const [stageBoxSize, setStageBoxSize] = useState<{ w: number; h: number }>({ w: 544, h: 306 });
  const [backdropUrl, setBackdropUrl] = useState<string | null>(null);
  const [loadingStage, setLoadingStage] = useState<boolean>(true);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const depthPrePassMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const depthPrePassMeshRef = useRef<THREE.Mesh | null>(null);
  const floorShadowMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const floorShadowMeshRef = useRef<THREE.Mesh | null>(null);
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const fillLightRef = useRef<THREE.DirectionalLight | null>(null);

  const bgViewRef = useRef<LoadedBackgroundView | null>(null);
  const actorRigsRef = useRef<Map<string, TemplateRig>>(new Map());
  const propRigsRef = useRef<Map<string, TemplateRig>>(new Map());
  const tdtGroupsRef = useRef<Map<string, THREE.Group>>(new Map());
  const activeActionsRef = useRef<Map<string, ParsedAction>>(new Map());
  const textBoxInnerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const actorsGroupRef = useRef<THREE.Group>(new THREE.Group());
  const propsGroupRef = useRef<THREE.Group>(new THREE.Group());
  const tdtContainerRef = useRef<THREE.Group>(new THREE.Group());
  const trailDotsGroupRef = useRef<THREE.Group>(new THREE.Group());
  const shadowPlaneRef = useRef<THREE.Mesh | null>(null);
  const yellowOutlineBoxRef = useRef<THREE.LineSegments | null>(null);

  const sharedDotGeoRef = useRef<THREE.CylinderGeometry | null>(null);
  const sharedDotMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const sharedCurDotMatRef = useRef<THREE.MeshStandardMaterial | null>(null);

  // Live pointer drag + 6 FPS recording refs (live world coordinates converted on commit)
  const isDraggingRef = useRef(false);
  const hasStartedDragMoveRef = useRef(false);
  const dragEntityIdRef = useRef<string | null>(null);
  const dragEntityTypeRef = useRef<StageEntityType | null>(null);
  const pointerDownClientRef = useRef({ x: 0, y: 0 });
  const lastPointerClientRef = useRef({ x: 0, y: 0 });
  const dragStartWorldPosRef = useRef({ x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 });
  const dragLiveWorldPosRef = useRef({ x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 });
  const prevStoragePosRef = useRef({ x: 0, y: 0, z: 0 });
  const lastHeadingPosRef = useRef({ x: 0, z: 0 });
  const recordingFrameRef = useRef(0);
  const recordingIntervalRef = useRef<number | null>(null);
  const boxOffsetRef = useRef(new THREE.Vector3());
  const raycasterRef = useRef(new THREE.Raycaster());
  const mousePosRef = useRef(new THREE.Vector2());

  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;
  const sceneIndexRef = useRef(sceneIndex);
  sceneIndexRef.current = sceneIndex;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const livePlayheadPropRef = useRef(livePlayheadRef);
  livePlayheadPropRef.current = livePlayheadRef;
  const applyStageAtFrameRef = useRef<(evalFrame: number) => void>(() => {});
  const moveUpDownModeRef = useRef(moveUpDownMode);
  moveUpDownModeRef.current = moveUpDownMode;
  const rotateModeRef = useRef(rotateMode);
  rotateModeRef.current = rotateMode;
  const isRecordingMovementRef = useRef(isRecordingMovement);
  isRecordingMovementRef.current = isRecordingMovement;
  const selectedEntityIdRef = useRef(selectedEntityId);
  selectedEntityIdRef.current = selectedEntityId;
  const sceneDataRef = useRef(sceneData);
  sceneDataRef.current = sceneData;
  const onStageViewReadyRef = useRef(onStageViewReady);
  onStageViewReadyRef.current = onStageViewReady;
  const onBeginRecordingRef = useRef(onBeginRecordingAtFrame);
  onBeginRecordingRef.current = onBeginRecordingAtFrame;
  const onRecordMovementStepRef = useRef(onRecordMovementStep);
  onRecordMovementStepRef.current = onRecordMovementStep;
  const onMoveEntityAtFrameRef = useRef(onMoveEntityAtFrame);
  onMoveEntityAtFrameRef.current = onMoveEntityAtFrame;

  const [syncVersion, setSyncVersion] = useState(0);
  const [webglError, setWebglError] = useState<string | null>(null);

  const activeCam = resolveActiveCameraAtFrame(sceneData, currentFrame);

  const stopRecordingTimer = () => {
    if (recordingIntervalRef.current !== null) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  };

  // Exact 544:306 stage well fitter so ZBMP, MBMP, and camera aspect NEVER drift apart
  useEffect(() => {
    const well = wellRef.current;
    if (!well) return;
    const fit = () => {
      const availW = Math.max(160, well.clientWidth - 22);
      const availH = Math.max(90, well.clientHeight - 22);
      const ratio = 544 / 306;
      let w = availW;
      let h = w / ratio;
      if (h > availH) {
        h = availH;
        w = h * ratio;
      }
      setStageBoxSize({ w: Math.floor(w), h: Math.floor(h) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(well);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);

  // Initialize transparent WebGL canvas + ZBMP depth-prepass + ZBMP Floor-Only Shadow shader
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const isSoftwareGl = (() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
        const gpu = String(gl.getParameter(param));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return false;
      }
    })();

    const width = Math.max(1, mount.clientWidth || 544);
    const height = Math.max(1, mount.clientHeight || 306);

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Official 3DMM 544x306 camera frustum (aspect strictly locked to 544/306)
    const camera = new THREE.PerspectiveCamera(47, 544 / 306, 1.0, 5000);
    camera.position.set(0, 12, 60);
    camera.lookAt(0, 4, 0);
    camera.updateMatrixWorld();
    cameraRef.current = camera;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      setWebglError(err instanceof Error ? err.message : 'WebGL context could not be initialized.');
      return;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 3DMM ZBMP 16-bit Depth Buffer Pre-Pass (occludes actors behind foreground stage walls/props)
    const depthMat = new THREE.ShaderMaterial({
      uniforms: {
        uZbmp: { value: null },
        uBias: { value: 0.00018 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uZbmp;
        uniform float uBias;
        varying vec2 vUv;
        void main() {
          vec4 tex = texture2D(uZbmp, vUv);
          float hi = floor(tex.r * 255.0 + 0.5);
          float lo = floor(tex.g * 255.0 + 0.5);
          float z16 = hi * 256.0 + lo;
          gl_FragDepth = (z16 >= 32767.5) ? 1.0 : clamp(0.5 + z16 / 65536.0 + uBias, 0.0, 1.0);
          gl_FragColor = vec4(0.0);
        }
      `,
      depthTest: true,
      depthWrite: true,
      colorWrite: false,
      transparent: false,
    });
    const depthGeo = new THREE.PlaneGeometry(2, 2);
    const depthMesh = new THREE.Mesh(depthGeo, depthMat);
    depthMesh.frustumCulled = false;
    depthMesh.renderOrder = -1000;
    depthMesh.visible = false;
    scene.add(depthMesh);
    depthPrePassMatRef.current = depthMat;
    depthPrePassMeshRef.current = depthMesh;

    // ZBMP Depth-Map Real Ground Shadow Pass:
    // Reconstructs W(uv) and surface normal N(uv) from the 16-bit ZBMP depth buffer and evaluates
    // Three.js keyLight's real PCF shadow map onto upward-facing stage floors, ramps & steps.
    const floorShadowMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.lights,
        {
          uZbmp: { value: null },
          uInvViewProj: { value: new THREE.Matrix4() },
          uLightShadowMatrix: { value: new THREE.Matrix4() },
        },
      ]),
      lights: true,
      vertexShader: `
        varying vec2 vUv;
        #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
          varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
        #endif
        void main() {
          vUv = uv;
          #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
            vDirectionalShadowCoord[ 0 ] = vec4( 0.0 );
          #endif
          gl_Position = vec4( position.xy, 0.0, 1.0 );
        }
      `,
      fragmentShader: `
        uniform sampler2D uZbmp;
        uniform mat4 uInvViewProj;
        uniform mat4 uLightShadowMatrix;
        varying vec2 vUv;

        #include <common>
        #include <packing>
        #include <shadowmap_pars_fragment>

        float readZ16(vec2 uv) {
          vec4 t = texture2D(uZbmp, clamp(uv, 0.0, 1.0));
          return floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5);
        }

        vec3 unprojectWorld(vec2 uv, float z16) {
          vec4 ndc = vec4(uv * 2.0 - 1.0, z16 / 32768.0, 1.0);
          vec4 w = uInvViewProj * ndc;
          return w.xyz / max(w.w, 0.0001);
        }

        void main() {
          #if !defined( USE_SHADOWMAP ) || NUM_DIR_LIGHT_SHADOWS <= 0
            discard;
          #else
            float zC = readZ16(vUv);
            if (zC >= 32767.0) discard;

            // 3-texel symmetric finite differences reconstruct world normal of the ZBMP surface
            vec2 stepX = vec2(3.0 / 544.0, 0.0);
            vec2 stepY = vec2(0.0, 3.0 / 306.0);
            vec2 uvR = clamp(vUv + stepX, 0.0, 1.0);
            vec2 uvL = clamp(vUv - stepX, 0.0, 1.0);
            vec2 uvU = clamp(vUv + stepY, 0.0, 1.0);
            vec2 uvD = clamp(vUv - stepY, 0.0, 1.0);

            float zR = readZ16(uvR);
            float zL = readZ16(uvL);
            float zU = readZ16(uvU);
            float zD = readZ16(uvD);

            vec3 wC = unprojectWorld(vUv, zC);
            vec3 dX = vec3(0.0);
            bool okR = zR < 32767.0 && abs(zR - zC) < 1400.0;
            bool okL = zL < 32767.0 && abs(zL - zC) < 1400.0;
            if (okR && okL) dX = unprojectWorld(uvR, zR) - unprojectWorld(uvL, zL);
            else if (okR) dX = unprojectWorld(uvR, zR) - wC;
            else if (okL) dX = wC - unprojectWorld(uvL, zL);
            else discard;

            vec3 dY = vec3(0.0);
            bool okU = zU < 32767.0 && abs(zU - zC) < 1400.0;
            bool okD = zD < 32767.0 && abs(zD - zC) < 1400.0;
            if (okU && okD) dY = unprojectWorld(uvU, zU) - unprojectWorld(uvD, zD);
            else if (okU) dY = unprojectWorld(uvU, zU) - wC;
            else if (okD) dY = wC - unprojectWorld(uvD, zD);
            else discard;

            vec3 nrm = normalize(cross(dX, dY));
            if (nrm.y < 0.0) nrm = -nrm;

            // Cast real shadows onto upward-facing ZBMP ground/floor/step surfaces only
            float floorMask = smoothstep(0.28, 0.65, nrm.y);
            if (floorMask < 0.01) discard;

            vec4 shadowCoord = uLightShadowMatrix * vec4(wC + nrm * 0.08, 1.0);
            DirectionalLightShadow dirShadow = directionalLightShadows[0];
            float lit = getShadow(
              directionalShadowMap[0],
              dirShadow.shadowMapSize,
              dirShadow.shadowIntensity,
              dirShadow.shadowBias,
              dirShadow.shadowRadius,
              shadowCoord
            );

            float shadowAmt = clamp(1.0 - lit, 0.0, 1.0);
            float alpha = clamp(shadowAmt * floorMask * 0.44, 0.0, 0.46);
            if (alpha < 0.008) discard;
            gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
          #endif
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    const floorShadowGeo = new THREE.PlaneGeometry(2, 2);
    const floorShadowMesh = new THREE.Mesh(floorShadowGeo, floorShadowMat);
    floorShadowMesh.frustumCulled = false;
    floorShadowMesh.receiveShadow = true;
    floorShadowMesh.renderOrder = -900;
    floorShadowMesh.visible = false;
    scene.add(floorShadowMesh);
    floorShadowMatRef.current = floorShadowMat;
    floorShadowMeshRef.current = floorShadowMesh;

    // 3DMM Studio Lighting Rig (smooth Gouraud illumination)
    const hemi = new THREE.HemisphereLight('#ffffff', '#334155', 1.45);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight('#fffbeb', 1.65);
    keyLight.position.set(28, 88, 32);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(isSoftwareGl ? 1024 : 2048, isSoftwareGl ? 1024 : 2048);
    keyLight.shadow.camera.near = 4;
    keyLight.shadow.camera.far = 260;
    keyLight.shadow.camera.left = -85;
    keyLight.shadow.camera.right = 85;
    keyLight.shadow.camera.top = 85;
    keyLight.shadow.camera.bottom = -85;
    keyLight.shadow.bias = -0.0006;
    keyLight.shadow.normalBias = 0.03;
    keyLight.shadow.radius = 2.5;
    scene.add(keyLight);
    scene.add(keyLight.target);
    keyLightRef.current = keyLight;

    floorShadowMesh.onBeforeRender = () => {
      floorShadowMat.uniforms.uLightShadowMatrix.value.copy(keyLight.shadow.matrix);
    };

    const fillLight = new THREE.DirectionalLight('#dbeafe', 0.85);
    fillLight.position.set(-40, 30, -25);
    scene.add(fillLight);
    scene.add(fillLight.target);
    fillLightRef.current = fillLight;

    // Fallback ground plane strictly when camera look is trimmed away from ZBMP
    const shadowMat = new THREE.ShadowMaterial({
      opacity: 0.34,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), shadowMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.receiveShadow = true;
    shadowPlane.renderOrder = -500;
    shadowPlane.visible = false;
    scene.add(shadowPlane);
    shadowPlaneRef.current = shadowPlane;

    scene.add(actorsGroupRef.current);
    scene.add(propsGroupRef.current);
    scene.add(tdtContainerRef.current);
    scene.add(trailDotsGroupRef.current);

    sharedDotGeoRef.current = new THREE.CylinderGeometry(0.42, 0.42, 0.14, 12);
    sharedDotMatRef.current = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      flatShading: false,
    });
    sharedCurDotMatRef.current = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      flatShading: false,
    });

    // Yellow wireframe rectangle outline shown strictly while dragging.
    // Depth-tested after actors/props so rear edges blocked by the object are partial (no Necker cube illusion).
    const yellowBoxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2));
    const yellowBoxMat = new THREE.LineBasicMaterial({
      color: 0xffff00,
      depthTest: true,
      depthWrite: false,
    });
    const yellowOutlineBox = new THREE.LineSegments(yellowBoxGeo, yellowBoxMat);
    yellowOutlineBox.renderOrder = 50;
    yellowOutlineBox.visible = false;
    scene.add(yellowOutlineBox);
    yellowOutlineBoxRef.current = yellowOutlineBox;

    let frameId = 0;
    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (gl && typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            frameId = window.setTimeout(poll, 5);
          } else {
            if (sync) gl.deleteSync(sync);
            frameId = window.setTimeout(cb, 80);
          }
        };
        frameId = window.setTimeout(poll, 5);
      } else {
        frameId = window.setTimeout(cb, 80);
      }
    };

    const tick = () => {
      if (isPlayingRef.current) {
        const live = livePlayheadPropRef.current?.current;
        if (live && live.sceneIndex === sceneIndexRef.current) {
          applyStageAtFrameRef.current(live.renderFrame);
        }
      }
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
      if (isSoftwareGl) afterDraw(tick);
      else frameId = requestAnimationFrame(tick);
    };
    tick();

    const handleResize = () => {
      if (!mount || !rendererRef.current || !cameraRef.current) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w <= 0 || h <= 0) return;
      // Lock camera aspect to exact 544/306 so ZBMP/MBMP and WebGL stay pixel-locked
      cameraRef.current.aspect = 544 / 306;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };

    const ro = new ResizeObserver(handleResize);
    ro.observe(mount);
    window.addEventListener('resize', handleResize);

    return () => {
      stopRecordingTimer();
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      ro.disconnect();
      window.removeEventListener('resize', handleResize);
      sharedDotGeoRef.current?.dispose();
      sharedDotMatRef.current?.dispose();
      sharedCurDotMatRef.current?.dispose();
      depthGeo.dispose();
      depthMat.dispose();
      floorShadowGeo.dispose();
      floorShadowMat.dispose();
      shadowPlane.geometry.dispose();
      shadowMat.dispose();
      if (renderer.domElement && mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    if (!isRecordingMovement) stopRecordingTimer();
  }, [isRecordingMovement]);

  useEffect(() => {
    stopRecordingTimer();
    isDraggingRef.current = false;
    hasStartedDragMoveRef.current = false;
    dragEntityIdRef.current = null;
    dragEntityTypeRef.current = null;
    if (yellowOutlineBoxRef.current) yellowOutlineBoxRef.current.visible = false;
  }, [sceneData.id]);

  // Load real BKGD + CAM view (MBMP backdrop + ZBMP depth buffer + BRender camera + APOS points)
  useEffect(() => {
    let cancelled = false;
    setLoadingStage(true);

    loadBackgroundView(sceneData.bkgdCno, activeCam.icam)
      .then((bgView) => {
        if (cancelled) return;
        bgViewRef.current = bgView;
        setBackdropUrl(bgView.backdropDataUrl);
        onStageViewReadyRef.current?.(bgView);

        if (cameraRef.current) {
          const cam = cameraRef.current;
          cam.fov = bgView.fovDeg;
          cam.aspect = 544 / 306;
          cam.near = bgView.hither;
          cam.far = bgView.yon;
          cam.updateProjectionMatrix();

          cam.position.copy(bgView.camPosition);
          cam.quaternion.copy(bgView.camQuaternion);
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        }

        if (depthPrePassMatRef.current && depthPrePassMeshRef.current) {
          depthPrePassMatRef.current.uniforms.uZbmp.value = bgView.zbmpDepthTexture;
          depthPrePassMeshRef.current.visible = Boolean(bgView.zbmpDepthTexture);
        }
        if (floorShadowMatRef.current && floorShadowMeshRef.current && cameraRef.current) {
          const vp = new THREE.Matrix4().multiplyMatrices(
            cameraRef.current.projectionMatrix,
            cameraRef.current.matrixWorldInverse
          );
          floorShadowMatRef.current.uniforms.uZbmp.value = bgView.zbmpDepthTexture;
          floorShadowMatRef.current.uniforms.uInvViewProj.value.copy(vp).invert();
          floorShadowMeshRef.current.visible = Boolean(bgView.zbmpDepthTexture);
        }

        if (shadowPlaneRef.current) {
          shadowPlaneRef.current.position.copy(bgView.stageOrigin);
          shadowPlaneRef.current.visible = !bgView.zbmpDepthTexture;
        }

        // Aim directional shadow frustum cleanly around the active stage origin
        const shadowCenter = bgView.stageOrigin
          .clone()
          .addScaledVector(bgView.camForwardXZ, 8);
        if (keyLightRef.current) {
          const kl = keyLightRef.current;
          kl.target.position.copy(shadowCenter);
          kl.target.updateMatrixWorld();
          kl.position
            .copy(shadowCenter)
            .addScaledVector(bgView.camRightXZ, 26)
            .addScaledVector(bgView.camForwardXZ, -20);
          kl.position.y += 88;
          kl.updateMatrixWorld();
          kl.shadow.camera.updateProjectionMatrix();
        }
        if (fillLightRef.current) {
          const fl = fillLightRef.current;
          fl.target.position.copy(shadowCenter);
          fl.target.updateMatrixWorld();
          fl.position
            .copy(shadowCenter)
            .addScaledVector(bgView.camRightXZ, -36)
            .addScaledVector(bgView.camForwardXZ, -18);
          fl.position.y += 34;
          fl.updateMatrixWorld();
        }

        setLoadingStage(false);
        setSyncVersion((v) => v + 1);
      })
      .catch((err) => {
        console.error('Failed loading BKGD/CAM view:', err);
        setLoadingStage(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sceneData.bkgdCno, activeCam.icam]);

  // Load & sync real 3DMM Actor rigs & all ACTNs (including multi-frame action switches)
  useEffect(() => {
    let cancelled = false;
    const group = actorsGroupRef.current;
    const existing = actorRigsRef.current;
    const activeIds = new Set(sceneData.actors.map((a) => a.id));

    existing.forEach((rig, id) => {
      if (!activeIds.has(id)) {
        group.remove(rig.root);
        disposeRig(rig.root);
        existing.delete(id);
      }
    });

    Promise.all(
      sceneData.actors.map(async (actor) => {
        let rig = existing.get(actor.id);
        if (rig && rig.template.tmplCno !== actor.tmplCno) {
          group.remove(rig.root);
          disposeRig(rig.root);
          existing.delete(actor.id);
          rig = undefined;
        }
        const costumeKey = JSON.stringify({
          c: actor.costumeCmids || [],
          m: actor.costumeMtrls || [],
        });
        if (!rig) {
          const tmpl = await loadTemplate(actor.tmplCno);
          if (cancelled) return;
          rig = instantiateTemplateRig(tmpl, actor.costumeCmids, actor.costumeMtrls);
          rig.root.userData = {
            id: actor.id,
            type: 'actor',
            tmplCno: actor.tmplCno,
            appliedCostumeKey: costumeKey,
          };
          group.add(rig.root);
          existing.set(actor.id, rig);
        } else if (rig.root.userData.appliedCostumeKey !== costumeKey) {
          rig.root.userData.appliedCostumeKey = costumeKey;
          applyCostumeToRig(rig, actor.costumeCmids || [], actor.costumeMtrls);
        }

        const neededAnids = new Set<number>([actor.anid]);
        if (actor.actionKeyframes) {
          Object.values(actor.actionKeyframes).forEach((k) => neededAnids.add(k.anid));
        }
        await Promise.all(
          Array.from(neededAnids).map(async (anid) => {
            const key = `${actor.id}:${anid}`;
            if (!activeActionsRef.current.has(key)) {
              const act = await loadAction(rig!.template, anid);
              if (!cancelled && act) {
                activeActionsRef.current.set(key, act);
              }
            }
          })
        );
      })
    ).then(() => {
      if (!cancelled) setSyncVersion((v) => v + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [sceneData.actors]);

  // Load & sync real 3DMM Prop rigs & their authentic TMPL ACTNs (Bang!, Grow Fast, Fly, Open & Close, etc.)
  useEffect(() => {
    let cancelled = false;
    const group = propsGroupRef.current;
    const existing = propRigsRef.current;
    const activeIds = new Set(sceneData.props.map((p) => p.id));

    existing.forEach((rig, id) => {
      if (!activeIds.has(id)) {
        group.remove(rig.root);
        disposeRig(rig.root);
        existing.delete(id);
      }
    });

    Promise.all(
      sceneData.props.map(async (prop) => {
        let rig = existing.get(prop.id);
        if (rig && rig.template.tmplCno !== prop.tmplCno) {
          group.remove(rig.root);
          disposeRig(rig.root);
          existing.delete(prop.id);
          rig = undefined;
        }
        const costumeKey = JSON.stringify({
          c: prop.costumeCmids || [],
          m: prop.costumeMtrls || [],
        });
        if (!rig) {
          const tmpl = await loadTemplate(prop.tmplCno);
          if (cancelled) return;
          rig = instantiateTemplateRig(tmpl, prop.costumeCmids, prop.costumeMtrls);
          rig.root.userData = {
            id: prop.id,
            type: 'prop',
            tmplCno: prop.tmplCno,
            appliedCostumeKey: costumeKey,
          };
          group.add(rig.root);
          existing.set(prop.id, rig);
        } else if (rig.root.userData.appliedCostumeKey !== costumeKey) {
          rig.root.userData.appliedCostumeKey = costumeKey;
          applyCostumeToRig(rig, prop.costumeCmids || [], prop.costumeMtrls);
        }

        const tmpl = rig.template;
        const neededAnids = new Set<number>([prop.anid ?? tmpl.actions[0]?.anid ?? 0]);
        const matchByName = (name?: string) => {
          if (!name) return undefined;
          const norm = name.trim().toLowerCase();
          return tmpl.actions.find((a) => a.name.trim().toLowerCase() === norm)?.anid;
        };
        const m0 = matchByName(prop.action);
        if (m0 !== undefined) neededAnids.add(m0);
        if (prop.actionKeyframes) {
          Object.values(prop.actionKeyframes).forEach((k) => {
            if (k.anid !== undefined) neededAnids.add(k.anid);
            const mk = matchByName(k.action);
            if (mk !== undefined) neededAnids.add(mk);
          });
        }

        await Promise.all(
          Array.from(neededAnids).map(async (anid) => {
            const key = `${prop.id}:${anid}`;
            if (!activeActionsRef.current.has(key)) {
              const act = await loadAction(tmpl, anid);
              if (!cancelled && act) {
                activeActionsRef.current.set(key, act);
              }
            }
          })
        );
      })
    ).then(() => {
      if (!cancelled) setSyncVersion((v) => v + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [sceneData.props]);

  // Load & sync real 3DMM TDT 3D Text entities using TDFS.3CN + MTRLS.3CN (rebuilds cleanly when text/font/shape/mtrl edits)
  useEffect(() => {
    let cancelled = false;
    const container = tdtContainerRef.current;
    const existing = tdtGroupsRef.current;
    const tdts = sceneData.tdtTexts || [];
    const activeIds = new Set(tdts.map((t) => t.id));

    existing.forEach((grp, id) => {
      if (!activeIds.has(id)) {
        container.remove(grp);
        existing.delete(id);
      }
    });

    Promise.all(
      tdts.map(async (tdt) => {
        const specKey = `${tdt.text}|${tdt.tdfCno}|${tdt.tdts}|${tdt.mtrlCno ?? ''}`;
        const prev = existing.get(tdt.id);
        if (prev && prev.userData.specKey === specKey) return;
        const grp = await buildTdtTextGroup(tdt.text, tdt.tdfCno, tdt.tdts, tdt.mtrlCno);
        if (cancelled) return;
        if (prev) {
          container.remove(prev);
        }
        grp.userData = {
          id: tdt.id,
          type: 'tdt' as StageEntityType,
          specKey,
          baseColor: grp.userData.baseColor,
        };
        container.add(grp);
        existing.set(tdt.id, grp);
      })
    ).then(() => {
      if (!cancelled) setSyncVersion((v) => v + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [sceneData.tdtTexts]);

  // Evaluate continuous stage pose, blend cels, transforms, 3D text & scrolling 2D text at any subframe
  applyStageAtFrameRef.current = (evalFrame: number) => {
    const curScene = sceneDataRef.current;
    const bgView = bgViewRef.current;

    curScene.actors.forEach((actor) => {
      const rig = actorRigsRef.current.get(actor.id);
      if (!rig) return;

      const resolvedAct = resolveActorActionAtFrame(actor, evalFrame);
      const parsedAction =
        activeActionsRef.current.get(`${actor.id}:${resolvedAct.anid}`) ||
        rig.template.actionCache.get(resolvedAct.anid) ||
        rig.template.actionCache.get(0);

      if (parsedAction) {
        const localCelFrame = resolvedAct.freeze
          ? resolvedAct.celOffset
          : resolvedAct.celOffset + Math.max(0, evalFrame - resolvedAct.startFrame);
        applyActionCelBlendedToRig(rig, parsedAction, localCelFrame);
      }

      const pos = resolveInterpolatedKeyframe(actor.keyframes, evalFrame);
      const sx = pos.scaleX ?? 1;
      const sy = pos.scaleY ?? 1;
      const sz = pos.scaleZ ?? 1;
      applyRigColorOverride(rig, pos.color);

      if (isDraggingRef.current && dragEntityIdRef.current === actor.id) {
        rig.root.visible = true;
        const { x, y, z, rotX, rotY, rotZ } = dragLiveWorldPosRef.current;
        rig.root.position.set(x, y, z);
        rig.root.rotation.set(rotX, rotY, rotZ, 'YXZ');
        rig.root.scale.set(rig.baseScale * sx, rig.baseScale * sy, rig.baseScale * sz);
        if (yellowOutlineBoxRef.current?.visible) {
          yellowOutlineBoxRef.current.position.copy(rig.root.position).add(boxOffsetRef.current);
        }
        return;
      }

      rig.root.visible = pos.visible !== false;
      const worldRotY = storageToWorld(curScene, bgView, pos, _worldPosTmp);
      rig.root.position.copy(_worldPosTmp);
      rig.root.rotation.set(pos.rotX || 0, worldRotY, pos.rotZ || 0, 'YXZ');
      rig.root.scale.set(rig.baseScale * sx, rig.baseScale * sy, rig.baseScale * sz);
    });

    curScene.props.forEach((prop) => {
      const rig = propRigsRef.current.get(prop.id);
      if (!rig) return;

      const resolvedPropAct = resolvePropActionAtFrame(prop, evalFrame);
      const localPropFrame = resolvedPropAct.freeze
        ? resolvedPropAct.celOffset
        : resolvedPropAct.celOffset + Math.max(0, evalFrame - resolvedPropAct.startFrame);

      // Prefer real 3DMM TMPL ACTN (e.g. Explosion "Bang!" / "Grow Fast", Rocket "Fly", Chest "Open and Close")
      const actNorm = resolvedPropAct.action.trim().toLowerCase();
      const matchedActionMeta =
        resolvedPropAct.anid !== undefined
          ? rig.template.actions.find((a) => a.anid === resolvedPropAct.anid)
          : rig.template.actions.find((a) => a.name.trim().toLowerCase() === actNorm);
      const targetAnid = matchedActionMeta?.anid ?? resolvedPropAct.anid ?? 0;
      const parsedPropActn =
        activeActionsRef.current.get(`${prop.id}:${targetAnid}`) ||
        rig.template.actionCache.get(targetAnid) ||
        rig.template.actionCache.get(0);

      const pos = resolveInterpolatedKeyframe(prop.keyframes, evalFrame);
      const sx = pos.scaleX ?? 1;
      const sy = pos.scaleY ?? 1;
      const sz = pos.scaleZ ?? 1;
      applyRigColorOverride(rig, pos.color);

      if (parsedPropActn) {
        applyActionCelBlendedToRig(rig, parsedPropActn, localPropFrame);
      }

      if (isDraggingRef.current && dragEntityIdRef.current === prop.id) {
        rig.root.visible = true;
        const { x, y, z, rotX, rotY, rotZ } = dragLiveWorldPosRef.current;
        rig.root.position.set(x, y, z);
        if (parsedPropActn) {
          rig.root.rotation.set(rotX, rotY, rotZ, 'YXZ');
          rig.root.scale.set(rig.baseScale * sx, rig.baseScale * sy, rig.baseScale * sz);
        } else {
          applyPropActionTransform(
            rig.root,
            resolvedPropAct.action,
            localPropFrame,
            curScene.totalFrames,
            rig.baseScale,
            rotY,
            rotX,
            rotZ
          );
          rig.root.scale.set(rig.root.scale.x * sx, rig.root.scale.y * sy, rig.root.scale.z * sz);
        }
        if (yellowOutlineBoxRef.current?.visible) {
          yellowOutlineBoxRef.current.position.copy(rig.root.position).add(boxOffsetRef.current);
        }
        return;
      }

      rig.root.visible = pos.visible !== false;
      const worldRotY = storageToWorld(curScene, bgView, pos, _worldPosTmp);
      rig.root.position.copy(_worldPosTmp);
      if (parsedPropActn) {
        rig.root.rotation.set(pos.rotX || 0, worldRotY, pos.rotZ || 0, 'YXZ');
        rig.root.scale.set(rig.baseScale * sx, rig.baseScale * sy, rig.baseScale * sz);
      } else {
        applyPropActionTransform(
          rig.root,
          resolvedPropAct.action,
          localPropFrame,
          curScene.totalFrames,
          rig.baseScale,
          worldRotY,
          pos.rotX || 0,
          pos.rotZ || 0
        );
        rig.root.scale.set(rig.root.scale.x * sx, rig.root.scale.y * sy, rig.root.scale.z * sz);
      }
    });

    (curScene.tdtTexts || []).forEach((tdt) => {
      const grp = tdtGroupsRef.current.get(tdt.id);
      if (!grp) return;
      const baseHex = (grp.userData.baseColor as string) || '#f59e0b';
      const pos = resolveInterpolatedKeyframe(tdt.keyframes, evalFrame, baseHex);
      applyGroupColorOverride(grp, pos.color);

      if (isDraggingRef.current && dragEntityIdRef.current === tdt.id) {
        grp.visible = true;
        const { x, y, z, rotX, rotY, rotZ } = dragLiveWorldPosRef.current;
        grp.position.set(x, y, z);
        grp.rotation.set(rotX, rotY, rotZ, 'YXZ');
        grp.scale.set(pos.scaleX ?? 1, pos.scaleY ?? 1, pos.scaleZ ?? 1);
        if (yellowOutlineBoxRef.current?.visible) {
          yellowOutlineBoxRef.current.position.copy(grp.position).add(boxOffsetRef.current);
        }
        return;
      }

      grp.visible = pos.visible !== false;
      const worldRotY = storageToWorld(curScene, bgView, pos, _worldPosTmp);
      grp.position.copy(_worldPosTmp);
      grp.rotation.set(pos.rotX || 0, worldRotY, pos.rotZ || 0, 'YXZ');
      grp.scale.set(pos.scaleX ?? 1, pos.scaleY ?? 1, pos.scaleZ ?? 1);
    });

    // Update scrolling 2D text boxes smoothly in-place at full refresh rate
    (curScene.textBoxes || []).forEach((tb) => {
      if (!tb.isScrolling) return;
      const el = textBoxInnerRefs.current.get(tb.id);
      if (!el) return;
      const spanFrames = Math.max(1, tb.endFrame - tb.startFrame);
      const scrollProgress = Math.max(0, Math.min(1, (evalFrame - tb.startFrame) / spanFrames));
      el.style.transform = `translateY(${(0.18 - scrollProgress * 0.95) * 100}%)`;
    });
  };

  // Sync stage on discrete/edit changes while honoring active live rAF playhead during playback
  useEffect(() => {
    const live = livePlayheadPropRef.current?.current;
    const evalFrame =
      isPlaying && live && live.sceneIndex === sceneIndex
        ? live.renderFrame
        : (renderFrame ?? currentFrame);
    applyStageAtFrameRef.current(evalFrame);
  }, [currentFrame, renderFrame, isPlaying, sceneIndex, sceneData, syncVersion]);

  // Update trail dots around selected actor/prop/3D text only on integer frame / selection / keyframe changes
  useEffect(() => {
    const bgView = bgViewRef.current;
    const trailGroup = trailDotsGroupRef.current;
    while (trailGroup.children.length > 0) {
      trailGroup.remove(trailGroup.children[0]);
    }

    if (
      selectedEntityId &&
      sharedDotGeoRef.current &&
      sharedDotMatRef.current &&
      sharedCurDotMatRef.current
    ) {
      const selActor = sceneData.actors.find((a) => a.id === selectedEntityId);
      const selProp = sceneData.props.find((p) => p.id === selectedEntityId);
      const selTdt = (sceneData.tdtTexts || []).find((t) => t.id === selectedEntityId);
      const kfs = selActor?.keyframes || selProp?.keyframes || selTdt?.keyframes;
      if (kfs) {
        const sortedEntries = Object.entries(kfs).sort(([a], [b]) => Number(a) - Number(b));
        const step = sortedEntries.length > 45 ? 2 : 1;
        for (let idx = 0; idx < sortedEntries.length; idx += step) {
          const [fStr, kf] = sortedEntries[idx];
          const f = Number(fStr);
          const dot = new THREE.Mesh(
            sharedDotGeoRef.current!,
            f === currentFrame ? sharedCurDotMatRef.current! : sharedDotMatRef.current!
          );
          storageToWorld(sceneData, bgView, kf, _worldPosTmp);
          dot.position.set(_worldPosTmp.x, _worldPosTmp.y + 0.15, _worldPosTmp.z);
          trailGroup.add(dot);
        }
      }
    }
  }, [currentFrame, sceneData, selectedEntityId, syncVersion]);

  // Pointer Down: pick actor/prop (3D mesh raycast + mobile touch proximity) & show yellow outline rectangle
  const handlePointerDown = (e: React.PointerEvent) => {
    const mount = mountRef.current;
    const camera = cameraRef.current;
    if (!mount || !camera) return;

    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Ignore if unsupported
    }

    const rect = mount.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const ndcX = (localX / rect.width) * 2 - 1;
    const ndcY = -(localY / rect.height) * 2 + 1;

    camera.updateMatrixWorld();
    mousePosRef.current.set(ndcX, ndcY);
    raycasterRef.current.setFromCamera(mousePosRef.current, camera);

    const pickables: THREE.Object3D[] = [];
    actorRigsRef.current.forEach((rig) => pickables.push(rig.root));
    propRigsRef.current.forEach((rig) => pickables.push(rig.root));
    tdtGroupsRef.current.forEach((grp) => pickables.push(grp));

    const intersects = raycasterRef.current.intersectObjects(pickables, true);
    let clickedId: string | null = null;
    let clickedType: StageEntityType | null = null;

    if (intersects.length > 0) {
      let top: THREE.Object3D | null = intersects[0].object;
      while (top && !top.userData?.id && top.parent) {
        top = top.parent;
      }
      if (top?.userData?.id) {
        clickedId = top.userData.id;
        clickedType = top.userData.type as StageEntityType;
        onSelectEntity(clickedId, clickedType);
        selectedEntityIdRef.current = clickedId;
      }
    }

    if (!clickedId) {
      let closestId: string | null = null;
      let closestType: StageEntityType | null = null;
      let bestPx = 56;

      const checkTouch = (id: string, type: StageEntityType, root: THREE.Object3D, approxH: number) => {
        _screenPtA.set(root.position.x, root.position.y + 0.5, root.position.z).project(camera);
        _screenPtB.set(root.position.x, root.position.y + approxH, root.position.z).project(camera);
        if (_screenPtA.z > 1 || _screenPtB.z > 1) return;
        const ax = (_screenPtA.x + 1) * 0.5 * rect.width;
        const ay = (-_screenPtA.y + 1) * 0.5 * rect.height;
        const bx = (_screenPtB.x + 1) * 0.5 * rect.width;
        const by = (-_screenPtB.y + 1) * 0.5 * rect.height;
        const d = distToSegment2D(localX, localY, ax, ay, bx, by);
        if (d < bestPx) {
          bestPx = d;
          closestId = id;
          closestType = type;
        }
      };

      actorRigsRef.current.forEach((rig, id) => checkTouch(id, 'actor', rig.root, 8.0));
      propRigsRef.current.forEach((rig, id) => checkTouch(id, 'prop', rig.root, 5.0));
      tdtGroupsRef.current.forEach((grp, id) => checkTouch(id, 'tdt', grp, 4.0));

      if (closestId && closestType) {
        clickedId = closestId;
        clickedType = closestType;
        onSelectEntity(clickedId, clickedType);
        selectedEntityIdRef.current = clickedId;
      }
    }

    const targetId = clickedId || selectedEntityIdRef.current;
    if (!targetId) return;

    const isActor = sceneDataRef.current.actors.some((a) => a.id === targetId);
    const isProp = sceneDataRef.current.props.some((p) => p.id === targetId);
    const isTdt = (sceneDataRef.current.tdtTexts || []).some((t) => t.id === targetId);
    if (!isActor && !isProp && !isTdt) return;

    const targetType: StageEntityType = isActor ? 'actor' : isProp ? 'prop' : 'tdt';
    const targetObj: THREE.Object3D | undefined =
      actorRigsRef.current.get(targetId)?.root ||
      propRigsRef.current.get(targetId)?.root ||
      tdtGroupsRef.current.get(targetId);
    if (!targetObj) return;

    stopRecordingTimer();
    isDraggingRef.current = true;
    hasStartedDragMoveRef.current = false;
    dragEntityIdRef.current = targetId;
    dragEntityTypeRef.current = targetType;
    pointerDownClientRef.current = { x: e.clientX, y: e.clientY };
    lastPointerClientRef.current = { x: e.clientX, y: e.clientY };

    const worldStart = {
      x: targetObj.position.x,
      y: targetObj.position.y,
      z: targetObj.position.z,
      rotX: targetObj.rotation.x,
      rotY: targetObj.rotation.y,
      rotZ: targetObj.rotation.z,
    };
    const startStorage = worldToStorage(
      sceneDataRef.current,
      bgViewRef.current,
      worldStart.x,
      worldStart.y,
      worldStart.z,
      worldStart.rotY,
      worldStart.rotX,
      worldStart.rotZ
    );

    dragStartWorldPosRef.current = { ...worldStart };
    dragLiveWorldPosRef.current = { ...worldStart };
    prevStoragePosRef.current = { x: startStorage.x, y: startStorage.y, z: startStorage.z };
    lastHeadingPosRef.current = { x: worldStart.x, z: worldStart.z };
    recordingFrameRef.current = currentFrameRef.current;

    _dragBox.setFromObject(targetObj);
    _dragBox.getSize(_dragSize);
    _dragSize.x = Math.max(2.5, _dragSize.x) + 0.6;
    _dragSize.y = Math.max(3.0, _dragSize.y) + 0.6;
    _dragSize.z = Math.max(2.5, _dragSize.z) + 0.6;

    _dragBox.getCenter(_dragCenter);
    boxOffsetRef.current.copy(_dragCenter).sub(targetObj.position);

    if (yellowOutlineBoxRef.current) {
      yellowOutlineBoxRef.current.geometry.dispose();
      const tmpBoxGeo = new THREE.BoxGeometry(_dragSize.x, _dragSize.y, _dragSize.z);
      yellowOutlineBoxRef.current.geometry = new THREE.EdgesGeometry(tmpBoxGeo);
      tmpBoxGeo.dispose();
      yellowOutlineBoxRef.current.position.copy(targetObj.position).add(boxOffsetRef.current);
      yellowOutlineBoxRef.current.visible = true;
    }
  };

  // Pointer Move: Ground XZ drag OR Up & Down XY drag OR 3D Rotate (X/Y/Z) + 6 FPS recording
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current || !dragEntityIdRef.current) return;
    e.preventDefault();

    const mount = mountRef.current;
    const camera = cameraRef.current;
    if (!mount || !camera) return;

    const rect = mount.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (!hasStartedDragMoveRef.current) {
      const distPx = Math.hypot(
        e.clientX - pointerDownClientRef.current.x,
        e.clientY - pointerDownClientRef.current.y
      );
      if (distPx < 2) return;
    }

    const ddxPx = e.clientX - lastPointerClientRef.current.x;
    const ddyPx = e.clientY - lastPointerClientRef.current.y;
    lastPointerClientRef.current = { x: e.clientX, y: e.clientY };

    if (ddxPx === 0 && ddyPx === 0 && hasStartedDragMoveRef.current) return;

    const entityId = dragEntityIdRef.current;
    const type = dragEntityTypeRef.current || 'actor';
    const targetObj: THREE.Object3D | undefined =
      actorRigsRef.current.get(entityId)?.root ||
      propRigsRef.current.get(entityId)?.root ||
      tdtGroupsRef.current.get(entityId);
    if (!targetObj) return;

    camera.updateMatrixWorld();
    _camRightXZ.setFromMatrixColumn(camera.matrixWorld, 0);
    _camRightXZ.y = 0;
    if (_camRightXZ.lengthSq() < 1e-6) _camRightXZ.set(1, 0, 0);
    else _camRightXZ.normalize();

    _camForwardXZ.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _camForwardXZ.y = 0;
    if (_camForwardXZ.lengthSq() < 1e-6) _camForwardXZ.set(0, 0, -1);
    else _camForwardXZ.normalize();

    const prevWorld = dragLiveWorldPosRef.current;
    const dist = Math.max(
      12,
      Math.hypot(
        camera.position.x - prevWorld.x,
        camera.position.y - prevWorld.y,
        camera.position.z - prevWorld.z
      )
    );
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const visHeight = 2 * dist * Math.tan(fovRad * 0.5);
    const visWidth = visHeight * camera.aspect;

    let targetX = prevWorld.x;
    let targetY = prevWorld.y;
    let targetZ = prevWorld.z;
    let rotX = prevWorld.rotX;
    let rotY = prevWorld.rotY;
    let rotZ = prevWorld.rotZ;

    if (rotateModeRef.current) {
      // 3D Rotate Mode: horizontal rotates Y (turn Left/Right), vertical tilts X (pitch), Shift+drag rolls Z
      if (e.shiftKey) {
        rotZ = prevWorld.rotZ - ddxPx * 0.018;
      } else {
        rotY = prevWorld.rotY + ddxPx * 0.018;
        rotX = prevWorld.rotX + ddyPx * 0.018;
      }
    } else if (moveUpDownModeRef.current) {
      // Up & Down Mode: ONLY moves Up/Down (Y) + Left/Right (camRightXZ), NEVER Forward/Backwards!
      const moveRight = (ddxPx / rect.width) * visWidth * 0.88;
      const moveUp = (-ddyPx / rect.height) * visHeight * 0.88;
      targetX = prevWorld.x + _camRightXZ.x * moveRight;
      targetZ = prevWorld.z + _camRightXZ.z * moveRight;
      targetY = prevWorld.y + moveUp;
    } else {
      const moveRight = (ddxPx / rect.width) * visWidth * 0.72;
      const moveFwd = (-ddyPx / rect.height) * Math.max(24, dist * 0.9);
      targetX = prevWorld.x + _camRightXZ.x * moveRight + _camForwardXZ.x * moveFwd;
      targetZ = prevWorld.z + _camRightXZ.z * moveRight + _camForwardXZ.z * moveFwd;
    }

    // Auto-orient heading during recorded ground movement (not in Rotate or Up/Down mode)
    if (
      type === 'actor' &&
      isRecordingMovementRef.current &&
      !moveUpDownModeRef.current &&
      !rotateModeRef.current
    ) {
      const hdx = targetX - lastHeadingPosRef.current.x;
      const hdz = targetZ - lastHeadingPosRef.current.z;
      if (Math.hypot(hdx, hdz) > 0.22) {
        const targetHeading = Math.atan2(hdx, hdz);
        rotY = lerpShortestAngle(prevWorld.rotY, targetHeading, 0.72);
        lastHeadingPosRef.current = { x: targetX, z: targetZ };
      }
    }

    const nextWorld = { x: targetX, y: targetY, z: targetZ, rotX, rotY, rotZ };
    dragLiveWorldPosRef.current = nextWorld;
    targetObj.position.set(targetX, targetY, targetZ);
    targetObj.rotation.set(rotX, rotY, rotZ, 'YXZ');

    if (yellowOutlineBoxRef.current?.visible) {
      yellowOutlineBoxRef.current.position.copy(targetObj.position).add(boxOffsetRef.current);
    }

    const nextStorage = worldToStorage(
      sceneDataRef.current,
      bgViewRef.current,
      targetX,
      targetY,
      targetZ,
      rotY,
      rotX,
      rotZ
    );
    const stepDeltaX = nextStorage.x - prevStoragePosRef.current.x;
    const stepDeltaY = nextStorage.y - prevStoragePosRef.current.y;
    const stepDeltaZ = nextStorage.z - prevStoragePosRef.current.z;
    prevStoragePosRef.current = { x: nextStorage.x, y: nextStorage.y, z: nextStorage.z };

    if (!hasStartedDragMoveRef.current) {
      hasStartedDragMoveRef.current = true;
      void sound3DMM.playUiWav('MOVE.WAV');

      if (isRecordingMovementRef.current) {
        const startFrame = recordingFrameRef.current;
        const startStorage = worldToStorage(
          sceneDataRef.current,
          bgViewRef.current,
          dragStartWorldPosRef.current.x,
          dragStartWorldPosRef.current.y,
          dragStartWorldPosRef.current.z,
          dragStartWorldPosRef.current.rotY,
          dragStartWorldPosRef.current.rotX,
          dragStartWorldPosRef.current.rotZ
        );
        onBeginRecordingRef.current(entityId, type, startFrame, startStorage);

        const firstNext = startFrame + 1;
        recordingFrameRef.current = firstNext;
        currentFrameRef.current = firstNext;
        onRecordMovementStepRef.current(entityId, type, firstNext, nextStorage, true);

        stopRecordingTimer();
        recordingIntervalRef.current = window.setInterval(() => {
          if (
            !isDraggingRef.current ||
            !isRecordingMovementRef.current ||
            !dragEntityIdRef.current
          ) {
            stopRecordingTimer();
            return;
          }
          const nf = recordingFrameRef.current + 1;
          recordingFrameRef.current = nf;
          currentFrameRef.current = nf;
          const curLive = dragLiveWorldPosRef.current;
          const liveStorage = worldToStorage(
            sceneDataRef.current,
            bgViewRef.current,
            curLive.x,
            curLive.y,
            curLive.z,
            curLive.rotY,
            curLive.rotX,
            curLive.rotZ
          );
          onRecordMovementStepRef.current(
            dragEntityIdRef.current,
            dragEntityTypeRef.current || 'actor',
            nf,
            liveStorage,
            true
          );
        }, 1000 / 6); // Authentic 6 FPS motion/rotation recording
      } else {
        onMoveEntityAtFrameRef.current(
          entityId,
          type,
          currentFrameRef.current,
          nextStorage,
          stepDeltaX,
          stepDeltaY,
          stepDeltaZ
        );
      }
      return;
    }

    if (isRecordingMovementRef.current) {
      onRecordMovementStepRef.current(
        entityId,
        type,
        recordingFrameRef.current,
        nextStorage,
        false
      );
    } else {
      onMoveEntityAtFrameRef.current(
        entityId,
        type,
        currentFrameRef.current,
        nextStorage,
        stepDeltaX,
        stepDeltaY,
        stepDeltaZ
      );
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    stopRecordingTimer();

    if (
      isDraggingRef.current &&
      hasStartedDragMoveRef.current &&
      isRecordingMovementRef.current &&
      dragEntityIdRef.current
    ) {
      const curLive = dragLiveWorldPosRef.current;
      const liveStorage = worldToStorage(
        sceneDataRef.current,
        bgViewRef.current,
        curLive.x,
        curLive.y,
        curLive.z,
        curLive.rotY,
        curLive.rotX,
        curLive.rotZ
      );
      onRecordMovementStepRef.current(
        dragEntityIdRef.current,
        dragEntityTypeRef.current || 'actor',
        recordingFrameRef.current,
        liveStorage,
        true
      );
    }

    isDraggingRef.current = false;
    hasStartedDragMoveRef.current = false;
    dragEntityIdRef.current = null;
    dragEntityTypeRef.current = null;

    if (yellowOutlineBoxRef.current) {
      yellowOutlineBoxRef.current.visible = false;
    }

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const scrollEvalFrame = renderFrame ?? currentFrame;
  const activeTextBoxes = (sceneData.textBoxes || []).filter(
    (tb) => scrollEvalFrame >= tb.startFrame && scrollEvalFrame <= tb.endFrame
  );

  return (
    <div
      ref={wellRef}
      className="relative w-full h-full flex items-center justify-center studio-stage-well overflow-hidden select-none touch-none p-2"
    >
      {/* Authentic 544x306 3DMM Stage Frame (exact locked aspect ratio so MBMP/ZBMP/WebGL match on every angle) */}
      <div
        className="relative bg-black studio-bevel-frame overflow-hidden shrink-0"
        style={{
          width: `${stageBoxSize.w}px`,
          height: `${stageBoxSize.h}px`,
          containerType: 'inline-size',
        }}
      >
        {/* Real Pre-rendered 544x306 MBMP Stage Backdrop */}
        {backdropUrl && (
          <img
            src={backdropUrl}
            alt={sceneData.sceneName}
            draggable={false}
            className="absolute inset-0 w-full h-full object-fill pointer-events-none select-none image-rendering-pixelated"
          />
        )}

        {/* Smooth-Shaded WebGL Layer + ZBMP Depth Occlusion + ZBMP Floor Shadow + TDT 3D Text */}
        <div
          ref={mountRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`absolute inset-0 w-full h-full touch-none ${
            isRecordingMovement
              ? 'cursor-crosshair'
              : rotateMode
                ? 'cursor-ew-resize'
                : moveUpDownMode
                  ? 'cursor-ns-resize'
                  : 'cursor-grab active:cursor-grabbing'
          }`}
        />

        {/* Authentic 2D On-Screen Text Boxes (Scrolling Credits & Static Captions from TBOX/RTXT/TEXT) */}
        {activeTextBoxes.map((tb) => {
          const leftPct = Math.max(0, Math.min(100, (tb.left / 544) * 100));
          const topPct = Math.max(0, Math.min(100, (tb.top / 306) * 100));
          const widthPct = Math.max(1, Math.min(100 - leftPct, ((tb.right - tb.left) / 544) * 100));
          const heightPct = Math.max(1, Math.min(100 - topPct, ((tb.bottom - tb.top) / 306) * 100));
          const spanFrames = Math.max(1, tb.endFrame - tb.startFrame);
          const scrollProgress = Math.max(0, Math.min(1, (scrollEvalFrame - tb.startFrame) / spanFrames));
          const fontSizeCqw = (((tb.fontSize ?? 14) * 1.18) / 544) * 100;
          const textColor = tb.color || '#f9f9f9';

          return (
            <div
              key={tb.id}
              className="absolute pointer-events-none overflow-hidden select-none"
              style={{
                left: `${leftPct}%`,
                top: `${topPct}%`,
                width: `${widthPct}%`,
                height: `${heightPct}%`,
                backgroundColor: tb.bgColor || 'transparent',
                padding: tb.bgColor ? '0.6cqw 1cqw' : undefined,
                fontFamily: `"${tb.fontName || 'Comic Sans MS'}", "Comic Sans MS", cursive, sans-serif`,
                fontSize: `${fontSizeCqw.toFixed(2)}cqw`,
                fontWeight: tb.bold ? 700 : 400,
                fontStyle: tb.italic ? 'italic' : 'normal',
                lineHeight: 1.24,
                color: textColor,
                textShadow: tb.bgColor
                  ? undefined
                  : '1px 1px 2px rgba(0,0,0,0.92), -1px -1px 1px rgba(0,0,0,0.6)',
              }}
            >
              <div
                ref={(el) => {
                  if (el) textBoxInnerRefs.current.set(tb.id, el);
                  else textBoxInnerRefs.current.delete(tb.id);
                }}
                className="whitespace-pre-wrap break-words"
                style={
                  tb.isScrolling
                    ? { transform: `translateY(${(0.18 - scrollProgress * 0.95) * 100}%)` }
                    : undefined
                }
              >
                {tb.text}
              </div>
            </div>
          );
        })}

        {loadingStage && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-amber-300 font-bold text-sm pointer-events-none">
            Loading 3DMM Stage "{sceneData.sceneName}"...
          </div>
        )}

        {webglError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/75 p-4 text-center text-xs text-rose-200 pointer-events-none">
            <div className="studio-panel px-3 py-2 max-w-sm">
              WebGL unavailable: {webglError}
            </div>
          </div>
        )}

        {isRecordingMovement && (
          <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-amber-400 text-slate-950 font-bold px-3 py-1 border-2 border-black shadow-lg flex items-center gap-2 pointer-events-none text-xs">
            <img src={assetUrl('3dmm/bmp/2RECDS.BMP')} alt="" className="w-4 h-4 image-rendering-pixelated" />
            <span>RECORDING (6 FPS): Drag entity to {rotateMode ? 'rotate' : 'move'}</span>
          </div>
        )}

        {/* Stage Info Badges, Rotate 3D & Up/Down Drag Toggles */}
        <div className="absolute top-1.5 left-1.5 right-1.5 flex flex-wrap justify-between items-start pointer-events-none text-[10px] sm:text-[11px] font-bold gap-1">
          <span className="bg-[#1b0e36]/85 text-amber-200 px-1.5 sm:px-2 py-0.5 border border-[#8e63d6] truncate max-w-full">
            Scene {sceneIndex + 1}/{totalScenes}: {sceneData.sceneName} (View{' '}
            {activeViewNumber ?? activeCam.icam + 1})
          </span>
          <div className="flex flex-wrap items-center gap-1 pointer-events-auto max-w-full">
            <button
              type="button"
              onClick={() => {
                void sound3DMM.playUiWav('DROPDN.WAV');
                onToggleRotateMode();
              }}
              title="Rotate Mode: Drag Left/Right turns Y, Up/Down tilts X, Shift+Drag rolls Z"
              className={`px-1.5 sm:px-2 py-0.5 border font-bold flex items-center gap-1 shadow ${
                rotateMode
                  ? 'bg-emerald-400 text-slate-950 border-white'
                  : 'bg-[#1b0e36]/90 text-purple-100 border-[#8e63d6] hover:brightness-125'
              }`}
            >
              <img
                src={assetUrl('3dmm/bmp/2ROT.BMP')}
                alt=""
                className="h-3.5 w-auto object-contain image-rendering-pixelated"
              />
              <span>{rotateMode ? 'Rotate: ON' : 'Rotate'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                void sound3DMM.playUiWav('DROPDN.WAV');
                onToggleMoveUpDown();
              }}
              title="Toggle Up & Down drag mode (also use Up/Down arrow keys anytime)"
              className={`px-1.5 sm:px-2 py-0.5 border font-bold flex items-center gap-1 shadow ${
                moveUpDownMode
                  ? 'bg-amber-400 text-slate-950 border-white'
                  : 'bg-[#1b0e36]/90 text-cyan-200 border-[#8e63d6] hover:brightness-125'
              }`}
            >
              <img
                src={assetUrl(moveUpDownMode ? '3dmm/bmp/2XY.BMP' : '3dmm/bmp/2XZ.BMP')}
                alt=""
                className="h-3.5 w-auto object-contain image-rendering-pixelated"
              />
              <span>
                {moveUpDownMode ? 'Up/Down: ON' : 'Up/Down: OFF'}
                <span className="hidden sm:inline">
                  {moveUpDownMode ? ' (L/R + U/D)' : ''}
                </span>
              </span>
            </button>
            <span className="bg-[#1b0e36]/85 text-cyan-200 px-1.5 sm:px-2 py-0.5 border border-[#8e63d6] pointer-events-none">
              f{currentFrame}/{sceneData.totalFrames}
              <span className="hidden sm:inline"> (24 FPS)</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

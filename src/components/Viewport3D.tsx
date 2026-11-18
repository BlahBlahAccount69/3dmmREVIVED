import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { KeyframePosition, PropAction, Scene } from '../types/movie';
import {
  applyActionCelToRig,
  applyCostumeToRig,
  applyPropActionTransform,
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

interface Viewport3DProps {
  sceneData: Scene;
  sceneIndex?: number;
  totalScenes?: number;
  currentFrame: number;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null, type: 'actor' | 'prop' | null) => void;
  onStageViewReady?: (view: LoadedBackgroundView) => void;
  isRecordingMovement: boolean;
  onBeginRecordingAtFrame: (
    entityId: string,
    type: 'actor' | 'prop',
    startFrame: number,
    pos: { x: number; y: number; z: number; rotY: number }
  ) => void;
  onRecordMovementStep: (
    entityId: string,
    type: 'actor' | 'prop',
    frame: number,
    pos: { x: number; y: number; z: number; rotY: number },
    advancePlayhead: boolean
  ) => void;
  onMoveEntityAtFrame: (
    entityId: string,
    type: 'actor' | 'prop',
    frame: number,
    pos: { x: number; y: number; z: number; rotY: number },
    deltaX: number,
    deltaZ: number
  ) => void;
}

// Reusable scratchpads (zero per-frame allocations)
const _camRightXZ = new THREE.Vector3();
const _camForwardXZ = new THREE.Vector3();
const _worldPosTmp = new THREE.Vector3();
const _screenPtA = new THREE.Vector3();
const _screenPtB = new THREE.Vector3();
const _eulerTrim = new THREE.Euler(0, 0, 0, 'YXZ');
const _quatTrim = new THREE.Quaternion();
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
  kf: { x: number; y: number; z: number; rotY?: number },
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
  worldRotY: number
): KeyframePosition {
  if (sceneData.coordMode === 'world' || !bgView) {
    return { x: wx, y: wy, z: wz, rotY: worldRotY };
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
): { action: PropAction; startFrame: number; celOffset: number; freeze: boolean } {
  const akfs = prop.actionKeyframes;
  if (!akfs) {
    return { action: prop.action, startFrame: 0, celOffset: 0, freeze: false };
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
      startFrame: chosenFrame,
      celOffset: akfs[chosenFrame].celOffset ?? 0,
      freeze: Boolean(akfs[chosenFrame].freeze),
    };
  }
  return { action: prop.action, startFrame: 0, celOffset: 0, freeze: false };
}

function catmullRomScalar(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
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

/**
 * Resolves entity transform at frame with smooth & curved interpolation
 * for small/close movements (<= 22 units), and no interpolation (snap)
 * for farther/bigger movements (> 22 units).
 */
export function resolveInterpolatedKeyframe(
  keyframes: Record<number, KeyframePosition>,
  frame: number
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

  // Hidden segments or larger/farther movements snap cleanly with no interpolation
  const dist = dist3D(p1, p2);
  if (p1.visible === false || p2.visible === false || dist > INTERP_JUMP_THRESHOLD) {
    return p1;
  }

  const rawT = (frame - f1) / Math.max(1, f2 - f1);
  // Smooth ease-in-out timing curve
  const t = rawT * rawT * (3 - 2 * rawT);

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

  let x = catmullRomScalar(p0.x, p1.x, p2.x, p3.x, t);
  const y = catmullRomScalar(p0.y, p1.y, p2.y, p3.y, t);
  let z = catmullRomScalar(p0.z, p1.z, p2.z, p3.z, t);

  // Add subtle natural curved arc on 2-keyframe or nearly collinear segments
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const chordXZ = Math.hypot(dx, dz);
  if (chordXZ > 0.15) {
    const linX = p1.x + dx * t;
    const linZ = p1.z + dz * t;
    const existingBend = Math.hypot(x - linX, z - linZ);
    if (existingBend < chordXZ * 0.04) {
      const perpX = -dz / chordXZ;
      const perpZ = dx / chordXZ;
      const arcAmt = Math.sin(Math.PI * rawT) * Math.min(chordXZ * 0.16, 1.8);
      x += perpX * arcAmt;
      z += perpZ * arcAmt;
    }
  }

  const s1x = p1.scaleX ?? 1;
  const s1y = p1.scaleY ?? 1;
  const s1z = p1.scaleZ ?? 1;
  const s2x = p2.scaleX ?? 1;
  const s2y = p2.scaleY ?? 1;
  const s2z = p2.scaleZ ?? 1;

  return {
    x,
    y,
    z,
    rotY: lerpShortestAngle(p1.rotY || 0, p2.rotY || 0, t),
    scaleX: s1x + (s2x - s1x) * t,
    scaleY: s1y + (s2y - s1y) * t,
    scaleZ: s1z + (s2z - s1z) * t,
    visible: p1.visible,
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
  currentFrame,
  selectedEntityId,
  onSelectEntity,
  onStageViewReady,
  isRecordingMovement,
  onBeginRecordingAtFrame,
  onRecordMovementStep,
  onMoveEntityAtFrame,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [backdropUrl, setBackdropUrl] = useState<string | null>(null);
  const [loadingStage, setLoadingStage] = useState<boolean>(true);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const depthPrePassMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const depthPrePassMeshRef = useRef<THREE.Mesh | null>(null);

  const bgViewRef = useRef<LoadedBackgroundView | null>(null);
  const actorRigsRef = useRef<Map<string, TemplateRig>>(new Map());
  const propRigsRef = useRef<Map<string, TemplateRig>>(new Map());
  const tdtGroupsRef = useRef<Map<string, THREE.Group>>(new Map());
  const activeActionsRef = useRef<Map<string, ParsedAction>>(new Map());

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
  const dragEntityTypeRef = useRef<'actor' | 'prop' | null>(null);
  const pointerDownClientRef = useRef({ x: 0, y: 0 });
  const lastPointerClientRef = useRef({ x: 0, y: 0 });
  const dragStartWorldPosRef = useRef({ x: 0, y: 0, z: 0, rotY: 0 });
  const dragLiveWorldPosRef = useRef({ x: 0, y: 0, z: 0, rotY: 0 });
  const prevStoragePosRef = useRef({ x: 0, z: 0 });
  const lastHeadingPosRef = useRef({ x: 0, z: 0 });
  const recordingFrameRef = useRef(0);
  const recordingIntervalRef = useRef<number | null>(null);
  const boxOffsetRef = useRef(new THREE.Vector3());
  const raycasterRef = useRef(new THREE.Raycaster());
  const mousePosRef = useRef(new THREE.Vector2());

  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;
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

  const activeCam = resolveActiveCameraAtFrame(sceneData, currentFrame);

  const stopRecordingTimer = () => {
    if (recordingIntervalRef.current !== null) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  };

  // Initialize transparent WebGL canvas + ZBMP depth-prepass shader over decoded 544x306 MBMP backdrop
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

    // Official 3DMM 544x306 camera frustum
    const camera = new THREE.PerspectiveCamera(47, width / height, 1.0, 5000);
    camera.position.set(0, 12, 60);
    camera.lookAt(0, 4, 0);
    camera.updateMatrixWorld();
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

    // 3DMM Studio Lighting Rig (smooth Gouraud illumination)
    const hemi = new THREE.HemisphereLight('#ffffff', '#334155', 1.45);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight('#fffbeb', 1.65);
    keyLight.position.set(30, 80, 40);
    keyLight.castShadow = !isSoftwareGl;
    if (keyLight.castShadow) {
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 250;
      keyLight.shadow.camera.left = -45;
      keyLight.shadow.camera.right = 45;
      keyLight.shadow.camera.top = 45;
      keyLight.shadow.camera.bottom = -45;
    }
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight('#dbeafe', 0.85);
    fillLight.position.set(-40, 30, -25);
    scene.add(fillLight);

    // Shadow catcher ground plane under actors (does not clobber ZBMP depth buffer)
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

    // Yellow wireframe rectangle outline shown strictly while dragging
    const yellowBoxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2));
    const yellowBoxMat = new THREE.LineBasicMaterial({
      color: 0xffff00,
      depthTest: false,
      transparent: true,
      opacity: 0.96,
    });
    const yellowOutlineBox = new THREE.LineSegments(yellowBoxGeo, yellowBoxMat);
    yellowOutlineBox.renderOrder = 999;
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
      cameraRef.current.aspect = w / h;
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
          cam.near = bgView.hither;
          cam.far = bgView.yon;
          cam.updateProjectionMatrix();

          cam.position.copy(bgView.camPosition);
          _eulerTrim.set(
            THREE.MathUtils.degToRad(activeCam.pitch),
            THREE.MathUtils.degToRad(activeCam.yaw),
            0
          );
          _quatTrim.setFromEuler(_eulerTrim);
          cam.quaternion.copy(bgView.camQuaternion).multiply(_quatTrim);
          cam.updateMatrixWorld();
        }

        if (depthPrePassMatRef.current && depthPrePassMeshRef.current) {
          const untrimmed = Math.abs(activeCam.yaw) < 0.5 && Math.abs(activeCam.pitch) < 0.5;
          depthPrePassMatRef.current.uniforms.uZbmp.value = bgView.zbmpDepthTexture;
          depthPrePassMeshRef.current.visible = Boolean(bgView.zbmpDepthTexture) && untrimmed;
        }

        if (shadowPlaneRef.current) {
          shadowPlaneRef.current.position.copy(bgView.stageOrigin);
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
  }, [sceneData.bkgdCno, activeCam.icam, activeCam.yaw, activeCam.pitch]);

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
        if (!rig) {
          const tmpl = await loadTemplate(actor.tmplCno);
          if (cancelled) return;
          rig = instantiateTemplateRig(tmpl, actor.costumeCmids, actor.costumeMtrls);
          rig.root.userData = { id: actor.id, type: 'actor', tmplCno: actor.tmplCno };
          group.add(rig.root);
          existing.set(actor.id, rig);
        } else if (actor.costumeCmids || actor.costumeMtrls) {
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

  // Load & sync real 3DMM Prop rigs from TMPLS.3CN
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
        if (!rig) {
          const tmpl = await loadTemplate(prop.tmplCno);
          if (cancelled) return;
          rig = instantiateTemplateRig(tmpl, prop.costumeCmids, prop.costumeMtrls);
          rig.root.userData = { id: prop.id, type: 'prop', tmplCno: prop.tmplCno };
          group.add(rig.root);
          existing.set(prop.id, rig);
        } else if (prop.costumeCmids || prop.costumeMtrls) {
          applyCostumeToRig(rig, prop.costumeCmids || [], prop.costumeMtrls);
        }
      })
    ).then(() => {
      if (!cancelled) setSyncVersion((v) => v + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [sceneData.props]);

  // Load & sync real 3DMM TDT 3D Text entities using TDFS.3CN + MTRLS.3CN
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
        if (existing.has(tdt.id)) return;
        const grp = await buildTdtTextGroup(tdt.text, tdt.tdfCno, tdt.tdts, tdt.mtrlCno);
        if (cancelled) return;
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

  // Apply frame positions, multi-frame ACTN cels, curved interpolation, 3D text, prop actions, and trail dots
  useEffect(() => {
    const bgView = bgViewRef.current;

    sceneData.actors.forEach((actor) => {
      const rig = actorRigsRef.current.get(actor.id);
      if (!rig) return;

      const resolvedAct = resolveActorActionAtFrame(actor, currentFrame);
      const parsedAction =
        activeActionsRef.current.get(`${actor.id}:${resolvedAct.anid}`) ||
        rig.template.actionCache.get(resolvedAct.anid) ||
        rig.template.actionCache.get(0);

      if (parsedAction) {
        const localCelFrame = resolvedAct.freeze
          ? resolvedAct.celOffset
          : resolvedAct.celOffset + Math.max(0, currentFrame - resolvedAct.startFrame);
        applyActionCelToRig(rig, parsedAction, localCelFrame);
      }

      const pos = resolveInterpolatedKeyframe(actor.keyframes, currentFrame);
      const sx = pos.scaleX ?? 1;
      const sy = pos.scaleY ?? 1;
      const sz = pos.scaleZ ?? 1;

      if (isDraggingRef.current && dragEntityIdRef.current === actor.id) {
        rig.root.visible = true;
        const { x, y, z, rotY } = dragLiveWorldPosRef.current;
        rig.root.position.set(x, y, z);
        rig.root.rotation.y = rotY;
        rig.root.scale.set(rig.baseScale * sx, rig.baseScale * sy, rig.baseScale * sz);
        if (yellowOutlineBoxRef.current?.visible) {
          yellowOutlineBoxRef.current.position.copy(rig.root.position).add(boxOffsetRef.current);
        }
        return;
      }

      rig.root.visible = pos.visible !== false;
      const worldRotY = storageToWorld(sceneData, bgView, pos, _worldPosTmp);
      rig.root.position.copy(_worldPosTmp);
      rig.root.rotation.y = worldRotY;
      rig.root.scale.set(rig.baseScale * sx, rig.baseScale * sy, rig.baseScale * sz);
    });

    sceneData.props.forEach((prop) => {
      const rig = propRigsRef.current.get(prop.id);
      if (!rig) return;

      const resolvedPropAct = resolvePropActionAtFrame(prop, currentFrame);
      const localPropFrame = resolvedPropAct.freeze
        ? resolvedPropAct.celOffset
        : resolvedPropAct.celOffset + Math.max(0, currentFrame - resolvedPropAct.startFrame);

      const pos = resolveInterpolatedKeyframe(prop.keyframes, currentFrame);
      const sx = pos.scaleX ?? 1;
      const sy = pos.scaleY ?? 1;
      const sz = pos.scaleZ ?? 1;

      if (isDraggingRef.current && dragEntityIdRef.current === prop.id) {
        rig.root.visible = true;
        const { x, y, z, rotY } = dragLiveWorldPosRef.current;
        rig.root.position.set(x, y, z);
        applyPropActionTransform(
          rig.root,
          resolvedPropAct.action,
          localPropFrame,
          sceneData.totalFrames,
          rig.baseScale,
          rotY || 0
        );
        rig.root.scale.set(rig.root.scale.x * sx, rig.root.scale.y * sy, rig.root.scale.z * sz);
        if (yellowOutlineBoxRef.current?.visible) {
          yellowOutlineBoxRef.current.position.copy(rig.root.position).add(boxOffsetRef.current);
        }
        return;
      }

      rig.root.visible = pos.visible !== false;
      const worldRotY = storageToWorld(sceneData, bgView, pos, _worldPosTmp);
      rig.root.position.copy(_worldPosTmp);
      applyPropActionTransform(
        rig.root,
        resolvedPropAct.action,
        localPropFrame,
        sceneData.totalFrames,
        rig.baseScale,
        worldRotY
      );
      rig.root.scale.set(rig.root.scale.x * sx, rig.root.scale.y * sy, rig.root.scale.z * sz);
    });

    (sceneData.tdtTexts || []).forEach((tdt) => {
      const grp = tdtGroupsRef.current.get(tdt.id);
      if (!grp) return;
      const pos = resolveInterpolatedKeyframe(tdt.keyframes, currentFrame);
      grp.visible = pos.visible !== false;
      const worldRotY = storageToWorld(sceneData, bgView, pos, _worldPosTmp);
      grp.position.copy(_worldPosTmp);
      grp.rotation.y = worldRotY;
      grp.scale.set(pos.scaleX ?? 1, pos.scaleY ?? 1, pos.scaleZ ?? 1);
    });

    // Update trail dots around selected actor/prop
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
      const kfs = selActor?.keyframes || selProp?.keyframes;
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

    const intersects = raycasterRef.current.intersectObjects(pickables, true);
    let clickedId: string | null = null;
    let clickedType: 'actor' | 'prop' | null = null;

    if (intersects.length > 0) {
      let top: THREE.Object3D | null = intersects[0].object;
      while (top && !top.userData?.id && top.parent) {
        top = top.parent;
      }
      if (top?.userData?.id) {
        clickedId = top.userData.id;
        clickedType = top.userData.type as 'actor' | 'prop';
        onSelectEntity(clickedId, clickedType);
        selectedEntityIdRef.current = clickedId;
      }
    }

    if (!clickedId) {
      let closestId: string | null = null;
      let closestType: 'actor' | 'prop' | null = null;
      let bestPx = 56;

      const checkTouch = (id: string, type: 'actor' | 'prop', root: THREE.Object3D, approxH: number) => {
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
    const targetType = isActor ? 'actor' : 'prop';
    const targetRig = actorRigsRef.current.get(targetId) || propRigsRef.current.get(targetId);
    if (!targetRig) return;

    const targetObj = targetRig.root;
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
      rotY: targetType === 'actor' ? targetObj.rotation.y : 0,
    };
    const startStorage = worldToStorage(
      sceneDataRef.current,
      bgViewRef.current,
      worldStart.x,
      worldStart.y,
      worldStart.z,
      worldStart.rotY
    );

    dragStartWorldPosRef.current = { ...worldStart };
    dragLiveWorldPosRef.current = { ...worldStart };
    prevStoragePosRef.current = { x: startStorage.x, z: startStorage.z };
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
      yellowOutlineBoxRef.current.geometry = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(_dragSize.x, _dragSize.y, _dragSize.z)
      );
      yellowOutlineBoxRef.current.position.copy(targetObj.position).add(boxOffsetRef.current);
      yellowOutlineBoxRef.current.visible = true;
    }
  };

  // Pointer Move: unrestricted dragging along camera screen axes + 6 FPS movement recording
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
    const rig = actorRigsRef.current.get(entityId) || propRigsRef.current.get(entityId);
    if (!rig) return;
    const targetObj = rig.root;

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
    const visWidth = 2 * dist * Math.tan(fovRad * 0.5) * camera.aspect;

    const moveRight = (ddxPx / rect.width) * visWidth * 0.72;
    const moveFwd = (-ddyPx / rect.height) * Math.max(24, dist * 0.9);

    const targetX = prevWorld.x + _camRightXZ.x * moveRight + _camForwardXZ.x * moveFwd;
    const targetZ = prevWorld.z + _camRightXZ.z * moveRight + _camForwardXZ.z * moveFwd;

    // Compute facing directly in direction of motion (local +Z aligns with face)
    let rotY = prevWorld.rotY;
    if (type === 'actor' && isRecordingMovementRef.current) {
      const hdx = targetX - lastHeadingPosRef.current.x;
      const hdz = targetZ - lastHeadingPosRef.current.z;
      if (Math.hypot(hdx, hdz) > 0.22) {
        const targetHeading = Math.atan2(hdx, hdz);
        rotY = lerpShortestAngle(prevWorld.rotY, targetHeading, 0.72);
        lastHeadingPosRef.current = { x: targetX, z: targetZ };
      }
    }

    const nextWorld = { x: targetX, y: prevWorld.y, z: targetZ, rotY };
    dragLiveWorldPosRef.current = nextWorld;
    targetObj.position.set(targetX, prevWorld.y, targetZ);
    if (type === 'actor') targetObj.rotation.y = rotY;

    if (yellowOutlineBoxRef.current?.visible) {
      yellowOutlineBoxRef.current.position.copy(targetObj.position).add(boxOffsetRef.current);
    }

    const nextStorage = worldToStorage(
      sceneDataRef.current,
      bgViewRef.current,
      targetX,
      prevWorld.y,
      targetZ,
      rotY
    );
    const stepDeltaX = nextStorage.x - prevStoragePosRef.current.x;
    const stepDeltaZ = nextStorage.z - prevStoragePosRef.current.z;
    prevStoragePosRef.current = { x: nextStorage.x, z: nextStorage.z };

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
          dragStartWorldPosRef.current.rotY
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
            curLive.rotY
          );
          onRecordMovementStepRef.current(
            dragEntityIdRef.current,
            dragEntityTypeRef.current || 'actor',
            nf,
            liveStorage,
            true
          );
        }, 1000 / 6); // Authentic 6 FPS motion recording
      } else {
        onMoveEntityAtFrameRef.current(
          entityId,
          type,
          currentFrameRef.current,
          nextStorage,
          stepDeltaX,
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
        curLive.rotY
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

  const activeTextBoxes = (sceneData.textBoxes || []).filter(
    (tb) => currentFrame >= tb.startFrame && currentFrame <= tb.endFrame
  );

  return (
    <div className="relative w-full h-full flex items-center justify-center studio-stage-well overflow-hidden select-none touch-none p-2">
      {/* Authentic 544x306 3DMM Stage Frame */}
      <div
        className="relative w-full max-h-full aspect-[544/306] bg-black studio-bevel-frame overflow-hidden"
        style={{ containerType: 'inline-size' }}
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

        {/* Smooth-Shaded WebGL Layer + ZBMP Depth Occlusion + TDT 3D Text */}
        <div
          ref={mountRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`absolute inset-0 w-full h-full touch-none ${
            isRecordingMovement ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
          }`}
        />

        {/* Authentic 2D On-Screen Text Boxes (Scrolling Credits & Static Captions from TBOX/RTXT/TEXT) */}
        {activeTextBoxes.map((tb) => {
          const leftPct = Math.max(0, Math.min(100, (tb.left / 544) * 100));
          const topPct = Math.max(0, Math.min(100, (tb.top / 306) * 100));
          const widthPct = Math.max(1, Math.min(100 - leftPct, ((tb.right - tb.left) / 544) * 100));
          const heightPct = Math.max(1, Math.min(100 - topPct, ((tb.bottom - tb.top) / 306) * 100));
          const spanFrames = Math.max(1, tb.endFrame - tb.startFrame);
          const scrollProgress = Math.max(0, Math.min(1, (currentFrame - tb.startFrame) / spanFrames));

          return (
            <div
              key={tb.id}
              className="absolute pointer-events-none overflow-hidden select-none"
              style={{
                left: `${leftPct}%`,
                top: `${topPct}%`,
                width: `${widthPct}%`,
                height: `${heightPct}%`,
                fontFamily: `"${tb.fontName}", "Comic Sans MS", cursive, sans-serif`,
                fontSize: '3.2cqw',
                lineHeight: 1.28,
                color: '#ffffff',
                textShadow: '1px 1px 2px rgba(0,0,0,0.95), -1px -1px 1px rgba(0,0,0,0.75)',
              }}
            >
              <div
                className="whitespace-pre-wrap break-words font-semibold"
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

        {isRecordingMovement && (
          <div className="absolute top-2.5 left-1/2 -translate-x-1/2 bg-amber-400 text-slate-950 font-bold px-3 py-1 border-2 border-black shadow-lg flex items-center gap-2 pointer-events-none text-xs">
            <img src="/3dmm/bmp/2RECDS.BMP" alt="" className="w-4 h-4 image-rendering-pixelated" />
            <span>RECORDING (6 FPS): Drag entity to move</span>
          </div>
        )}

        {/* Stage Info Badges */}
        <div className="absolute top-1.5 left-2 right-2 flex justify-between items-center pointer-events-none text-[11px] font-bold">
          <span className="bg-[#1b0e36]/85 text-amber-200 px-2 py-0.5 border border-[#8e63d6]">
            Scene {sceneIndex + 1}/{totalScenes}: {sceneData.sceneName} (View {activeCam.icam + 1})
          </span>
          <span className="bg-[#1b0e36]/85 text-cyan-200 px-2 py-0.5 border border-[#8e63d6]">
            Frame {currentFrame} / {sceneData.totalFrames} @ 6 FPS
          </span>
        </div>
      </div>
    </div>
  );
};

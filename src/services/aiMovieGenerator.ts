import {
  ActionKeyframe,
  ActorEntity,
  CameraCutEvent,
  ImportedAudioCue,
  KeyframePosition,
  Movie,
  PropActionKeyframe,
  PropEntity,
  Scene,
  SceneTransition,
  ScreenTextBox,
  TdtTextEntity,
} from '../types/movie';
import {
  CatalogActorItem,
  CatalogPropItem,
  CatalogSceneItem,
  loadTdtMaterialSwatches,
  loadTemplate,
  normalizeTdtActionName,
  ParsedTemplate,
  TDF_FONT_OPTIONS,
  TDT_ACTIONS,
  TDT_SHAPE_OPTIONS,
  ThreeDmmCatalog,
} from './threeDmmEngine';
import { CatalogSoundItem, sound3DMM, synthesizeSapi4Tts } from './soundLibrary';
import { CatalogSummaryPayload } from './aiTrainingContext';

interface AiKeyframePlan {
  frame: number;
  x: number;
  y: number;
  z: number;
  rotX?: number;
  rotY: number;
  rotZ?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  visible?: boolean;
  colorHex?: string;
}

interface AiActionSegmentPlan {
  frame: number;
  actionName: string;
}

interface AiMoviePlan {
  title: string;
  plot: string;
  scenes: {
    sceneName: string;
    durationFrames: number;
    transition?: SceneTransition | string;
    cameraCuts?: { frame: number; viewIndex: number }[];
    actors?: {
      name: string;
      customName?: string;
      costumePreset?: number;
      colorHex?: string;
      startFrame?: number;
      endFrame?: number;
      actionSegments?: AiActionSegmentPlan[];
      keyframes?: AiKeyframePlan[];
    }[];
    props?: {
      name: string;
      customName?: string;
      costumePreset?: number;
      colorHex?: string;
      startFrame?: number;
      endFrame?: number;
      actionSegments?: AiActionSegmentPlan[];
      keyframes?: AiKeyframePlan[];
    }[];
    tdtTexts?: {
      text: string;
      fontName?: string;
      shapeName?: string;
      action?: string;
      colorHex?: string;
      startFrame?: number;
      endFrame?: number;
      x: number;
      y: number;
      z: number;
      rotX?: number;
      rotY?: number;
      rotZ?: number;
      scale?: number;
      scaleX?: number;
      scaleY?: number;
      scaleZ?: number;
      keyframes?: AiKeyframePlan[];
    }[];
    textBoxes?: {
      text: string;
      fontName?: string;
      fontSize?: number;
      bold?: boolean;
      italic?: boolean;
      startFrame: number;
      endFrame: number;
      placement?: string;
      isScrolling?: boolean;
      colorHex?: string;
      bgColorHex?: string;
    }[];
    audioCues?: {
      frame: number;
      soundName: string;
      loop?: boolean;
    }[];
    ttsVoices?: {
      frame: number;
      speaker?: string;
      text: string;
      voice?: string;
      pitch?: number;
      speed?: number;
      waitForFinish?: boolean;
    }[];
  }[];
}

const COMMON_ACTOR_ACTIONS = [
  'At Rest',
  'Walk Fast',
  'Walk Slowly',
  'Walk Backwards',
  'Run',
  'Run Scared',
  'Sneak',
  'Crawl',
  'Greet',
  'Dance',
  'Laugh',
  'Jump',
  'Karate Kick',
  'Faint',
  'Fall',
  'Fly',
  'Kneel',
  'Mad, Sad',
  'Sit, Talk, Stand',
  'Spin',
  'Think',
  'Yell',
  'Talk',
];

const COMMON_PROP_ACTIONS = [
  'At Rest',
  'Grow',
  'Grow Fast',
  'Shrink',
  'Shrink Fast',
  'Spin',
  'Spin Fast',
  'Squash',
  'Stretch',
];

const FONT_2D_LIST = [
  'Comic Sans MS',
  'Arial',
  'Futura',
  'Times New Roman',
  'Courier New',
  'Impact',
  'Verdana',
  'Georgia',
  'Trebuchet MS',
  'Tahoma',
  'Brush Script MT',
  'Century Gothic',
];

const SIGNATURE_SOUND_PATTERNS = [
  /funny moment|happy end|triumph|danger|scare|tension|specter|quest|mystery|geist|bistro|villain|ghoul|wraith|spirit|safari|explore|dream|sleuth|search|howdy|imaginopolis|rockin|3d movie|clue hunt|sneaking|east side|hangin|calliope|sadness/i,
  /explosion|rocket launch|owl hoot|thunder|siren|chuckle|laugh|crash|scream|applause|footstep|static|mega|ebase|look3|rover|ahhh|zap|thump|whiff/i,
  /surprise|oh no|hey|watch out|hurry|all right|yipee|worked|follow me|stop!|get him|creation|doggy|mega/i,
];

const DIVERSE_SAPI4_VOICES: Array<{
  voice: string;
  pitch: number;
  speed: number;
  isFemale?: boolean;
}> = [
  { voice: 'Sam', pitch: 100, speed: 150 },
  { voice: 'Mike', pitch: 112, speed: 170 },
  { voice: 'Mary', pitch: 169, speed: 170, isFemale: true },
  { voice: 'Adult Male #1, American English (TruVoice)', pitch: 82, speed: 145 },
  { voice: 'Adult Female #1, American English (TruVoice)', pitch: 200, speed: 150, isFemale: true },
  { voice: 'Adult Male #3, American English (TruVoice)', pitch: 114, speed: 155 },
  { voice: 'Adult Female #2, American English (TruVoice)', pitch: 225, speed: 158, isFemale: true },
  { voice: 'Adult Male #4, American English (TruVoice)', pitch: 92, speed: 148 },
  { voice: 'Mike in Hall', pitch: 112, speed: 165 },
  { voice: 'Mary in Hall', pitch: 169, speed: 168, isFemale: true },
  { voice: 'Adult Male #5, American English (TruVoice)', pitch: 132, speed: 155 },
];

const FEMALE_HINT_RE =
  /\b(mary|margaret|lucy|nakita|claire|sara|sarah|alice|anna|emma|lily|queen|princess|mom|mother|sister|girl|woman|lady|witch|nurse|grandma|mrs\.?|ms\.?)\b/i;

function isBonziVoiceName(voice?: string): boolean {
  const v = (voice || '').trim().toLowerCase();
  return /bonzi|adult\s*male\s*#?2/i.test(v);
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return (min + max) * 0.5;
  return Math.max(min, Math.min(max, v));
}

function validHex(hex?: string): string | undefined {
  if (!hex || typeof hex !== 'string') return undefined;
  const trimmed = hex.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function isColorablePrimitiveProp(name?: string): boolean {
  return /^(?:torus|sphere|cube|cylinder|explosio(?:n)?)\b/i.test((name || '').trim());
}

function normalizeTransition(raw?: string): SceneTransition | undefined {
  const clean = (raw || '').trim().toLowerCase();
  if (!clean) return undefined;
  if (clean === 'cut') return 'cut';
  if (clean === 'dissolve') return 'dissolve';
  if (clean === 'fadetoblack' || clean === 'fade_to_black' || clean === 'black') return 'fadeToBlack';
  if (clean === 'fadetowhite' || clean === 'fade_to_white' || clean === 'white') return 'fadeToWhite';
  return undefined;
}

function findSceneMatch(name: string, scenes: CatalogSceneItem[]): CatalogSceneItem {
  const clean = (name || '').trim().toLowerCase();
  return (
    scenes.find((s) => s.name.toLowerCase() === clean) ||
    scenes.find((s) => s.name.toLowerCase().includes(clean) || clean.includes(s.name.toLowerCase())) ||
    scenes[0]
  );
}

function findActorMatch(name: string, actors: CatalogActorItem[]): CatalogActorItem {
  const clean = (name || '').trim().toLowerCase();
  return (
    actors.find((a) => a.name.toLowerCase() === clean) ||
    actors.find((a) => a.name.toLowerCase().includes(clean) || clean.includes(a.name.toLowerCase())) ||
    actors[Math.floor(Math.random() * Math.max(1, actors.length))]
  );
}

function findPropMatch(name: string, props: CatalogPropItem[]): CatalogPropItem {
  const clean = (name || '').trim().toLowerCase();
  return (
    props.find((p) => p.name.toLowerCase() === clean) ||
    props.find((p) => p.name.toLowerCase().includes(clean) || clean.includes(p.name.toLowerCase())) ||
    props[0]
  );
}

function resolveTemplateAction(tmpl: ParsedTemplate, requestedName: string): { anid: number; name: string } {
  const clean = (requestedName || '').trim().toLowerCase();
  const actions = tmpl.actions;
  if (actions.length === 0) return { anid: 0, name: 'At Rest' };

  const exact = actions.find((a) => a.name.trim().toLowerCase() === clean);
  if (exact) return exact;

  const tokens = clean.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  let best = actions[0];
  let bestScore = -1;
  for (const act of actions) {
    const aLow = act.name.trim().toLowerCase();
    let score = 0;
    if (aLow.includes(clean) || clean.includes(aLow)) score += 5;
    for (const tok of tokens) {
      if (aLow.includes(tok)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = act;
    }
  }
  return bestScore > 0 ? best : actions[0];
}

function resolveCostumeCmids(
  tmpl: ParsedTemplate | null,
  presetIndex: number | undefined
): number[] | undefined {
  if (!tmpl || presetIndex === undefined || !Number.isFinite(presetIndex)) return undefined;
  const idx = Math.max(0, Math.round(presetIndex));
  const cmids = tmpl.costumeSets
    .map((setIds) => (setIds.length > 0 ? setIds[idx % setIds.length] : undefined))
    .filter((id): id is number => id !== undefined);
  return cmids.length > 0 ? cmids : undefined;
}

function resolveActionNameAtFrame(
  actionMap: Record<number, { actionName?: string; action?: string }>,
  frame: number
): string {
  const keys = Object.keys(actionMap)
    .map(Number)
    .filter((k) => k <= frame)
    .sort((a, b) => a - b);
  if (keys.length === 0) return 'At Rest';
  const entry = actionMap[keys[keys.length - 1]];
  return (entry?.actionName || entry?.action || 'At Rest').toLowerCase();
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export function buildEntityKeyframes(
  rawKfs: AiKeyframePlan[] | undefined,
  totalFrames: number,
  fallbackX: number,
  fallbackZ: number,
  opts: {
    colorHex?: string;
    allowColor?: boolean;
    startFrame?: number;
    endFrame?: number;
    isActor?: boolean;
    entityName?: string;
    allowSlowUser?: boolean;
    actionMap?: Record<number, { actionName?: string; action?: string }>;
    onRemapFrames?: (remap: Array<{ origF: number; newF: number }>) => void;
    onEnsureMoveLocomotion?: (
      f0: number,
      f1: number,
      speed: number,
      dx: number,
      dy: number,
      dz: number,
      yStart: number,
      yEnd: number,
      rotYStart: number
    ) => void;
    onEnsureStopRest?: (stopFrame: number, nextMoveFrame: number | null, yPos: number) => void;
    onEnsureStationaryRest?: (f0: number, f1: number, yPos: number) => void;
  }
): Record<number, KeyframePosition> {
  const allowColor = opts.allowColor !== false;
  const defaultColor = allowColor ? validHex(opts.colorHex) : undefined;
  const parsedKfs: Record<number, KeyframePosition> = {};

  if (Array.isArray(rawKfs)) {
    for (const kf of rawKfs) {
      const f = Math.round(clamp(kf.frame, 0, totalFrames));
      const baseScale = kf.scale !== undefined ? clamp(kf.scale, 0.04, 10.0) : 1;
      const sx = kf.scaleX !== undefined ? clamp(kf.scaleX, 0.04, 10.0) : baseScale;
      const sy = kf.scaleY !== undefined ? clamp(kf.scaleY, 0.04, 10.0) : baseScale;
      const sz = kf.scaleZ !== undefined ? clamp(kf.scaleZ, 0.04, 10.0) : baseScale;
      const entry: KeyframePosition = {
        x: clamp(kf.x, -30, 30),
        y: clamp(kf.y, -5, 22),
        z: clamp(kf.z, -30, 30),
        rotY: Number.isFinite(kf.rotY) ? kf.rotY : 0,
      };
      if (kf.rotX !== undefined && Math.abs(kf.rotX) > 0.01 && Number.isFinite(kf.rotX)) {
        entry.rotX = kf.rotX;
      }
      if (kf.rotZ !== undefined && Math.abs(kf.rotZ) > 0.01 && Number.isFinite(kf.rotZ)) {
        entry.rotZ = kf.rotZ;
      }
      if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02 || Math.abs(sz - 1) > 0.02) {
        entry.scaleX = Number(sx.toFixed(3));
        entry.scaleY = Number(sy.toFixed(3));
        entry.scaleZ = Number(sz.toFixed(3));
      }
      if (kf.visible !== undefined) {
        entry.visible = Boolean(kf.visible);
      }
      if (allowColor) {
        const kfColor = validHex(kf.colorHex) || defaultColor;
        if (kfColor) {
          entry.color = kfColor;
        }
      }
      parsedKfs[f] = entry;
    }
  }

  if (!parsedKfs[0]) {
    const firstKey = Object.keys(parsedKfs).map(Number).sort((a, b) => a - b)[0];
    parsedKfs[0] =
      firstKey !== undefined
        ? { ...parsedKfs[firstKey] }
        : {
            x: fallbackX,
            y: 0,
            z: fallbackZ,
            rotY: 0,
            ...(defaultColor ? { color: defaultColor } : {}),
          };
  }

  // Enforce entity-level startFrame / endFrame visibility gates when provided
  if (opts.startFrame !== undefined && Number.isFinite(opts.startFrame)) {
    const sf = Math.round(clamp(opts.startFrame, 0, totalFrames));
    if (sf > 0) {
      const sorted = Object.keys(parsedKfs).map(Number).sort((a, b) => a - b);
      const ref = parsedKfs[sf] || parsedKfs[sorted.find((k) => k >= sf) ?? sorted[0]];
      parsedKfs[0] = { ...ref, visible: false };
      parsedKfs[sf] = { ...(parsedKfs[sf] || ref), visible: true };
    }
  }
  if (opts.endFrame !== undefined && Number.isFinite(opts.endFrame)) {
    const ef = Math.round(clamp(opts.endFrame, 0, totalFrames));
    if (ef < totalFrames) {
      const sorted = Object.keys(parsedKfs).map(Number).sort((a, b) => a - b);
      const prevKey = [...sorted].reverse().find((k) => k <= ef) ?? sorted[0];
      const ref = parsedKfs[ef] || parsedKfs[prevKey];
      parsedKfs[ef] = { ...ref, visible: false };
    }
  }

  // Anti-snail speed normalization: compress overly stretched 0..durationFrames slow drifts
  // unless user explicitly requested slow/snail/creep motion or entity uses Sneak/Walk Slowly/Crawl
  const kfs: Record<number, KeyframePosition> = {};
  const origFrames = Object.keys(parsedKfs).map(Number).sort((a, b) => a - b);

  if (origFrames.length >= 2 && !opts.allowSlowUser) {
    const remapped: { origF: number; newF: number; pos: KeyframePosition; compressed: boolean }[] = [
      { origF: origFrames[0], newF: origFrames[0], pos: parsedKfs[origFrames[0]], compressed: false },
    ];
    let anyCompressed = false;

    for (let i = 0; i < origFrames.length - 1; i++) {
      const f0 = origFrames[i];
      const f1 = origFrames[i + 1];
      const p0 = parsedKfs[f0];
      const p1 = parsedKfs[f1];
      const origSpan = f1 - f0;
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
      const prevNewF = remapped[remapped.length - 1].newF;
      const segAct = opts.actionMap ? resolveActionNameAtFrame(opts.actionMap, f0) : '';
      const isSlowAct = /sneak|walk slowly|crawl/i.test(segAct);
      const isFastSeg =
        /run|fly|bang|grow fast|shrink fast/i.test(segAct) ||
        /car|rocket|explosio|plane|ufo|missile|laser/i.test(opts.entityName || '');
      const speed = origSpan > 0 ? dist / origSpan : dist;

      let stepSpan = origSpan;
      let compressed = false;
      const isFullSceneSmear = f0 === 0 && origSpan >= Math.max(26, totalFrames * 0.78);
      const needsCompression = opts.isActor
        ? (isFullSceneSmear && speed < 0.26) || (origSpan >= 30 && speed < 0.16)
        : (isFullSceneSmear && speed < 0.45) || (origSpan >= 24 && isFastSeg && speed < 0.45);
      if (
        p0.visible !== false &&
        p1.visible !== false &&
        !isSlowAct &&
        dist >= 1.2 &&
        needsCompression
      ) {
        const targetSpeed = opts.isActor ? (isFastSeg ? 0.72 : 0.42) : isFastSeg ? 1.25 : 0.65;
        const maxComp = Math.min(origSpan - 1, Math.max(22, Math.round(totalFrames * 0.72)));
        stepSpan = Math.round(clamp(dist / targetSpeed, 10, Math.max(11, maxComp)));
        compressed = stepSpan < origSpan;
        if (compressed) anyCompressed = true;
      }
      const nextF = Math.min(totalFrames, prevNewF + Math.max(1, stepSpan));
      remapped.push({ origF: f1, newF: nextF, pos: p1, compressed });
    }

    if (anyCompressed && opts.onRemapFrames) {
      opts.onRemapFrames(remapped.map((r) => ({ origF: r.origF, newF: r.newF })));
    }

    // If a slow single bounce/oscillation (e.g. f=0 -> f=30 -> f=60 returning near start) got compressed,
    // repeat the snappy compressed cycle up to the original end frame so the object keeps moving!
    const first = remapped[0];
    const last = remapped[remapped.length - 1];
    const loopDist = Math.hypot(last.pos.x - first.pos.x, last.pos.y - first.pos.y, last.pos.z - first.pos.z);
    const cycleSpan = last.newF - first.newF;
    if (
      anyCompressed &&
      remapped.length >= 3 &&
      first.pos.visible !== false &&
      last.pos.visible !== false &&
      loopDist < 1.5 &&
      cycleSpan >= 4 &&
      last.origF >= Math.max(24, totalFrames * 0.65) &&
      last.newF + cycleSpan <= last.origF
    ) {
      let cursor = last.newF;
      while (cursor + cycleSpan <= last.origF) {
        for (let r = 1; r < remapped.length; r++) {
          const offset = remapped[r].newF - first.newF;
          const cycF = Math.min(last.origF, cursor + offset);
          kfs[cycF] = { ...remapped[r].pos };
        }
        cursor += cycleSpan;
      }
    }

    for (const r of remapped) {
      kfs[r.newF] = r.pos;
    }
  } else {
    Object.assign(kfs, parsedKfs);
  }

  const anchorFrames = Object.keys(kfs).map(Number).sort((a, b) => a - b);

  // Align actor locomotion & stop transitions strictly with movement segments [f0, f1)
  if (opts.isActor && anchorFrames.length > 0) {
    const segMoves: boolean[] = [];
    for (let i = 0; i < anchorFrames.length - 1; i++) {
      const f0 = anchorFrames[i];
      const f1 = anchorFrames[i + 1];
      const p0 = kfs[f0];
      const p1 = kfs[f1];
      const span = f1 - f0;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const dz = p1.z - p0.z;
      const dist = Math.hypot(dx, dy, dz);
      const moved = span >= 1 && p0.visible !== false && p1.visible !== false && dist > 0.35;
      segMoves.push(moved);
      if (moved && opts.onEnsureMoveLocomotion) {
        opts.onEnsureMoveLocomotion(f0, f1, dist / span, dx, dy, dz, p0.y, p1.y, p0.rotY);
      } else if (!moved && opts.onEnsureStationaryRest) {
        opts.onEnsureStationaryRest(f0, f1, p0.y);
      }
    }

    if (segMoves.length === 0 && opts.onEnsureStationaryRest) {
      const fOnly = anchorFrames[0];
      opts.onEnsureStationaryRest(fOnly, totalFrames, kfs[fOnly].y);
    }

    // Whenever an actor stops after a moving segment (either entering a stationary segment or halting before scene end),
    // guarantee the action switches cleanly to At Rest (or preserves explicit Talk/Laugh/Sit/etc.) at that exact stop frame!
    if (opts.onEnsureStopRest) {
      for (let i = 1; i < anchorFrames.length; i++) {
        const prevMoved = segMoves[i - 1];
        const curMoved = i < segMoves.length ? segMoves[i] : false;
        const stopF = anchorFrames[i];
        if (prevMoved && !curMoved && (i < segMoves.length || stopF < totalFrames)) {
          let nextMoveF: number | null = null;
          for (let j = i + 1; j < segMoves.length; j++) {
            if (segMoves[j]) {
              nextMoveF = anchorFrames[j];
              break;
            }
          }
          opts.onEnsureStopRest(stopF, nextMoveF, kfs[stopF].y);
        }
      }
    }
  }

  // Densify EVERY frame (step = 1) along moving segments so both discrete 6 FPS playback
  // (default enableInterpolation = false) and 60 FPS interpolation animate fluidly with zero stalling!
  const densified: Record<number, KeyframePosition> = { ...kfs };

  for (let i = 0; i < anchorFrames.length - 1; i++) {
    const f0 = anchorFrames[i];
    const f1 = anchorFrames[i + 1];
    const p0 = densified[f0] || kfs[f0];
    const p1 = densified[f1] || kfs[f1];
    const span = f1 - f0;
    if (span < 2 || p0.visible === false || p1.visible === false) continue;

    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dz = p1.z - p0.z;
    const horizDist = Math.hypot(dx, dz);
    const activeAct = opts.actionMap ? resolveActionNameAtFrame(opts.actionMap, f0) : '';
    const isJumping = opts.isActor && /jump|hop/i.test(activeAct);
    const isBackwards = opts.isActor && /walk backwards/i.test(activeAct);
    const isLocomotion = /walk|run|sneak|crawl|fly/i.test(activeAct);
    const isMoving = horizDist > 0.25 || Math.abs(dy) > 0.25 || isJumping;
    if (!isMoving) continue;

    const travelYaw =
      horizDist > 0.25 ? (isBackwards ? Math.atan2(-dx, -dz) : Math.atan2(dx, dz)) : p0.rotY;

    // Aim depart keyframe f0 in the travel direction so actor walks where they go from frame 1 of the move
    if (opts.isActor && isLocomotion && horizDist > 0.25) {
      densified[f0] = { ...p0, rotY: Number(travelYaw.toFixed(3)) };
    }

    // Avoid sudden snap back to facing camera (0) right at arrival unless transitioning into a later directional move
    if (
      opts.isActor &&
      isLocomotion &&
      horizDist > 0.25 &&
      Math.abs(travelYaw) > 0.45 &&
      Math.abs(p1.rotY) < 0.05
    ) {
      densified[f1] = { ...p1, rotY: Number(travelYaw.toFixed(3)) };
    }

    for (let f = f0 + 1; f < f1; f++) {
      if (densified[f]) continue;
      const t = (f - f0) / span;
      const arcY = isJumping ? Math.sin(t * Math.PI) * 0.9 : 0;
      const entry: KeyframePosition = {
        x: Number((p0.x + dx * t).toFixed(3)),
        y: Number((p0.y + dy * t + arcY).toFixed(3)),
        z: Number((p0.z + dz * t).toFixed(3)),
        rotY:
          horizDist > 0.25 && isLocomotion
            ? Number(travelYaw.toFixed(3))
            : Number(lerpAngle(p0.rotY, p1.rotY, t).toFixed(3)),
      };
      if (p0.rotX !== undefined || p1.rotX !== undefined) {
        entry.rotX = Number(lerpAngle(p0.rotX ?? 0, p1.rotX ?? 0, t).toFixed(3));
      }
      if (p0.rotZ !== undefined || p1.rotZ !== undefined) {
        entry.rotZ = Number(lerpAngle(p0.rotZ ?? 0, p1.rotZ ?? 0, t).toFixed(3));
      }
      const sx = (p0.scaleX ?? 1) + ((p1.scaleX ?? 1) - (p0.scaleX ?? 1)) * t;
      const sy = (p0.scaleY ?? 1) + ((p1.scaleY ?? 1) - (p0.scaleY ?? 1)) * t;
      const sz = (p0.scaleZ ?? 1) + ((p1.scaleZ ?? 1) - (p0.scaleZ ?? 1)) * t;
      if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02 || Math.abs(sz - 1) > 0.02) {
        entry.scaleX = Number(sx.toFixed(3));
        entry.scaleY = Number(sy.toFixed(3));
        entry.scaleZ = Number(sz.toFixed(3));
      }
      if (allowColor && p0.color) entry.color = p0.color;
      densified[f] = entry;
    }
  }

  return densified;
}

function rectForPlacement(placement?: string, isScrolling?: boolean) {
  const mode = (placement || '').toLowerCase();
  if (isScrolling || mode === 'credits') {
    return { left: 56, top: 18, right: 488, bottom: 294 };
  }
  if (mode === 'top') {
    return { left: 32, top: 14, right: 512, bottom: 82 };
  }
  if (mode === 'center') {
    return { left: 54, top: 102, right: 490, bottom: 204 };
  }
  return { left: 32, top: 224, right: 512, bottom: 294 };
}

const SAMPLE_MOVIE_AUDIO_SOURCES: Record<string, string> = {
  'ghoul evil theme': 'BONGO.3MM / HOSPITAL.3MM',
  'deep chasm 1': 'BOOOOOO.3MM',
  'deep chasm 2': 'BOOOOOO.3MM / SPROG.3MM',
  'boooooo!!': 'BOOOOOO.3MM (Sample Voice)',
  'bistro evil theme': 'CITYTOUR.3MM / SPROG.3MM',
  'howdy good theme': 'DIALOGUE.3MM',
  'search evil part2': 'GRAVEYRD.3MM',
  'search evil part3': 'GRAVEYRD.3MM',
  'ending evil 9': 'GRAVEYRD.3MM',
  'specter evil theme': 'HAUNTED.3MM / THEBOOK.3MM',
  'wraith evil theme': 'HAUNTED.3MM / HOSPITAL.3MM',
  'mystery evil theme': 'JOG.3MM / THETHIEF.3MM',
  'mystery evil part2': 'HOSPITAL.3MM',
  'spirit evil theme': 'HOSPITAL.3MM',
  "hero's coming": 'HOSPITAL.3MM / VENUS31.3MM',
  'safari evil theme': 'JUNGLE.3MM / SPACE.3MM',
  'sleuth evil theme': 'MESSAGE.3MM',
  'villain wins': 'MESSAGE.3MM / THETHIEF.3MM',
  'imaginopolis theme': 'MESSAGE.3MM',
  'jungle chase': 'MESSAGE.3MM / TERROR.3MM',
  'tense1': 'MUMMY.3MM',
  'tense2': 'MUMMY.3MM',
  'hurry 1': 'MUMMY.3MM',
  'hurry 2': 'VENUS31.3MM',
  'quest good theme': 'SPACE.3MM / TERROR.3MM',
  'dream good theme': 'SPROG.3MM',
  'search evil theme': 'SPROG.3MM',
  'search good theme': 'VENUS31.3MM',
  'victory moment 1': 'VENUS31.3MM',
  'victory moment 2': 'SPROG.3MM',
  'short happy end': 'SPROG.3MM',
  'happy ending': 'THETHIEF.3MM / WHERE.3MM',
  'geist evil theme': 'TERROR.3MM',
  'sudden fright': 'TERROR.3MM / THEBOOK.3MM',
  'run away 1': 'TERROR.3MM / VENUS31.3MM',
  'stress chase': 'TERROR.3MM / THETHIEF.3MM',
  'sudden scare': 'TERROR.3MM',
  'funny moment 1': 'TERROR.3MM',
  'clue hunt 1': 'THEBOOK.3MM',
  'sneaking 2': 'THEBOOK.3MM',
  'attack': 'THEBOOK.3MM / THETHIEF.3MM',
  'triumph': 'THETHIEF.3MM',
  'battle ending': 'VENUS31.3MM',
  'heroic ending': 'VENUS31.3MM',
  'prepare & attack': 'VENUS31.3MM',
  'sudden tension': 'VENUS31.3MM',
  'explosion big': 'VENUS31.3MM',
  'rocket launch': 'VENUS31.3MM',
  'explode mortar': 'VENUS31.3MM',
  'owl hoot': 'GRAVEYRD.3MM / HAUNTED.3MM',
  'wolf howl': 'HAUNTED.3MM',
  'laugh maniac': 'HAUNTED.3MM / MESSAGE.3MM',
  'laugh insane': 'HAUNTED.3MM',
  'monster cry': 'HAUNTED.3MM / THEBOOK.3MM',
  'thunder crash': 'JOG.3MM',
  'thunder long': 'TERROR.3MM',
  'siren end': 'HOSPITAL.3MM',
  'door big open': 'HOSPITAL.3MM / THEBOOK.3MM',
  'crash blocks big': 'HOSPITAL.3MM',
  'punch echo': 'SPACE.3MM',
  'creak extralong': 'MUMMY.3MM',
};

function getSoundSourceLabel(item: CatalogSoundItem): string | undefined {
  if (item.sourceLabel) return item.sourceLabel;
  const known = SAMPLE_MOVIE_AUDIO_SOURCES[item.name.trim().toLowerCase()];
  if (known) return known;
  if (item.category === 'speech') return '3DMM Sample Voice (SVTH)';
  return undefined;
}

function normalizeVoiceText(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/\((?:custom|echo|short)\)/gi, ' ')
    .replace(/\.\.\./g, ' ')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findMatchingExistingVoice(
  spokenText: string,
  soundCatalog: CatalogSoundItem[]
): CatalogSoundItem | null {
  const normInput = normalizeVoiceText(spokenText);
  if (normInput.length < 3) return null;

  const voicePool = soundCatalog.filter(
    (s) => s.category === 'speech' || (Boolean(s.sampleFile) && !s.isMidi && s.category !== 'music')
  );

  let best: CatalogSoundItem | null = null;
  let bestScore = 0;

  for (const item of voicePool) {
    const rawName = item.name.trim();
    const isEllipsis = rawName.includes('...');
    const normItem = normalizeVoiceText(rawName);
    if (normItem.length < 3) continue;

    if (normItem === normInput) {
      return item;
    }

    let score = 0;
    if (isEllipsis && normItem.length >= 5 && normInput.startsWith(normItem)) {
      score = 90 + normItem.length;
    } else if (normInput.includes(normItem) && normItem.length >= 6 && normInput.length <= normItem.length * 1.9) {
      score = 65 + normItem.length;
    } else if (normItem.includes(normInput) && normInput.length >= 6 && normItem.length <= normInput.length * 1.9) {
      score = 60 + normInput.length;
    }

    if (item.sampleFile) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= 65 ? best : null;
}

function pickCuratedSounds(prompt: string, soundCatalog: CatalogSoundItem[]): CatalogSoundItem[] {
  const promptTokens = (prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  const pickCategory = (category: 'music' | 'sfx' | 'speech', pattern: RegExp, limit: number) => {
    const pool = soundCatalog.filter((s) => s.category === category);
    const customFirst = pool
      .filter((item) => Boolean(item.sampleFile || item.midiFileUrl || SAMPLE_MOVIE_AUDIO_SOURCES[item.name.trim().toLowerCase()]))
      .map((item) => {
        const hay = `${item.name} ${getSoundSourceLabel(item) || ''}`.toLowerCase();
        let score = item.sampleFile || item.midiFileUrl ? 8 : 5;
        if (pattern.test(item.name)) score += 3;
        for (const tok of promptTokens) {
          if (hay.includes(tok)) score += 6;
        }
        return { item, score };
      })
      .sort((a, b) => b.score - a.score);

    const scored = pool
      .map((item) => {
        const hay = `${item.name} ${getSoundSourceLabel(item) || ''}`.toLowerCase();
        let score = 0;
        if (item.midiFileUrl || item.sampleFile) score += 7;
        if (SAMPLE_MOVIE_AUDIO_SOURCES[item.name.trim().toLowerCase()]) score += 4;
        if (pattern.test(item.name)) score += 3;
        for (const tok of promptTokens) {
          if (hay.includes(tok)) score += 6;
        }
        const hash = ((item.cno * 2654435761) >>> 0) % 100;
        return { item, score, hash };
      })
      .sort((a, b) => b.score - a.score || a.hash - b.hash);

    const merged: CatalogSoundItem[] = [];
    const seen = new Set<number>();

    // For speech, include ALL 29 SVTH sample voices + ALL custom .3MM voices so AI never needs TTS for existing lines!
    if (category === 'speech') {
      for (const { item } of customFirst) {
        if (!seen.has(item.cno)) {
          seen.add(item.cno);
          merged.push(item);
        }
      }
      for (const { item } of scored) {
        if (!seen.has(item.cno)) {
          seen.add(item.cno);
          merged.push(item);
        }
      }
      return merged;
    }

    const customQuota = category === 'sfx' ? 28 : 34;
    for (const { item } of customFirst.slice(0, customQuota)) {
      if (seen.has(item.cno)) continue;
      seen.add(item.cno);
      merged.push(item);
    }
    for (const { item } of scored) {
      if (seen.has(item.cno)) continue;
      seen.add(item.cno);
      merged.push(item);
      if (merged.length >= limit) break;
    }
    return merged;
  };

  return [
    ...pickCategory('music', SIGNATURE_SOUND_PATTERNS[0], 55),
    ...pickCategory('sfx', SIGNATURE_SOUND_PATTERNS[1], 50),
    ...pickCategory('speech', SIGNATURE_SOUND_PATTERNS[2], 80),
  ];
}

export function diversifyAiMovieBlocking(rawScenes: AiMoviePlan['scenes'], prompt: string): void {
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) return;
  const userRequestedRight =
    /\b(to the right|go right|move right|walk right|run right|walking right|running right|moving right|head right|facing right|from left to right|left-to-right)\b/i.test(
      prompt || ''
    );

  let prevSceneStopFrame: number | null = null;

  for (let sIdx = 0; sIdx < rawScenes.length; sIdx++) {
    const sp = rawScenes[sIdx];
    const actors = sp.actors || [];
    if (actors.length === 0) continue;
    const totalFrames = Math.round(clamp(sp.durationFrames || 54, 12, 360));

    type ActorMetric = {
      ap: NonNullable<AiMoviePlan['scenes'][number]['actors']>[number];
      kfs: AiKeyframePlan[];
      firstIdx: number;
      lastMoveIdx: number;
      horiz: number;
      isRightward: boolean;
    };

    const metrics: ActorMetric[] = [];
    for (const ap of actors) {
      if (!Array.isArray(ap.keyframes) || ap.keyframes.length === 0) continue;
      ap.keyframes.sort((a, b) => a.frame - b.frame);
      const kfs = ap.keyframes;
      let firstIdx = kfs.findIndex((k) => k.visible !== false);
      if (firstIdx < 0) firstIdx = 0;

      let lastMoveIdx = -1;
      for (let i = kfs.length - 1; i >= 1; i--) {
        if (kfs[i].visible === false || kfs[i - 1].visible === false) continue;
        const d = Math.hypot(kfs[i].x - kfs[i - 1].x, kfs[i].y - kfs[i - 1].y, kfs[i].z - kfs[i - 1].z);
        if (d > 0.35) {
          lastMoveIdx = i;
          break;
        }
      }

      const endIdx = lastMoveIdx >= 1 ? lastMoveIdx : firstIdx;
      const dxTotal = kfs[endIdx].x - kfs[firstIdx].x;
      const dzTotal = kfs[endIdx].z - kfs[firstIdx].z;
      const horiz = Math.hypot(dxTotal, dzTotal);
      const isRightward =
        horiz > 1.8 && dxTotal > 1.5 && Math.abs(dzTotal) <= Math.max(2.2, dxTotal * 0.45);
      metrics.push({ ap, kfs, firstIdx, lastMoveIdx, horiz, isRightward });
    }

    if (!userRequestedRight) {
      const moving = metrics.filter((m) => m.horiz > 1.8);
      const rightward = moving.filter((m) => m.isRightward);
      const stationary = metrics.filter((m) => m.horiz <= 0.6);

      if (moving.length > 0 && rightward.length >= Math.ceil(moving.length * 0.6)) {
        const sceneHash = Math.abs(
          (sp.sceneName || '')
            .split('')
            .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0) +
            sIdx * 3
        );
        const mode = ((sceneHash % 4) + sIdx) % 4;

        // If 1 actor walks toward a stationary actor, pivot around the destination so interaction stays aligned
        const anchorToDest = moving.length === 1 && stationary.length >= 1;
        let cx = 0;
        let cz = -1.2;
        if (anchorToDest) {
          const endKf = moving[0].kfs[moving[0].lastMoveIdx >= 1 ? moving[0].lastMoveIdx : moving[0].firstIdx];
          cx = endKf.x;
          cz = endKf.z;
        } else {
          let sumX = 0;
          let sumZ = 0;
          let cnt = 0;
          for (const m of moving) {
            for (const k of m.kfs) {
              sumX += k.x;
              sumZ += k.z;
              cnt++;
            }
          }
          if (cnt > 0) {
            cx = sumX / cnt;
            cz = sumZ / cnt;
          }
        }

        const transformPoint = (x: number, z: number) => {
          const rx = x - cx;
          const rz = z - cz;
          let nx = x;
          let nz = z;
          if (mode === 0) {
            // Right-to-Left cross with subtle depth slant
            nx = cx - rx;
            nz = cz + rz + rx * 0.14;
          } else if (mode === 1) {
            // Back-to-Front Diagonal Approach (+72 deg)
            nx = cx + rx * 0.31 - rz * 0.95;
            nz = (anchorToDest ? cz : -1.4) + (rx * 0.95 + rz * 0.31) * 0.72;
          } else if (mode === 2) {
            // Front-to-Back Cross (-108 deg)
            nx = cx - rx * 0.31 + rz * 0.95;
            nz = (anchorToDest ? cz : -1.4) + (-rx * 0.95 - rz * 0.31) * 0.72;
          } else {
            // Back-Right to Front-Left Diagonal (+138 deg)
            nx = cx - rx * 0.74 - rz * 0.67;
            nz = (anchorToDest ? cz : -1.2) + (rx * 0.67 - rz * 0.74) * 0.75;
          }
          return {
            x: Number(clamp(nx, -10.5, 10.5).toFixed(2)),
            z: Number(clamp(nz, -9.5, 6.2).toFixed(2)),
          };
        };

        const targetsToTransform = anchorToDest ? rightward : moving;
        for (const m of targetsToTransform) {
          for (let i = 0; i < m.kfs.length; i++) {
            const p = transformPoint(m.kfs[i].x, m.kfs[i].z);
            m.kfs[i].x = p.x;
            m.kfs[i].z = p.z;
          }
          for (let i = 0; i < m.kfs.length - 1; i++) {
            const dx = m.kfs[i + 1].x - m.kfs[i].x;
            const dz = m.kfs[i + 1].z - m.kfs[i].z;
            if (Math.hypot(dx, dz) > 0.35) {
              const travelRot = Number(Math.atan2(dx, dz).toFixed(3));
              m.kfs[i].rotY = travelRot;
              if (Math.abs(Math.abs(m.kfs[i + 1].rotY) - Math.PI / 2) < 0.25) {
                m.kfs[i + 1].rotY = travelRot;
              }
            }
          }
        }
      }
    }

    // Stagger identical stop frames and overlapping final resting points
    const sceneStops: Array<{ x: number; z: number; frame: number }> = [];
    for (let mIdx = 0; mIdx < metrics.length; mIdx++) {
      const m = metrics[mIdx];
      if (m.lastMoveIdx < 1) continue;
      const stopKf = m.kfs[m.lastMoveIdx];
      const prevKf = m.kfs[m.lastMoveIdx - 1];
      const origStopF = stopKf.frame;

      const collidesFrame = (f: number) =>
        sceneStops.some((s) => Math.abs(s.frame - f) <= 2) ||
        (prevSceneStopFrame !== null && Math.abs(prevSceneStopFrame - f) <= 2);

      if (collidesFrame(origStopF) && totalFrames >= 20) {
        const candidates = [origStopF + 7, origStopF - 6, origStopF + 11, origStopF - 10, origStopF + 4];
        const minAllowed = Math.min(totalFrames - 3, prevKf.frame + 4);
        const maxAllowed = Math.max(minAllowed, totalFrames - 2);
        let chosen = origStopF;
        for (const cand of candidates) {
          if (cand >= minAllowed && cand <= maxAllowed && !collidesFrame(cand)) {
            chosen = cand;
            break;
          }
        }
        if (chosen === origStopF) {
          chosen = Math.round(clamp(origStopF + (mIdx % 2 === 0 ? 6 : -5), minAllowed, maxAllowed));
        }

        const delta = chosen - origStopF;
        if (delta !== 0) {
          stopKf.frame = chosen;
          for (let j = m.lastMoveIdx + 1; j < m.kfs.length; j++) {
            if (m.kfs[j].frame < totalFrames && m.kfs[j].visible !== false) {
              m.kfs[j].frame = Math.round(clamp(m.kfs[j].frame + delta, chosen + 1, totalFrames));
            }
          }
          if (Array.isArray(m.ap.actionSegments)) {
            for (const seg of m.ap.actionSegments) {
              if (seg.frame >= origStopF - 2) {
                seg.frame = Math.round(clamp(seg.frame + delta, chosen, totalFrames));
              }
            }
          }
        }
      }

      if (sceneStops.some((s) => Math.hypot(s.x - stopKf.x, s.z - stopKf.z) < 1.25)) {
        const altX = Number(clamp(stopKf.x + (mIdx % 2 === 0 ? 2.4 : -2.4), -10.5, 10.5).toFixed(2));
        const altZ = Number(clamp(stopKf.z + (mIdx % 2 === 0 ? -1.4 : 1.4), -9.5, 6.2).toFixed(2));
        for (let j = m.lastMoveIdx; j < m.kfs.length; j++) {
          if (Math.hypot(m.kfs[j].x - stopKf.x, m.kfs[j].z - stopKf.z) < 0.2) {
            m.kfs[j].x = altX;
            m.kfs[j].z = altZ;
          }
        }
        stopKf.x = altX;
        stopKf.z = altZ;
        const dx = stopKf.x - prevKf.x;
        const dz = stopKf.z - prevKf.z;
        if (Math.hypot(dx, dz) > 0.35) {
          prevKf.rotY = Number(Math.atan2(dx, dz).toFixed(3));
        }
      }

      sceneStops.push({ x: stopKf.x, z: stopKf.z, frame: stopKf.frame });
      if (mIdx === 0) {
        prevSceneStopFrame = stopKf.frame;
      }
    }
  }
}

const CORPUS_EXPRESSIVE_MOTIFS: string[][] = [
  ['Greet', 'Talk', 'Laugh', 'At Rest'],
  ['Think', 'Talk', 'Jump', 'At Rest'],
  ['Talk', 'Laugh', 'Dance', 'At Rest'],
  ['Greet', 'Think', 'Talk', 'At Rest'],
  ['Think', 'Spin', 'Greet', 'At Rest'],
];

const PET_EXPRESSIVE_MOTIFS: string[][] = [
  ['Greet', 'Jump', 'Spin', 'At Rest'],
  ['Dance', 'Jump', 'Talk', 'At Rest'],
];

const HERO_ACTION_MOTIFS: string[][] = [
  ['Think', 'Greet', 'Karate Kick', 'At Rest'],
  ['Talk', 'Jump', 'Greet', 'At Rest'],
];

function isLocomotionActionName(name?: string): boolean {
  return /\b(walk|run|sneak|crawl|fly)\b/i.test(name || '');
}

function isRestActionName(name?: string): boolean {
  return /^(?:at rest|none|idle)?$/i.test((name || '').trim());
}

export function refineTrained3dmmChoreography(
  rawScenes: AiMoviePlan['scenes'],
  prompt: string,
  catalogScenes: CatalogSceneItem[],
  soundCatalog: CatalogSoundItem[]
): void {
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) return;

  const allowSlowUser =
    /\b(slow|slowly|snail|turtle|sloth|creep|tiptoe|gentle|gently|gradual|drift)\b/i.test(
      prompt || ''
    );
  const soundCatByName = new Map<string, CatalogSoundItem>();
  for (const s of soundCatalog || []) {
    soundCatByName.set(s.name.trim().toLowerCase(), s);
  }

  for (let sIdx = 0; sIdx < rawScenes.length; sIdx++) {
    const sp = rawScenes[sIdx];
    const totalFrames = Math.round(clamp(sp.durationFrames || 54, 12, 360));
    const matchedBg = findSceneMatch(sp.sceneName, catalogScenes);
    const viewCount = Math.max(1, matchedBg.views.length);

    // 1) Corpus-trained camera cut rhythm (every ~12-20f across multi-view scenes)
    const isSpecialPaletteBg = /ge-black/i.test(matchedBg.name);
    const existingCuts = [...(sp.cameraCuts || [])]
      .map((c) => ({
        frame: Math.round(clamp(c.frame ?? 0, 0, totalFrames)),
        viewIndex: Math.round(clamp(c.viewIndex ?? 0, 0, viewCount - 1)),
      }))
      .sort((a, b) => a.frame - b.frame);

    if (existingCuts.length === 0 || existingCuts[0].frame > 0) {
      existingCuts.unshift({ frame: 0, viewIndex: existingCuts[0]?.viewIndex ?? 0 });
    }
    if (!isSpecialPaletteBg && viewCount > 1 && totalFrames >= 30 && existingCuts.length < 2) {
      const targetCutCount = Math.min(4, Math.max(2, Math.floor(totalFrames / 18) + 1));
      const step = Math.round(clamp(totalFrames / targetCutCount, 12, 22));
      const baseView = existingCuts[0].viewIndex;
      const mergedByFrame = new Map<number, number>();
      for (const c of existingCuts) mergedByFrame.set(c.frame, c.viewIndex);
      for (let k = 1; k < targetCutCount; k++) {
        const f = Math.round(k * step);
        if (f >= 8 && f <= totalFrames - 5 && !mergedByFrame.has(f)) {
          mergedByFrame.set(f, (baseView + k) % viewCount);
        }
      }
      sp.cameraCuts = Array.from(mergedByFrame.entries())
        .map(([frame, viewIndex]) => ({ frame, viewIndex }))
        .sort((a, b) => a.frame - b.frame);
    } else {
      sp.cameraCuts = existingCuts;
    }

    const actors = sp.actors || [];
    if (actors.length === 0) continue;

    // 2) Ensure valid sorted keyframes and de-stack overlapping initial/crowd stage slots
    for (let aIdx = 0; aIdx < actors.length; aIdx++) {
      const ap = actors[aIdx];
      if (!Array.isArray(ap.keyframes) || ap.keyframes.length === 0) {
        const slotX = Number(((aIdx - (actors.length - 1) * 0.5) * 3.0).toFixed(2));
        ap.keyframes = [{ frame: 0, x: slotX, y: 0, z: -1.5 - (aIdx % 3) * 1.6, rotY: 0 }];
      }
      ap.keyframes.sort((a, b) => a.frame - b.frame);
      ap.actionSegments = [...(ap.actionSegments || [])]
        .map((seg) => ({
          frame: Math.round(clamp(seg.frame ?? 0, 0, totalFrames)),
          actionName: (seg.actionName || 'At Rest').trim() || 'At Rest',
        }))
        .sort((a, b) => a.frame - b.frame);
    }

    const occupiedStartSpots: Array<{ x: number; z: number }> = [];
    for (let aIdx = 0; aIdx < actors.length; aIdx++) {
      const ap = actors[aIdx];
      const kfs = ap.keyframes!;
      const firstVis = kfs.find((k) => k.visible !== false) || kfs[0];
      const lastVis = [...kfs].reverse().find((k) => k.visible !== false) || kfs[kfs.length - 1];
      const tooClose = occupiedStartSpots.some(
        (p) => Math.hypot(p.x - firstVis.x, p.z - firstVis.z) < 1.65
      );
      if (tooClose) {
        const tier = aIdx % 3; // 0: midground, 1: foreground, 2: background
        const depthTargetZ = tier === 1 ? 2.4 : tier === 2 ? -5.8 : -1.2;
        const sideSign = aIdx % 2 === 0 ? 1 : -1;
        const ringOffset = Math.floor(aIdx / 2) + 1;
        const targetX = Number(clamp(firstVis.x + sideSign * (1.8 + ringOffset * 1.4), -10.2, 10.2).toFixed(2));
        const targetZ = Number(clamp(depthTargetZ + ((aIdx % 5) - 2) * 0.55, -8.8, 5.4).toFixed(2));
        const dxShift = targetX - firstVis.x;
        const dzShift = targetZ - firstVis.z;
        const isStationary = Math.hypot(lastVis.x - firstVis.x, lastVis.z - firstVis.z) < 0.6;
        for (const k of kfs) {
          if (isStationary || Math.hypot(k.x - firstVis.x, k.z - firstVis.z) < 0.35) {
            k.x = Number(clamp(k.x + dxShift, -10.5, 10.5).toFixed(2));
            k.z = Number(clamp(k.z + dzShift, -9.2, 5.8).toFixed(2));
          }
        }
        occupiedStartSpots.push({ x: targetX, z: targetZ });
      } else {
        occupiedStartSpots.push({ x: firstVis.x, z: firstVis.z });
      }
    }

    // Collect scene speech & shock/SFX frames for dialogue & reaction sync
    const speechEvents: Array<{ frame: number; speaker?: string; isYell: boolean }> = [];
    for (const vp of sp.ttsVoices || []) {
      speechEvents.push({
        frame: Math.round(clamp(vp.frame ?? 0, 0, totalFrames)),
        speaker: vp.speaker,
        isYell: /!|nooo|aaah|whoa|stop|hurry|help/i.test(vp.text || ''),
      });
    }
    const shockFrames: number[] = [];
    for (const ac of sp.audioCues || []) {
      const f = Math.round(clamp(ac.frame ?? 0, 0, totalFrames));
      const low = (ac.soundName || '').trim().toLowerCase();
      const cat = soundCatByName.get(low);
      if (cat?.category === 'speech') {
        speechEvents.push({
          frame: f,
          isYell: /nooo|aaah|whoa|stop|watch out|oh no|help|get him/i.test(low),
        });
      }
      if (/explosion|bang|crash|scream|owl|siren|thunder|surprise|oh no|watch out|zap|monster/i.test(low)) {
        shockFrames.push(f);
      }
    }

    // Hero prop action enrichment + explosion shock frames
    for (const pp of sp.props || []) {
      const pName = pp.name || '';
      const segs = (pp.actionSegments = pp.actionSegments || []);
      const pkfs = pp.keyframes || [];
      if (/explosio/i.test(pName)) {
        const hasBang = segs.some((s) => /bang|grow/i.test(s.actionName || ''));
        const bangF = Math.round(clamp(pp.startFrame ?? Math.round(totalFrames * 0.45), 0, Math.max(0, totalFrames - 4)));
        if (!hasBang) {
          segs.push({ frame: bangF, actionName: 'Bang!' });
        }
        if (pp.startFrame === undefined && totalFrames >= 24 && !pkfs.some((k) => k.visible === false)) {
          const ref = pkfs[0] || { frame: 0, x: 0, y: 0, z: -1, rotY: 0 };
          pp.startFrame = bangF;
          pp.endFrame = Math.min(totalFrames, bangF + 10);
          if (pkfs.length === 1) {
            pkfs.push({ ...ref, frame: bangF });
          }
        }
        shockFrames.push(bangF);
      } else if (/rocket/i.test(pName) && pkfs.length >= 2) {
        if (!segs.some((s) => /fly/i.test(s.actionName || ''))) {
          segs.push({ frame: 0, actionName: 'Fly' });
        }
      } else if (/safe|chest|coffin/i.test(pName)) {
        if (segs.length === 0 || segs.every((s) => isRestActionName(s.actionName))) {
          segs.push({ frame: Math.round(clamp(totalFrames * 0.25, 2, Math.max(2, totalFrames - 6))), actionName: 'Open and Close' });
        }
      }
    }

    // 3) Break lazy 0->dur slides, enrich static statues with multi-beat corpus chains, face partners
    const findPartnerPos = (selfIdx: number, refFrame: number) => {
      const selfKfs = actors[selfIdx].keyframes!;
      const selfPt =
        [...selfKfs].reverse().find((k) => k.frame <= refFrame && k.visible !== false) ||
        selfKfs.find((k) => k.visible !== false) ||
        selfKfs[0];
      let bestDist = Infinity;
      let bestPt: { x: number; z: number } | null = null;
      for (let o = 0; o < actors.length; o++) {
        if (o === selfIdx) continue;
        const okfs = actors[o].keyframes!;
        const opt =
          [...okfs].reverse().find((k) => k.frame <= refFrame && k.visible !== false) ||
          okfs.find((k) => k.visible !== false);
        if (!opt) continue;
        const d = Math.hypot(opt.x - selfPt.x, opt.z - selfPt.z);
        if (d > 0.3 && d < bestDist) {
          bestDist = d;
          bestPt = opt;
        }
      }
      return bestPt ? Math.atan2(bestPt.x - selfPt.x, bestPt.z - selfPt.z) : null;
    };

    for (let aIdx = 0; aIdx < actors.length; aIdx++) {
      const ap = actors[aIdx];
      const kfs = ap.keyframes!;
      const segs = ap.actionSegments!;
      const visStart = Math.round(clamp(ap.startFrame ?? (kfs.find((k) => k.visible !== false)?.frame ?? 0), 0, totalFrames - 2));
      const visEnd = Math.round(clamp(ap.endFrame ?? totalFrames, visStart + 2, totalFrames));
      const span = visEnd - visStart;

      const isPet = /\b(cathy|sasha|fabrice)\b/i.test(`${ap.name} ${ap.customName || ''}`);
      const isHero = /\b(henry|wanda|crash)\b/i.test(`${ap.name} ${ap.customName || ''}`);
      const motifPool = isPet ? PET_EXPRESSIVE_MOTIFS : isHero ? HERO_ACTION_MOTIFS : CORPUS_EXPRESSIVE_MOTIFS;
      const motif = motifPool[(sIdx + aIdx) % motifPool.length];

      const visibleKfs = kfs.filter((k) => k.visible !== false);
      const firstKf = visibleKfs[0] || kfs[0];
      const lastKf = visibleKfs[visibleKfs.length - 1] || kfs[kfs.length - 1];
      const totalHoriz = Math.hypot(lastKf.x - firstKf.x, lastKf.z - firstKf.z);
      const totalVert = Math.abs(lastKf.y - firstKf.y);

      const distinctNonRestCount = new Set(
        segs.map((s) => s.actionName.trim().toLowerCase()).filter((nm) => !isRestActionName(nm))
      ).size;

      // Case A: Full-scene lazy single linear slide (2 visible keyframes spanning >=75% of visibility window)
      if (
        !allowSlowUser &&
        visibleKfs.length === 2 &&
        totalHoriz >= 1.6 &&
        lastKf.frame - firstKf.frame >= Math.max(24, span * 0.72) &&
        span >= 24
      ) {
        const stagger = aIdx === 0 || span < 30 ? 0 : Math.min((aIdx % 4) * 3, Math.floor(span * 0.22));
        const departF = Math.min(visEnd - 12, firstKf.frame + stagger);
        const travelDur = Math.round(
          clamp(totalHoriz / 0.56, 7, Math.min(15, Math.max(8, Math.floor((visEnd - departF) * 0.44))))
        );
        const arriveF = Math.min(visEnd - 6, departF + travelDur);
        const travelYaw = Number(Math.atan2(lastKf.x - firstKf.x, lastKf.z - firstKf.z).toFixed(3));
        const startAct =
          segs.find((s) => isLocomotionActionName(s.actionName))?.actionName ||
          (firstKf.y > 1.2 || lastKf.y > 1.2 ? 'Fly' : totalHoriz / travelDur >= 1.3 ? 'Run' : 'Walk Fast');

        const nextKfs: AiKeyframePlan[] = [];
        if (departF > firstKf.frame) {
          nextKfs.push({ ...firstKf, frame: firstKf.frame, rotY: travelYaw });
          nextKfs.push({ ...firstKf, frame: departF, rotY: travelYaw });
        } else {
          nextKfs.push({ ...firstKf, frame: firstKf.frame, rotY: travelYaw });
        }
        nextKfs.push({ ...lastKf, frame: arriveF, rotY: travelYaw });
        ap.keyframes = nextKfs;

        // Turn toward partner after arriving
        const partnerYaw = findPartnerPos(aIdx, arriveF + 2);
        const endYaw = partnerYaw !== null ? Number(partnerYaw.toFixed(3)) : travelYaw;
        nextKfs.push({ ...lastKf, frame: visEnd, rotY: endYaw });

        const nextSegs: AiActionSegmentPlan[] = [];
        if (departF > visStart) {
          nextSegs.push({ frame: visStart, actionName: 'At Rest' });
        }
        nextSegs.push({ frame: departF, actionName: startAct });
        const holdLen = visEnd - arriveF;
        if (holdLen >= 16) {
          nextSegs.push({ frame: arriveF, actionName: motif[0] });
          nextSegs.push({ frame: Math.min(visEnd - 4, arriveF + 7), actionName: motif[1] });
          nextSegs.push({ frame: Math.min(visEnd - 1, arriveF + 15), actionName: motif[3] });
        } else {
          nextSegs.push({ frame: arriveF, actionName: motif[0] });
          if (holdLen >= 9) {
            nextSegs.push({ frame: visEnd - 3, actionName: 'At Rest' });
          }
        }
        ap.actionSegments = nextSegs;
      } else if (!allowSlowUser && distinctNonRestCount <= 1 && span >= 24) {
        // Case B & C: Moving actors missing post-stop acting OR stationary statues stuck on 1 action
        // Stagger crowd entrances on dense casts when safe
        const hasEarlySpeech = speechEvents.some((ev) => ev.frame <= 6);
        if (actors.length > 5 && aIdx >= 4 && ap.startFrame === undefined && totalFrames >= 36 && !hasEarlySpeech && totalHoriz < 0.6) {
          ap.startFrame = Math.min(Math.floor(totalFrames * 0.25), (aIdx - 3) * 3);
        }

        const effectiveStart = Math.max(visStart, ap.startFrame ?? visStart);
        // Find stationary hold window to populate with 3-beat expressive chain
        let moveEndF = effectiveStart;
        for (let i = 1; i < visibleKfs.length; i++) {
          if (Math.hypot(visibleKfs[i].x - visibleKfs[i - 1].x, visibleKfs[i].z - visibleKfs[i - 1].z) > 0.45) {
            moveEndF = Math.max(moveEndF, visibleKfs[i].frame);
          }
        }

        // Face partner on stationary segments if still frozen at rotY=0
        if (totalHoriz < 0.6) {
          const partnerYaw = findPartnerPos(aIdx, effectiveStart);
          if (partnerYaw !== null && Math.abs(firstKf.rotY) < 0.08) {
            for (const k of kfs) {
              k.rotY = Number(partnerYaw.toFixed(3));
            }
          }
        } else {
          const partnerYaw = findPartnerPos(aIdx, moveEndF + 1);
          if (partnerYaw !== null && Math.abs(lastKf.rotY) < 0.08) {
            lastKf.rotY = Number(partnerYaw.toFixed(3));
          }
        }

        const beatStart = moveEndF > effectiveStart ? moveEndF : effectiveStart + ((aIdx % 3) * 2);
        const avail = visEnd - beatStart;
        if (avail >= 16) {
          const step = Math.round(clamp(avail / 3.4, 7, 13));
          const merged = [...(ap.actionSegments || [])];
          const addIfClear = (f: number, act: string) => {
            if (f < effectiveStart || f >= visEnd) return;
            if (!merged.some((s) => Math.abs(s.frame - f) <= 3)) {
              merged.push({ frame: f, actionName: act });
            }
          };
          addIfClear(beatStart, motif[0]);
          addIfClear(beatStart + step, motif[1]);
          if (avail >= 24) addIfClear(beatStart + step * 2, motif[2]);
          addIfClear(Math.min(visEnd - 2, beatStart + step * 3), 'At Rest');
          ap.actionSegments = merged.sort((a, b) => a.frame - b.frame);
        }
      }
    }

    // 4) Sync speech audio / TTS cues with Talk/Yell & sync explosion/shock SFX with reactions
    const isActorMovingAt = (ap: NonNullable<AiMoviePlan['scenes'][number]['actors']>[number], frame: number) => {
      const kfs = ap.keyframes || [];
      for (let i = 0; i < kfs.length - 1; i++) {
        if (frame >= kfs[i].frame && frame < kfs[i + 1].frame) {
          if (Math.hypot(kfs[i + 1].x - kfs[i].x, kfs[i + 1].z - kfs[i].z) > 0.6) return true;
        }
      }
      return false;
    };

    for (let sE = 0; sE < speechEvents.length; sE++) {
      const ev = speechEvents[sE];
      let targetIdx = -1;
      if (ev.speaker) {
        const spkLow = ev.speaker.trim().toLowerCase();
        targetIdx = actors.findIndex(
          (a) =>
            (a.customName || '').toLowerCase().includes(spkLow) ||
            a.name.toLowerCase().includes(spkLow) ||
            spkLow.includes(a.name.toLowerCase())
        );
      }
      if (targetIdx < 0) targetIdx = sE % actors.length;
      const targetActor = actors[targetIdx];
      if (!targetActor || isActorMovingAt(targetActor, ev.frame)) continue;

      const segs = (targetActor.actionSegments = targetActor.actionSegments || []);
      const talkAct = ev.isYell ? 'Yell' : 'Talk';
      const existingAtEv = segs.find((s) => Math.abs(s.frame - ev.frame) <= 2);
      if (existingAtEv) {
        if (!isLocomotionActionName(existingAtEv.actionName)) {
          existingAtEv.actionName = talkAct;
        }
      } else {
        segs.push({ frame: ev.frame, actionName: talkAct });
      }
      const restAt = Math.min(totalFrames - 1, ev.frame + 10);
      if (
        restAt > ev.frame + 5 &&
        !segs.some((s) => s.frame > ev.frame && s.frame <= restAt + 2) &&
        !isActorMovingAt(targetActor, restAt)
      ) {
        segs.push({ frame: restAt, actionName: 'At Rest' });
      }
      segs.sort((a, b) => a.frame - b.frame);
    }

    for (let rIdx = 0; rIdx < shockFrames.length; rIdx++) {
      const rf = Math.min(totalFrames - 4, shockFrames[rIdx] + 1);
      const reactor = actors[(rIdx + (actors.length > 1 ? 1 : 0)) % actors.length];
      if (!reactor || isActorMovingAt(reactor, rf)) continue;
      const segs = (reactor.actionSegments = reactor.actionSegments || []);
      const reactAct = rIdx % 2 === 0 ? 'Jump' : 'Faint';
      if (!segs.some((s) => Math.abs(s.frame - rf) <= 2)) {
        segs.push({ frame: rf, actionName: reactAct });
        const settleF = Math.min(totalFrames - 1, rf + 9);
        if (settleF > rf + 4 && !segs.some((s) => s.frame > rf && s.frame <= settleF + 2)) {
          segs.push({ frame: settleF, actionName: 'At Rest' });
        }
        segs.sort((a, b) => a.frame - b.frame);
      }
    }
  }
}

async function requestAiMoviePlan(
  prompt: string,
  catalogSummary: CatalogSummaryPayload,
  directorName?: string
): Promise<AiMoviePlan> {
  const trimmedDirector = directorName?.trim();
  const res = await fetch('/api/ai/generate-movie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      catalogSummary,
      ...(trimmedDirector ? { directorName: trimmedDirector } : {}),
    }),
  });

  const contentType = res.headers.get('content-type') || '';
  const isJson = /application\/json/i.test(contentType);
  const payload = isJson
    ? ((await res.json().catch(() => ({}))) as {
        moviePlan?: AiMoviePlan;
        error?: string;
      })
    : {};

  if (res.ok && payload.moviePlan) {
    return payload.moviePlan;
  }

  if (res.status === 405) {
    throw new Error(
      'AI Movie Generator endpoint returned HTTP 405 (Method Not Allowed). Start the app with its Node/Express server (`npm run dev` or `npm start`) rather than static-only hosting.'
    );
  }

  throw new Error(
    payload.error ||
      `AI Movie Generator server request failed (${res.status}). Ensure GEMINI_API_KEY is configured in Settings > Secrets.`
  );
}

export async function generateAiMovie(options: {
  prompt: string;
  catalog: ThreeDmmCatalog;
  soundCatalog: CatalogSoundItem[];
  directorName?: string;
}): Promise<Movie> {
  const { prompt, catalog, soundCatalog, directorName } = options;
  if (catalog.scenes.length === 0 || catalog.actors.length === 0) {
    throw new Error('3D Movie Maker catalog is still loading. Please wait a moment and try again.');
  }

  const pickedSounds = pickCuratedSounds(prompt, soundCatalog);
  const specialPropActions: Record<string, string[]> = {};
  for (const p of catalog.props) {
    if (/rocket/i.test(p.name)) specialPropActions[p.name] = ['Fly'];
    else if (/coffin|safe|chest/i.test(p.name)) specialPropActions[p.name] = ['Open and Close'];
    else if (/explosio/i.test(p.name)) specialPropActions[p.name] = ['Bang!', 'Grow Fast'];
  }

  const catalogSummary: CatalogSummaryPayload = {
    scenes: catalog.scenes.map((s) => ({ name: s.name, viewCount: Math.max(1, s.views.length) })),
    actors: catalog.actors.map((a) => a.name),
    commonActorActions: COMMON_ACTOR_ACTIONS,
    props: catalog.props.map((p) => p.name),
    commonPropActions: COMMON_PROP_ACTIONS,
    specialPropActions,
    tdtFonts: TDF_FONT_OPTIONS.map((f) => f.name),
    tdtShapes: TDT_SHAPE_OPTIONS.map((s) => s.name),
    tdtActions: [...TDT_ACTIONS],
    fonts2d: FONT_2D_LIST,
    transitions: ['cut', 'dissolve', 'fadeToBlack', 'fadeToWhite'],
    sounds: pickedSounds.map((s) => {
      const label = getSoundSourceLabel(s);
      return {
        name: s.name,
        category: s.category,
        ...(label ? { sourceLabel: label } : {}),
        ...(s.isMidi ? { isMidi: true } : {}),
      };
    }),
  };

  const plan = await requestAiMoviePlan(prompt, catalogSummary, directorName);
  const rawScenes = plan.scenes || [];
  diversifyAiMovieBlocking(rawScenes, prompt);
  refineTrained3dmmChoreography(rawScenes, prompt, catalog.scenes, soundCatalog);

  // Intercept any ttsVoices lines that already exist in SOUND.3TH SVTH or .3MM sample movies so real recorded voices play instead of TTS!
  for (const sp of rawScenes) {
    if (!Array.isArray(sp.ttsVoices) || sp.ttsVoices.length === 0) continue;
    const keptTts: NonNullable<typeof sp.ttsVoices> = [];
    const audioList = (sp.audioCues = sp.audioCues || []);
    for (const vp of sp.ttsVoices) {
      const existingMatch = findMatchingExistingVoice(vp.text || '', soundCatalog);
      if (existingMatch) {
        const f = Math.round(clamp(vp.frame ?? 0, 0, Math.max(12, sp.durationFrames || 54)));
        if (!audioList.some((ac) => ac.frame === f && ac.soundName.toLowerCase() === existingMatch.name.toLowerCase())) {
          audioList.push({ frame: f, soundName: existingMatch.name, loop: false });
        }
      } else {
        keptTts.push(vp);
      }
    }
    sp.ttsVoices = keptTts;
  }

  // Ensure every generated movie actively incorporates real MIDIs & SFX/voices from other .3MM movies (without repeating 1 MIDI everywhere)
  const midiPool = pickedSounds.filter(
    (s) => s.category === 'music' && Boolean(SAMPLE_MOVIE_AUDIO_SOURCES[s.name.trim().toLowerCase()] || s.midiFileUrl)
  );
  const fallbackMidiPool = midiPool.length > 0 ? midiPool : pickedSounds.filter((s) => s.category === 'music');
  const sfxCustomPool = pickedSounds.filter((s) => s.category === 'sfx' && Boolean(s.sampleFile || SAMPLE_MOVIE_AUDIO_SOURCES[s.name.trim().toLowerCase()]));

  let customMovieSfxUsed = 0;
  let lastSceneMidiName = '';
  for (let sIdx = 0; sIdx < rawScenes.length; sIdx++) {
    const sp = rawScenes[sIdx];
    const audioList = (sp.audioCues = sp.audioCues || []);
    const midiCues = audioList.filter((ac) => {
      const low = (ac.soundName || '').trim().toLowerCase();
      return soundCatalog.some((s) => s.category === 'music' && s.name.toLowerCase() === low);
    });
    for (const ac of audioList) {
      const low = (ac.soundName || '').trim().toLowerCase();
      const hit = soundCatalog.find((s) => s.name.toLowerCase() === low);
      if (hit && hit.category !== 'music' && (hit.sampleFile || SAMPLE_MOVIE_AUDIO_SOURCES[low])) {
        customMovieSfxUsed++;
      }
    }

    if (midiCues.length === 0 && fallbackMidiPool.length > 0) {
      const chosenMidi =
        sIdx === rawScenes.length - 1
          ? fallbackMidiPool.find((m) => /happy end|triumph|heroic|victory/i.test(m.name)) ||
            fallbackMidiPool[(sIdx * 3) % fallbackMidiPool.length]
          : fallbackMidiPool[(sIdx * 3) % fallbackMidiPool.length];
      if (chosenMidi) {
        audioList.push({ frame: 0, soundName: chosenMidi.name, loop: true });
        lastSceneMidiName = chosenMidi.name.toLowerCase();
      }
    } else if (midiCues.length > 0) {
      const firstMidi = midiCues[0].soundName.trim().toLowerCase();
      if (firstMidi === lastSceneMidiName && fallbackMidiPool.length > 1 && sIdx > 0) {
        const alt =
          fallbackMidiPool.find((m) => m.name.toLowerCase() !== firstMidi) || fallbackMidiPool[0];
        if (alt) {
          midiCues[0].soundName = alt.name;
          lastSceneMidiName = alt.name.toLowerCase();
        }
      } else {
        lastSceneMidiName = firstMidi;
      }
    }
  }

  // If the AI produced zero SFX from other .3MM movies across the scenes, place fitting .3MM SFX on action scenes
  if (customMovieSfxUsed === 0 && sfxCustomPool.length > 0) {
    const targetScenes = rawScenes.slice(1, Math.max(2, rawScenes.length - 1));
    targetScenes.slice(0, 3).forEach((sp, idx) => {
      const audioList = (sp.audioCues = sp.audioCues || []);
      const dur = Math.max(18, sp.durationFrames || 48);
      const beatFrame = Math.min(dur - 2, Math.max(4, Math.round(dur * 0.45)));
      const sfx = sfxCustomPool[(idx * 2) % sfxCustomPool.length];
      if (sfx) {
        audioList.push({ frame: beatFrame, soundName: sfx.name, loop: false });
      }
    });
  }

  // Parallel pre-hydration of TDT swatches, unique TMPLS.3CN templates, and all matched sounds (SNDS, .3MM custom)
  const matchedActorsMap = new Map<string, CatalogActorItem>();
  const matchedPropsMap = new Map<string, CatalogPropItem>();
  const neededTmpls = new Set<number>();
  const matchedSoundsByName = new Map<string, CatalogSoundItem>();
  const neededSoundItems = new Map<number, CatalogSoundItem>();

  for (const sp of rawScenes) {
    for (const ap of sp.actors || []) {
      const catActor = findActorMatch(ap.name, catalog.actors);
      matchedActorsMap.set(ap.name, catActor);
      neededTmpls.add(catActor.tmplCno);
    }
    for (const pp of sp.props || []) {
      const catProp = findPropMatch(pp.name, catalog.props);
      matchedPropsMap.set(pp.name, catProp);
      neededTmpls.add(catProp.tmplCno);
    }
    for (const ac of sp.audioCues || []) {
      const cleanName = (ac.soundName || '').trim().toLowerCase();
      if (!cleanName || matchedSoundsByName.has(cleanName)) continue;
      const match =
        pickedSounds.find((s) => s.name.toLowerCase() === cleanName) ||
        soundCatalog.find((s) => s.name.toLowerCase() === cleanName) ||
        soundCatalog.find(
          (s) => s.name.toLowerCase().includes(cleanName) || cleanName.includes(s.name.toLowerCase())
        );
      if (match) {
        matchedSoundsByName.set(cleanName, match);
        neededSoundItems.set(match.cno, match);
      }
    }
  }

  const templateCache = new Map<number, ParsedTemplate>();
  const soundCache = new Map<
    number,
    { audioData: string; midiData?: string; isMidi: boolean; isCustomAudio?: boolean }
  >();

  const allowBonziExplicit = /\bbonzi\b/i.test(prompt || '');
  const speakerVoiceMap = new Map<string, { voice: string; pitch: number; speed: number }>();
  let bonziSpeakersCount = 0;
  let poolCursor = 0;
  const pickNextDiversePreset = (speakerKey: string) => {
    const preferFemale = FEMALE_HINT_RE.test(speakerKey);
    const candidates = preferFemale
      ? DIVERSE_SAPI4_VOICES.filter((v) => v.isFemale)
      : DIVERSE_SAPI4_VOICES;
    const chosen = candidates[poolCursor % candidates.length];
    poolCursor++;
    return { voice: chosen.voice, pitch: chosen.pitch, speed: chosen.speed };
  };

  const resolvedTtsByLine = new Map<
    string,
    { voice: string; pitch?: number; speed?: number }
  >();
  const ttsTasks: Array<{
    key: string;
    text: string;
    voice: string;
    pitch?: number;
    speed?: number;
  }> = [];
  const seenTtsKeys = new Set<string>();
  for (let sIdx = 0; sIdx < rawScenes.length; sIdx++) {
    const sp = rawScenes[sIdx];
    for (let vIdx = 0; vIdx < (sp.ttsVoices || []).length; vIdx++) {
      const vp = sp.ttsVoices![vIdx];
      const text = (vp.text || '').trim().slice(0, 220);
      if (!text) continue;

      const speakerKey = (vp.speaker || `speaker_${sIdx}_${vIdx}`).trim().toLowerCase();
      let chosenVoice = (vp.voice || '').trim();
      let chosenPitch = vp.pitch;
      let chosenSpeed = vp.speed;

      const cachedSpeaker = speakerVoiceMap.get(speakerKey);
      if (cachedSpeaker) {
        chosenVoice = cachedSpeaker.voice;
        if (chosenPitch === undefined) chosenPitch = cachedSpeaker.pitch;
        if (chosenSpeed === undefined) chosenSpeed = cachedSpeaker.speed;
      } else {
        if (!chosenVoice) {
          const picked = pickNextDiversePreset(speakerKey);
          chosenVoice = picked.voice;
          chosenPitch = chosenPitch ?? picked.pitch;
          chosenSpeed = chosenSpeed ?? picked.speed;
        } else if (isBonziVoiceName(chosenVoice) && !allowBonziExplicit) {
          if (bonziSpeakersCount >= 1) {
            const picked = pickNextDiversePreset(speakerKey);
            chosenVoice = picked.voice;
            chosenPitch = picked.pitch;
            chosenSpeed = picked.speed;
          } else {
            bonziSpeakersCount++;
          }
        }
        speakerVoiceMap.set(speakerKey, {
          voice: chosenVoice,
          pitch: chosenPitch ?? 120,
          speed: chosenSpeed ?? 155,
        });
      }

      const lineRefId = `${sIdx}:${vIdx}`;
      resolvedTtsByLine.set(lineRefId, {
        voice: chosenVoice,
        pitch: chosenPitch,
        speed: chosenSpeed,
      });

      const key = `${chosenVoice}|${chosenPitch ?? ''}|${chosenSpeed ?? ''}|${text}`;
      if (seenTtsKeys.has(key)) continue;
      seenTtsKeys.add(key);
      ttsTasks.push({ key, text, voice: chosenVoice, pitch: chosenPitch, speed: chosenSpeed });
    }
  }

  const ttsResultMap = new Map<
    string,
    { audioData: string; voice: string; pitch: number; speed: number }
  >();

  const runTtsBatch = async () => {
    const queue = [...ttsTasks];
    const workers = Array.from({ length: Math.min(4, Math.max(1, queue.length)) }, async () => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) break;
        try {
          const res = await synthesizeSapi4Tts({
            text: task.text,
            voice: task.voice,
            pitch: task.pitch,
            speed: task.speed,
          });
          ttsResultMap.set(task.key, res);
        } catch (err) {
          console.warn('SAPI4 TTS synthesis failed for line:', task.text, err);
        }
      }
    });
    await Promise.all(workers);
  };

  const [swatches] = await Promise.all([
    loadTdtMaterialSwatches().catch(() => []),
    runTtsBatch(),
    ...Array.from(neededTmpls).map(async (tmplCno) => {
      try {
        const tmpl = await loadTemplate(tmplCno);
        templateCache.set(tmplCno, tmpl);
      } catch {
        // ignore missing template cache miss
      }
    }),
    ...Array.from(neededSoundItems.values()).map(async (item) => {
      try {
        const extracted = await sound3DMM.extractSoundItemCueData(item);
        if (extracted) soundCache.set(item.cno, extracted);
      } catch {
        // ignore missing audio cache miss
      }
    }),
  ]);

  const solidTdtSwatches = swatches.filter((s) => !s.isTexture);
  const tdtPaletteSwatches = solidTdtSwatches.length > 0 ? solidTdtSwatches : swatches;

  const allowSlowUser =
    /\b(slow|slowly|snail|turtle|sloth|creep|tiptoe|gentle|gently|gradual|drift)\b/i.test(
      prompt || ''
    );

  const builtScenes: Scene[] = [];

  for (let sIdx = 0; sIdx < rawScenes.length; sIdx++) {
    const sp = rawScenes[sIdx];
    const matchedBg = findSceneMatch(sp.sceneName, catalog.scenes);
    const totalFrames = Math.round(clamp(sp.durationFrames || 54, 12, 360));
    const views = matchedBg.views;

    // Resolve camera cuts using authentic CAM chids (CatalogCameraView.icam)
    const cutByFrame = new Map<number, CameraCutEvent>();
    for (const c of sp.cameraCuts || []) {
      const f = Math.round(clamp(c.frame, 0, totalFrames));
      const vIdx = Math.round(clamp(c.viewIndex, 0, Math.max(0, views.length - 1)));
      const realIcam = views[vIdx]?.icam ?? 0;
      cutByFrame.set(f, { frame: f, icam: realIcam, yaw: 0, pitch: 0 });
    }
    if (!cutByFrame.has(0)) {
      const defaultIcam = views[0]?.icam ?? 0;
      cutByFrame.set(0, { frame: 0, icam: defaultIcam, yaw: 0, pitch: 0 });
    }
    const cameraCuts = Array.from(cutByFrame.values()).sort((a, b) => a.frame - b.frame);
    const initialIcam = cameraCuts[0].icam;

    // Resolve Actors + real TMPLS.3CN ACTNs + real CMTL costumes
    const actors: ActorEntity[] = [];
    for (let aIdx = 0; aIdx < (sp.actors || []).length; aIdx++) {
      const ap = sp.actors![aIdx];
      const catActor = matchedActorsMap.get(ap.name) || findActorMatch(ap.name, catalog.actors);
      const tmpl = templateCache.get(catActor.tmplCno) || null;

      const akfs: Record<number, ActionKeyframe> = {};
      for (const seg of ap.actionSegments || []) {
        const f = Math.round(clamp(seg.frame, 0, totalFrames));
        const resolved = tmpl
          ? resolveTemplateAction(tmpl, seg.actionName)
          : { anid: 0, name: seg.actionName || 'At Rest' };
        akfs[f] = { anid: resolved.anid, actionName: resolved.name };
      }
      if (!akfs[0]) {
        const firstAct = tmpl?.actions[0] || { anid: 0, name: 'At Rest' };
        akfs[0] = { anid: firstAct.anid, actionName: firstAct.name };
      }

      const defaultSlotX = (aIdx - ((sp.actors?.length || 1) - 1) * 0.5) * 4.0;
      const costumeCmids = resolveCostumeCmids(tmpl, ap.costumePreset);
      const remapActionMap = <T extends Record<number, unknown>>(
        mapObj: T,
        remap: Array<{ origF: number; newF: number }>
      ) => {
        if (remap.length === 0) return;
        const next: Record<number, unknown> = {};
        for (const [fKey, val] of Object.entries(mapObj)) {
          const fNum = Number(fKey);
          let mappedF = fNum;
          for (let r = 0; r < remap.length; r++) {
            if (fNum === remap[r].origF) {
              mappedF = remap[r].newF;
              break;
            }
            if (r + 1 < remap.length && fNum > remap[r].origF && fNum < remap[r + 1].origF) {
              const frac = (fNum - remap[r].origF) / Math.max(1, remap[r + 1].origF - remap[r].origF);
              mappedF = Math.round(remap[r].newF + frac * (remap[r + 1].newF - remap[r].newF));
              break;
            }
          }
          if (fNum > remap[remap.length - 1].origF) {
            const delta = fNum - remap[remap.length - 1].origF;
            mappedF = Math.min(totalFrames, remap[remap.length - 1].newF + delta);
          }
          next[mappedF] = val;
        }
        for (const k of Object.keys(mapObj)) delete mapObj[Number(k)];
        Object.assign(mapObj, next);
      };

      const actorKfs = buildEntityKeyframes(ap.keyframes, totalFrames, defaultSlotX, 0, {
        allowColor: false,
        startFrame: ap.startFrame,
        endFrame: ap.endFrame,
        isActor: true,
        entityName: catActor.name,
        allowSlowUser,
        actionMap: akfs,
        onRemapFrames: (remap) => remapActionMap(akfs, remap),
        onEnsureMoveLocomotion: (f0, f1, speed, dx, dy, dz, yStart, yEnd, rotYStart) => {
          const curAct = resolveActionNameAtFrame(akfs, f0);
          const horiz = Math.hypot(dx, dz);
          const pickMoveAct = () => {
            if (yStart > 1.2 || yEnd > 1.2 || (Math.abs(dy) > 1.4 && Math.abs(dy) > horiz * 0.6)) {
              return tmpl ? resolveTemplateAction(tmpl, 'Fly') : { anid: 0, name: 'Fly' };
            }
            if (horiz > 0.4) {
              const yaw = Math.atan2(dx, dz);
              // Check if intentionally backing up while facing opposite direction
              if (Math.cos(rotYStart - yaw) < -0.65 && horiz < 7) {
                const back = tmpl?.actions.find((a) => /walk backwards/i.test(a.name));
                if (back) return back;
              }
            }
            const target = speed >= 2.1 ? 'Run' : speed < 0.72 ? 'Walk Slowly' : 'Walk Fast';
            return tmpl ? resolveTemplateAction(tmpl, target) : { anid: 0, name: target };
          };
          // If still At Rest (or non-locomotion pose over a big move) at move start f0, switch immediately to matching locomotion
          const isAlreadyMovingAct = /walk|run|sneak|crawl|fly|jump|hop|fall/i.test(curAct);
          if (/^at rest$/i.test(curAct.trim()) || (!isAlreadyMovingAct && Math.hypot(dx, dy, dz) > 2.2)) {
            const moveAct = pickMoveAct();
            akfs[f0] = { anid: moveAct.anid, actionName: moveAct.name };
          }
          // Eliminate mid-move At Rest dropouts strictly inside (f0, f1): move to arrival f1
          for (const fkStr of Object.keys(akfs)) {
            const fk = Number(fkStr);
            if (fk > f0 && fk < f1 && /^at rest$/i.test(akfs[fk].actionName.trim())) {
              const stopped = akfs[fk];
              delete akfs[fk];
              if (!akfs[f1]) akfs[f1] = stopped;
            }
          }
        },
        onEnsureStopRest: (stopFrame, nextMoveFrame, yPos) => {
          const restAct =
            tmpl?.actions.find((a) => /^at rest$/i.test(a.name.trim())) ||
            tmpl?.actions.find((a) => /at rest/i.test(a.name)) ||
            tmpl?.actions[0] || { anid: 0, name: 'At Rest' };

          const isHorizLoco = (nm: string) =>
            /walk|run|sneak|crawl/i.test(nm) || (/fly/i.test(nm) && yPos <= 1.2);

          const curAtStop = resolveActionNameAtFrame(akfs, stopFrame);
          const hoveringInAir = /fly/i.test(curAtStop) && yPos > 1.2;
          if (/walk|run|sneak|crawl|fly/i.test(curAtStop) && !hoveringInAir) {
            akfs[stopFrame] = { anid: restAct.anid, actionName: restAct.name };
          }

          // Clear lingering ground locomotion inside the stationary window (stopFrame, stopLimit),
          // and clear delayed "At Rest" ONLY if no expressive acting beat ran before it.
          const stopLimit = nextMoveFrame ?? totalFrames + 1;
          for (const fkStr of Object.keys(akfs)
            .map(Number)
            .sort((a, b) => a - b)
            .map(String)) {
            const fk = Number(fkStr);
            if (fk > stopFrame && fk < stopLimit) {
              const nm = akfs[fk].actionName.trim();
              if (isHorizLoco(nm)) {
                delete akfs[fk];
              } else if (/^at rest$/i.test(nm)) {
                const prevNm = resolveActionNameAtFrame(akfs, fk - 1);
                if (/walk|run|sneak|crawl|fly|^at rest$/i.test(prevNm)) {
                  delete akfs[fk];
                }
              }
            }
          }
        },
        onEnsureStationaryRest: (f0, f1, yPos) => {
          const restAct =
            tmpl?.actions.find((a) => /^at rest$/i.test(a.name.trim())) ||
            tmpl?.actions.find((a) => /at rest/i.test(a.name)) ||
            tmpl?.actions[0] || { anid: 0, name: 'At Rest' };
          const isHorizLoco = (nm: string) =>
            /walk|run|sneak|crawl/i.test(nm) || (/fly/i.test(nm) && yPos <= 1.2);
          const curAtStart = resolveActionNameAtFrame(akfs, f0);
          if (isHorizLoco(curAtStart)) {
            akfs[f0] = { anid: restAct.anid, actionName: restAct.name };
          }
          for (const fkStr of Object.keys(akfs)) {
            const fk = Number(fkStr);
            if (fk > f0 && fk < f1) {
              const nm = akfs[fk].actionName.trim();
              if (isHorizLoco(nm)) {
                akfs[fk] = { anid: restAct.anid, actionName: restAct.name };
              }
            }
          }
        },
      });

      const displayActorName = (ap.customName || '').trim().slice(0, 48) || catActor.name;

      actors.push({
        id: `ai_actor_${sIdx}_${aIdx}_${Math.random().toString(36).slice(2, 6)}`,
        tmplCno: catActor.tmplCno,
        name: displayActorName,
        anid: akfs[0].anid,
        actionName: akfs[0].actionName,
        actionKeyframes: akfs,
        ...(costumeCmids ? { costumeCmids } : {}),
        keyframes: actorKfs,
      });
    }

    // Resolve Props + real TMPLS.3CN ACTNs + costumes + non-uniform stretch + restricted colorHex
    const props: PropEntity[] = [];
    for (let pIdx = 0; pIdx < (sp.props || []).length; pIdx++) {
      const pp = sp.props![pIdx];
      const catProp = matchedPropsMap.get(pp.name) || findPropMatch(pp.name, catalog.props);
      const tmpl = templateCache.get(catProp.tmplCno) || null;
      const canColorProp = isColorablePrimitiveProp(catProp.name);

      const pakfs: Record<number, PropActionKeyframe> = {};
      for (const seg of pp.actionSegments || []) {
        const f = Math.round(clamp(seg.frame, 0, totalFrames));
        const resolved = tmpl
          ? resolveTemplateAction(tmpl, seg.actionName)
          : { anid: undefined, name: seg.actionName || 'At Rest' };
        pakfs[f] = {
          action: resolved.name,
          ...(resolved.anid !== undefined ? { anid: resolved.anid } : {}),
        };
      }
      if (!pakfs[0]) {
        const firstAct = tmpl?.actions[0];
        pakfs[0] = {
          action: firstAct?.name || 'At Rest',
          ...(firstAct ? { anid: firstAct.anid } : {}),
        };
      }

      const costumeCmids = resolveCostumeCmids(tmpl, pp.costumePreset);
      const displayPropName = (pp.customName || '').trim().slice(0, 48) || catProp.name;

      props.push({
        id: `ai_prop_${sIdx}_${pIdx}_${Math.random().toString(36).slice(2, 6)}`,
        tmplCno: catProp.tmplCno,
        name: displayPropName,
        action: pakfs[0].action,
        ...(pakfs[0].anid !== undefined ? { anid: pakfs[0].anid } : {}),
        actionKeyframes: pakfs,
        ...(costumeCmids ? { costumeCmids } : {}),
        keyframes: buildEntityKeyframes(
          pp.keyframes,
          totalFrames,
          pIdx % 2 === 0 ? -4.5 : 4.5,
          -2,
          {
            colorHex: canColorProp ? pp.colorHex : undefined,
            allowColor: canColorProp,
            startFrame: pp.startFrame,
            endFrame: pp.endFrame,
            isActor: false,
            entityName: catProp.name,
            allowSlowUser,
            actionMap: pakfs,
          }
        ),
      });
    }

    // Resolve 3D TDT words with authentic actions, stretch/rotation, frame timing & optional keyframes
    const tdtTexts: TdtTextEntity[] = [];
    for (let tIdx = 0; tIdx < (sp.tdtTexts || []).length; tIdx++) {
      const tp = sp.tdtTexts![tIdx];
      const textVal = (tp.text || '').trim();
      if (!textVal) continue;
      const font =
        TDF_FONT_OPTIONS.find((f) => f.name.toLowerCase() === (tp.fontName || '').toLowerCase()) ||
        TDF_FONT_OPTIONS[0];
      const shape =
        TDT_SHAPE_OPTIONS.find((s) => s.name.toLowerCase() === (tp.shapeName || '').toLowerCase()) ||
        TDT_SHAPE_OPTIONS[0];
      const startF = Math.round(clamp(tp.startFrame ?? 0, 0, totalFrames));
      const endF = Math.round(clamp(tp.endFrame ?? totalFrames, startF, totalFrames));
      const baseSc = tp.scale !== undefined ? clamp(tp.scale, 0.05, 8.0) : 0.7;
      const sx = tp.scaleX !== undefined ? clamp(tp.scaleX, 0.05, 8.0) : baseSc;
      const sy = tp.scaleY !== undefined ? clamp(tp.scaleY, 0.05, 8.0) : baseSc;
      const sz = tp.scaleZ !== undefined ? clamp(tp.scaleZ, 0.05, 8.0) : baseSc;
      const tdtHex = validHex(tp.colorHex);
      const basePos: KeyframePosition = {
        x: clamp(tp.x, -30, 30),
        y: clamp(tp.y, -5, 22),
        z: clamp(tp.z, -30, 30),
        ...(tp.rotX !== undefined && Number.isFinite(tp.rotX) ? { rotX: tp.rotX } : {}),
        rotY: tp.rotY !== undefined && Number.isFinite(tp.rotY) ? tp.rotY : 0,
        ...(tp.rotZ !== undefined && Number.isFinite(tp.rotZ) ? { rotZ: tp.rotZ } : {}),
        scaleX: Number(sx.toFixed(3)),
        scaleY: Number(sy.toFixed(3)),
        scaleZ: Number(sz.toFixed(3)),
        visible: true,
        ...(tdtHex ? { color: tdtHex } : {}),
      };
      let kfs: Record<number, KeyframePosition> = {};
      if (Array.isArray(tp.keyframes) && tp.keyframes.length > 0) {
        const mappedTdtKfs: AiKeyframePlan[] = tp.keyframes.map((k) => ({
          ...k,
          scaleX: k.scaleX ?? (k.scale ?? sx),
          scaleY: k.scaleY ?? (k.scale ?? sy),
          scaleZ: k.scaleZ ?? (k.scale ?? sz),
          colorHex: k.colorHex ?? tdtHex,
        }));
        kfs = buildEntityKeyframes(mappedTdtKfs, totalFrames, basePos.x, basePos.z, {
          colorHex: tdtHex,
          startFrame: startF,
          endFrame: endF,
          isActor: false,
          entityName: 'tdt',
          allowSlowUser,
        });
      } else {
        if (startF > 0) {
          kfs[0] = { ...basePos, visible: false };
        }
        kfs[startF] = { ...basePos, visible: true };
        if (endF < totalFrames) {
          kfs[endF] = { ...basePos, visible: false };
        }
      }
      const matchedTdtAction = normalizeTdtActionName(tp.action);
      tdtTexts.push({
        id: `ai_tdt_${sIdx}_${tIdx}_${Math.random().toString(36).slice(2, 6)}`,
        text: textVal.slice(0, 28),
        tdfCno: font.tdfCno,
        tdts: shape.tdts,
        mtrlCno: tdtPaletteSwatches[tIdx % Math.max(1, tdtPaletteSwatches.length)]?.mtrlCno,
        action: matchedTdtAction,
        actionKeyframes: {
          [startF]: { action: matchedTdtAction },
        },
        keyframes: kfs,
      });
    }

    // Resolve 2D onscreen text boxes & slow scrolling credits with accurate fonts, bold/italic & transparent or solid colors
    const textBoxes: ScreenTextBox[] = [];
    for (let bIdx = 0; bIdx < (sp.textBoxes || []).length; bIdx++) {
      const bp = sp.textBoxes![bIdx];
      const txt = (bp.text || '').trim();
      if (!txt) continue;
      const startFrame = Math.round(clamp(bp.startFrame ?? 0, 0, totalFrames));
      const endFrame = Math.round(clamp(bp.endFrame ?? totalFrames, startFrame, totalFrames));
      const isScrolling = Boolean(bp.isScrolling);
      const rect = rectForPlacement(bp.placement, isScrolling);
      const reqFont = (bp.fontName || '').trim().replace(/['"]/g, '');
      const matchedFont =
        FONT_2D_LIST.find((f) => f.toLowerCase() === reqFont.toLowerCase()) ||
        (reqFont.length > 0 ? reqFont : 'Arial');
      const fontSize = Math.round(
        clamp(bp.fontSize ?? (isScrolling ? 16 : 16), 10, 44)
      );
      const rawBg = (bp.bgColorHex || '').trim().toLowerCase();
      const resolvedBg =
        !rawBg || rawBg === 'transparent' || rawBg === 'none' || rawBg === 'clear'
          ? undefined
          : validHex(bp.bgColorHex);
      textBoxes.push({
        id: `ai_tbox_${sIdx}_${bIdx}_${Math.random().toString(36).slice(2, 6)}`,
        text: txt,
        fontName: matchedFont,
        fontSize,
        color: validHex(bp.colorHex) || '#fef08a',
        ...(resolvedBg ? { bgColor: resolvedBg } : {}),
        bold: bp.bold !== undefined ? Boolean(bp.bold) : !bp.italic,
        ...(bp.italic !== undefined ? { italic: Boolean(bp.italic) } : {}),
        startFrame,
        endFrame,
        ...rect,
        isScrolling,
      });
    }

    // Populate pre-hydrated SNDS.3CN WAV, MIDS, and custom .3MM voices/SFX cues
    const audios: ImportedAudioCue[] = [];
    const usedAudioKeys = new Set<string>();
    const usedVoiceFrames = new Set<number>();
    for (let aIdx = 0; aIdx < (sp.audioCues || []).length; aIdx++) {
      const ac = sp.audioCues![aIdx];
      const cleanName = (ac.soundName || '').trim().toLowerCase();
      if (!cleanName) continue;
      const match = matchedSoundsByName.get(cleanName);
      if (!match) continue;
      const f = Math.round(clamp(ac.frame ?? 0, 0, totalFrames));
      const key = `${f}:${match.category === 'music' ? 'midi' : match.cno}`;
      if (usedAudioKeys.has(key)) continue;
      usedAudioKeys.add(key);

      const extracted = soundCache.get(match.cno);
      if (!extracted) continue;
      const waitSpeech = match.category === 'speech' && !match.isMidi;
      if (waitSpeech) usedVoiceFrames.add(f);
      audios.push({
        id: `ai_snd_${sIdx}_${aIdx}_${Math.random().toString(36).slice(2, 6)}`,
        frame: f,
        filename: match.name,
        audioData: extracted.audioData || '',
        midiData: extracted.midiData,
        isMidi: match.isMidi || extracted.isMidi,
        isCustomAudio: Boolean(extracted.isCustomAudio || match.midiFileUrl || match.sampleFile),
        loop: ac.loop ?? match.isMidi,
        ...(waitSpeech ? { waitForFinish: true } : {}),
        ...(match.msndCno >= 0 && !match.sampleFile ? { msndCno: match.msndCno } : {}),
      });
    }

    // Populate SAPI4 synthesized voice lines (varied voices, speed, pitch, waitForFinish; skip if unreachable after 10 retries)
    const indexedTts = (sp.ttsVoices || [])
      .map((vp, origIdx) => ({ vp, origIdx }))
      .sort((a, b) => (a.vp.frame ?? 0) - (b.vp.frame ?? 0));
    for (const { vp, origIdx } of indexedTts) {
      const text = (vp.text || '').trim().slice(0, 220);
      if (!text) continue;
      const resolved = resolvedTtsByLine.get(`${sIdx}:${origIdx}`);
      if (!resolved) continue;
      const key = `${resolved.voice}|${resolved.pitch ?? ''}|${resolved.speed ?? ''}|${text}`;
      const synth = ttsResultMap.get(key);
      if (!synth) continue;

      let f = Math.round(clamp(vp.frame ?? 0, 0, totalFrames));
      while (usedVoiceFrames.has(f) && f < totalFrames) {
        f++;
      }
      usedVoiceFrames.add(f);
      const speakerTag = vp.speaker ? `${vp.speaker.trim()}: ` : '';
      audios.push({
        id: `ai_tts_${sIdx}_${origIdx}_${Math.random().toString(36).slice(2, 6)}`,
        frame: f,
        filename: `${speakerTag}${text.slice(0, 28)}`,
        audioData: synth.audioData,
        isCustomAudio: true,
        waitForFinish: vp.waitForFinish !== false,
        ttsVoice: synth.voice,
        ttsPitch: synth.pitch,
        ttsSpeed: synth.speed,
      });
    }

    const sceneTransition = normalizeTransition(sp.transition);

    builtScenes.push({
      id: `ai_scene_${sIdx}_${Math.random().toString(36).slice(2, 6)}`,
      bkgdCno: matchedBg.bkgdCno,
      sceneName: matchedBg.name,
      icam: initialIcam,
      cameraAngle: { yaw: 0, pitch: 0 },
      cameraCuts,
      ...(sceneTransition ? { transition: sceneTransition } : {}),
      coordMode: 'stage',
      actors,
      props,
      tdtTexts: tdtTexts.length > 0 ? tdtTexts : undefined,
      textBoxes: textBoxes.length > 0 ? textBoxes : undefined,
      audios,
      totalFrames,
    });
  }

  if (builtScenes.length === 0) {
    throw new Error('Gemini returned a plan with no scenes.');
  }

  return {
    title: (plan.title || 'AI 3DMM Movie').trim(),
    plot: (plan.plot || '').trim() || undefined,
    scenes: builtScenes,
  };
}

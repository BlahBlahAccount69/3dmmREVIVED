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
      costumePreset?: number;
      colorHex?: string;
      startFrame?: number;
      endFrame?: number;
      actionSegments?: AiActionSegmentPlan[];
      keyframes?: AiKeyframePlan[];
    }[];
    props?: {
      name: string;
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
  /funny moment|happy end|triumph|danger|scare|tension|specter|quest|mystery|geist|bistro|villain/i,
  /explosion|rocket launch|owl hoot|thunder|siren|chuckle|laugh|crash|scream|applause|footstep|static/i,
  /surprise|oh no|hey|watch out|hurry|all right|yipee|worked|follow me|stop!|get him|creation|doggy|mega/i,
];

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
      if (
        p0.visible !== false &&
        p1.visible !== false &&
        !isSlowAct &&
        origSpan >= 14 &&
        dist >= 1.2 &&
        speed < 0.85
      ) {
        const targetSpeed = isFastSeg ? 2.4 : 1.5;
        stepSpan = Math.round(clamp(dist / targetSpeed, 3, Math.min(origSpan - 1, 18)));
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
      }
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

function pickCuratedSounds(prompt: string, soundCatalog: CatalogSoundItem[]): CatalogSoundItem[] {
  const promptTokens = (prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  const pickCategory = (category: 'music' | 'sfx' | 'speech', pattern: RegExp, limit: number) => {
    const pool = soundCatalog.filter((s) => s.category === category);
    const scored = pool
      .map((item) => {
        const hay = `${item.name} ${item.sourceLabel || ''}`.toLowerCase();
        let score = 0;
        if (item.midiFileUrl || item.sampleFile) score += 4;
        if (pattern.test(item.name)) score += 3;
        for (const tok of promptTokens) {
          if (hay.includes(tok)) score += 6;
        }
        return { item, score };
      })
      .sort((a, b) => b.score - a.score);

    const merged: CatalogSoundItem[] = [];
    const seen = new Set<number>();
    for (const { item } of scored) {
      if (seen.has(item.cno)) continue;
      seen.add(item.cno);
      merged.push(item);
      if (merged.length >= limit) break;
    }
    return merged;
  };

  return [
    ...pickCategory('music', SIGNATURE_SOUND_PATTERNS[0], 24),
    ...pickCategory('sfx', SIGNATURE_SOUND_PATTERNS[1], 24),
    ...pickCategory('speech', SIGNATURE_SOUND_PATTERNS[2], 32),
  ];
}

async function requestAiMoviePlan(
  prompt: string,
  catalogSummary: CatalogSummaryPayload
): Promise<AiMoviePlan> {
  const res = await fetch('/api/ai/generate-movie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, catalogSummary }),
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
}): Promise<Movie> {
  const { prompt, catalog, soundCatalog } = options;
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
    sounds: pickedSounds.map((s) => ({
      name: s.name,
      category: s.category,
      ...(s.sourceLabel ? { sourceLabel: s.sourceLabel } : {}),
      ...(s.isMidi ? { isMidi: true } : {}),
    })),
  };

  const plan = await requestAiMoviePlan(prompt, catalogSummary);
  const rawScenes = plan.scenes || [];

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
      const voice = (vp.voice || 'Adult Male #2, American English (TruVoice)').trim();
      const key = `${voice}|${vp.pitch ?? ''}|${vp.speed ?? ''}|${text}`;
      if (seenTtsKeys.has(key)) continue;
      seenTtsKeys.add(key);
      ttsTasks.push({ key, text, voice, pitch: vp.pitch, speed: vp.speed });
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
          const restAct = tmpl?.actions.find((a) => /^at rest$/i.test(a.name.trim())) ||
            tmpl?.actions.find((a) => /at rest/i.test(a.name)) ||
            tmpl?.actions[0] || { anid: 0, name: 'At Rest' };

          // Pull any delayed "At Rest" sitting a few frames after stopFrame right onto stopFrame
          const stopLimit = nextMoveFrame ?? totalFrames;
          for (const fkStr of Object.keys(akfs)) {
            const fk = Number(fkStr);
            if (fk > stopFrame && fk < stopLimit && /^at rest$/i.test(akfs[fk].actionName.trim())) {
              delete akfs[fk];
            }
          }

          const curAtStop = resolveActionNameAtFrame(akfs, stopFrame);
          const isLocomotion = /walk|run|sneak|crawl|fly|jump|hop/i.test(curAtStop);
          // Switch to At Rest at stopFrame whenever locomotion was running (unless flying high in air)
          const hoveringInAir = /fly/i.test(curAtStop) && yPos > 1.2;
          if (isLocomotion && !hoveringInAir) {
            akfs[stopFrame] = { anid: restAct.anid, actionName: restAct.name };
          }
        },
      });

      actors.push({
        id: `ai_actor_${sIdx}_${aIdx}_${Math.random().toString(36).slice(2, 6)}`,
        tmplCno: catActor.tmplCno,
        name: catActor.name,
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

      props.push({
        id: `ai_prop_${sIdx}_${pIdx}_${Math.random().toString(36).slice(2, 6)}`,
        tmplCno: catProp.tmplCno,
        name: catProp.name,
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

    // Populate BonziBuddy-TTS / SAPI4 synthesized voice lines (with speed, pitch, and waitForFinish)
    const sortedTts = [...(sp.ttsVoices || [])].sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
    for (let vIdx = 0; vIdx < sortedTts.length; vIdx++) {
      const vp = sortedTts[vIdx];
      const text = (vp.text || '').trim().slice(0, 220);
      if (!text) continue;
      const voice = (vp.voice || 'Adult Male #2, American English (TruVoice)').trim();
      const key = `${voice}|${vp.pitch ?? ''}|${vp.speed ?? ''}|${text}`;
      const synth = ttsResultMap.get(key);
      if (!synth) continue;

      let f = Math.round(clamp(vp.frame ?? 0, 0, totalFrames));
      while (usedVoiceFrames.has(f) && f < totalFrames) {
        f++;
      }
      usedVoiceFrames.add(f);
      const speakerTag = vp.speaker ? `${vp.speaker.trim()}: ` : '';
      audios.push({
        id: `ai_tts_${sIdx}_${vIdx}_${Math.random().toString(36).slice(2, 6)}`,
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

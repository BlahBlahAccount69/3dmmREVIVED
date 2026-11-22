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
import { CatalogSoundItem, sound3DMM } from './soundLibrary';

interface AiKeyframePlan {
  frame: number;
  x: number;
  y: number;
  z: number;
  rotY: number;
  rotZ?: number;
  scale?: number;
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
    cameraCuts?: { frame: number; viewIndex: number }[];
    actors?: {
      name: string;
      actionSegments?: AiActionSegmentPlan[];
      keyframes?: AiKeyframePlan[];
    }[];
    props?: {
      name: string;
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
      scale?: number;
    }[];
    textBoxes?: {
      text: string;
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

const SIGNATURE_SOUND_PATTERNS = [
  /funny moment|happy end|triumph|danger|scare|tension|specter|quest|mystery|geist|bistro|villain/i,
  /explosion|rocket launch|owl hoot|thunder|siren|chuckle|laugh|crash|scream|applause|footstep/i,
  /surprise|oh no|hey|watch out|hurry|all right|yipee/i,
];

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return (min + max) * 0.5;
  return Math.max(min, Math.min(max, v));
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

function buildKeyframes(
  rawKfs: AiKeyframePlan[] | undefined,
  totalFrames: number,
  fallbackX: number,
  fallbackZ: number
): Record<number, KeyframePosition> {
  const kfs: Record<number, KeyframePosition> = {};
  if (Array.isArray(rawKfs)) {
    for (const kf of rawKfs) {
      const f = Math.round(clamp(kf.frame, 0, totalFrames));
      const scale = kf.scale !== undefined ? clamp(kf.scale, 0.5, 2.2) : 1;
      const entry: KeyframePosition = {
        x: clamp(kf.x, -11, 11),
        y: clamp(kf.y, 0, 8),
        z: clamp(kf.z, -8, 12),
        rotY: Number.isFinite(kf.rotY) ? kf.rotY : 0,
      };
      if (kf.rotZ !== undefined && Math.abs(kf.rotZ) > 0.01 && Number.isFinite(kf.rotZ)) {
        entry.rotZ = kf.rotZ;
      }
      if (Math.abs(scale - 1) > 0.02) {
        entry.scaleX = scale;
        entry.scaleY = scale;
        entry.scaleZ = scale;
      }
      kfs[f] = entry;
    }
  }
  if (!kfs[0]) {
    const firstKey = Object.keys(kfs).map(Number).sort((a, b) => a - b)[0];
    kfs[0] = firstKey !== undefined ? { ...kfs[firstKey] } : { x: fallbackX, y: 0, z: fallbackZ, rotY: 0 };
  }
  return kfs;
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

function pickCuratedSounds(soundCatalog: CatalogSoundItem[]): CatalogSoundItem[] {
  const pickCategory = (category: 'music' | 'sfx' | 'speech', pattern: RegExp, limit: number) => {
    const pool = soundCatalog.filter((s) => s.category === category);
    const prioritized = pool.filter((s) => pattern.test(s.name));
    const merged: CatalogSoundItem[] = [];
    const seen = new Set<number>();
    for (const item of [...prioritized, ...pool]) {
      if (seen.has(item.msndCno)) continue;
      seen.add(item.msndCno);
      merged.push(item);
      if (merged.length >= limit) break;
    }
    return merged;
  };

  return [
    ...pickCategory('music', SIGNATURE_SOUND_PATTERNS[0], 14),
    ...pickCategory('sfx', SIGNATURE_SOUND_PATTERNS[1], 22),
    ...pickCategory('speech', SIGNATURE_SOUND_PATTERNS[2], 12),
  ];
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

  const pickedSounds = pickCuratedSounds(soundCatalog);
  const specialPropActions: Record<string, string[]> = {};
  for (const p of catalog.props) {
    if (/rocket/i.test(p.name)) specialPropActions[p.name] = ['Fly'];
    else if (/coffin|safe|chest/i.test(p.name)) specialPropActions[p.name] = ['Open and Close'];
    else if (/explosio/i.test(p.name)) specialPropActions[p.name] = ['Bang!', 'Grow Fast'];
  }

  const catalogSummary = {
    scenes: catalog.scenes.map((s) => ({ name: s.name, viewCount: Math.max(1, s.views.length) })),
    actors: catalog.actors.map((a) => a.name),
    commonActorActions: COMMON_ACTOR_ACTIONS,
    props: catalog.props.map((p) => p.name),
    commonPropActions: COMMON_PROP_ACTIONS,
    specialPropActions,
    tdtFonts: TDF_FONT_OPTIONS.map((f) => f.name),
    tdtShapes: TDT_SHAPE_OPTIONS.map((s) => s.name),
    tdtActions: [...TDT_ACTIONS],
    sounds: pickedSounds.map((s) => ({ name: s.name, category: s.category })),
  };

  const res = await fetch('/api/ai/generate-movie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, catalogSummary }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    moviePlan?: AiMoviePlan;
    error?: string;
  };
  if (!res.ok || !payload.moviePlan) {
    if (res.status === 404 || res.status === 405) {
      throw new Error(
        'AI Movie Generator requires the Node/Express backend server (unavailable on static GitHub Pages hosting).'
      );
    }
    throw new Error(payload.error || `AI Movie Generator request failed (${res.status}).`);
  }

  const plan = payload.moviePlan;
  const rawScenes = plan.scenes || [];

  // Parallel pre-hydration of TDT material swatches, unique TMPLS.3CN templates, and SNDS.3CN cues
  const matchedActorsMap = new Map<string, CatalogActorItem>();
  const matchedPropsMap = new Map<string, CatalogPropItem>();
  const neededTmpls = new Set<number>();
  const matchedSoundsMap = new Map<string, CatalogSoundItem>();
  const neededMsnds = new Set<number>();

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
      if (!cleanName || matchedSoundsMap.has(cleanName)) continue;
      const match =
        soundCatalog.find((s) => s.name.toLowerCase() === cleanName) ||
        soundCatalog.find((s) => s.name.toLowerCase().includes(cleanName) || cleanName.includes(s.name.toLowerCase()));
      if (match) {
        matchedSoundsMap.set(cleanName, match);
        neededMsnds.add(match.msndCno);
      }
    }
  }

  const templateCache = new Map<number, ParsedTemplate>();
  const soundCache = new Map<number, { audioData: string; midiData?: string; isMidi: boolean }>();

  const [swatches] = await Promise.all([
    loadTdtMaterialSwatches().catch(() => []),
    ...Array.from(neededTmpls).map(async (tmplCno) => {
      try {
        const tmpl = await loadTemplate(tmplCno);
        templateCache.set(tmplCno, tmpl);
      } catch {
        // ignore missing template cache miss
      }
    }),
    ...Array.from(neededMsnds).map(async (msndCno) => {
      try {
        const extracted = await sound3DMM.extractMsndCueData(msndCno);
        if (extracted) soundCache.set(msndCno, extracted);
      } catch {
        // ignore missing audio cache miss
      }
    }),
  ]);

  const builtScenes: Scene[] = [];

  for (let sIdx = 0; sIdx < rawScenes.length; sIdx++) {
    const sp = rawScenes[sIdx];
    const matchedBg = findSceneMatch(sp.sceneName, catalog.scenes);
    const totalFrames = Math.round(clamp(sp.durationFrames || 54, 12, 240));
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

    // Resolve Actors + real TMPLS.3CN ACTNs
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
      actors.push({
        id: `ai_actor_${sIdx}_${aIdx}_${Math.random().toString(36).slice(2, 6)}`,
        tmplCno: catActor.tmplCno,
        name: catActor.name,
        anid: akfs[0].anid,
        actionName: akfs[0].actionName,
        actionKeyframes: akfs,
        keyframes: buildKeyframes(ap.keyframes, totalFrames, defaultSlotX, 0),
      });
    }

    // Resolve Props + real TMPLS.3CN ACTNs
    const props: PropEntity[] = [];
    for (let pIdx = 0; pIdx < (sp.props || []).length; pIdx++) {
      const pp = sp.props![pIdx];
      const catProp = matchedPropsMap.get(pp.name) || findPropMatch(pp.name, catalog.props);
      const tmpl = templateCache.get(catProp.tmplCno) || null;

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

      props.push({
        id: `ai_prop_${sIdx}_${pIdx}_${Math.random().toString(36).slice(2, 6)}`,
        tmplCno: catProp.tmplCno,
        name: catProp.name,
        action: pakfs[0].action,
        ...(pakfs[0].anid !== undefined ? { anid: pakfs[0].anid } : {}),
        actionKeyframes: pakfs,
        keyframes: buildKeyframes(pp.keyframes, totalFrames, pIdx % 2 === 0 ? -4.5 : 4.5, -2),
      });
    }

    // Resolve 3D TDT words
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
      const sc = tp.scale !== undefined ? clamp(tp.scale, 0.35, 1.8) : 0.7;
      const basePos: KeyframePosition = {
        x: clamp(tp.x, -8, 8),
        y: clamp(tp.y, 1, 7),
        z: clamp(tp.z, -5, 7),
        rotY: 0,
        scaleX: sc,
        scaleY: sc,
        scaleZ: sc,
        visible: true,
        ...(tp.colorHex && /^#[0-9a-f]{6}$/i.test(tp.colorHex) ? { color: tp.colorHex } : {}),
      };
      const kfs: Record<number, KeyframePosition> = {};
      if (startF > 0) {
        kfs[0] = { ...basePos, visible: false };
      }
      kfs[startF] = { ...basePos, visible: true };
      if (endF < totalFrames) {
        kfs[endF] = { ...basePos, visible: false };
      }
      const matchedTdtAction = normalizeTdtActionName(tp.action);
      tdtTexts.push({
        id: `ai_tdt_${sIdx}_${tIdx}_${Math.random().toString(36).slice(2, 6)}`,
        text: textVal.slice(0, 28),
        tdfCno: font.tdfCno,
        tdts: shape.tdts,
        mtrlCno: swatches[tIdx % Math.max(1, swatches.length)]?.mtrlCno,
        action: matchedTdtAction,
        actionKeyframes: {
          [startF]: { action: matchedTdtAction },
        },
        keyframes: kfs,
      });
    }

    // Resolve 2D onscreen text boxes & slow scrolling credits
    const textBoxes: ScreenTextBox[] = [];
    for (let bIdx = 0; bIdx < (sp.textBoxes || []).length; bIdx++) {
      const bp = sp.textBoxes![bIdx];
      const txt = (bp.text || '').trim();
      if (!txt) continue;
      const startFrame = Math.round(clamp(bp.startFrame ?? 0, 0, totalFrames));
      const endFrame = Math.round(clamp(bp.endFrame ?? totalFrames, startFrame, totalFrames));
      const isScrolling = Boolean(bp.isScrolling);
      const rect = rectForPlacement(bp.placement, isScrolling);
      textBoxes.push({
        id: `ai_tbox_${sIdx}_${bIdx}_${Math.random().toString(36).slice(2, 6)}`,
        text: txt,
        fontName: 'Comic Sans MS',
        fontSize: isScrolling ? 16 : 15,
        color: bp.colorHex && /^#[0-9a-f]{6}$/i.test(bp.colorHex) ? bp.colorHex : '#fef08a',
        bgColor:
          bp.bgColorHex && /^#[0-9a-f]{6}$/i.test(bp.bgColorHex)
            ? bp.bgColorHex
            : isScrolling
            ? undefined
            : '#1b0e36',
        bold: true,
        startFrame,
        endFrame,
        ...rect,
        isScrolling,
      });
    }

    // Populate pre-hydrated SNDS.3CN WAV / MIDS sound cues
    const audios: ImportedAudioCue[] = [];
    const usedAudioKeys = new Set<string>();
    for (let aIdx = 0; aIdx < (sp.audioCues || []).length; aIdx++) {
      const ac = sp.audioCues![aIdx];
      const cleanName = (ac.soundName || '').trim().toLowerCase();
      if (!cleanName) continue;
      const match = matchedSoundsMap.get(cleanName);
      if (!match) continue;
      const f = Math.round(clamp(ac.frame ?? 0, 0, totalFrames));
      const key = `${f}:${match.category === 'music' ? 'midi' : match.msndCno}`;
      if (usedAudioKeys.has(key)) continue;
      usedAudioKeys.add(key);

      const extracted = soundCache.get(match.msndCno);
      if (!extracted) continue;
      audios.push({
        id: `ai_snd_${sIdx}_${aIdx}_${Math.random().toString(36).slice(2, 6)}`,
        frame: f,
        filename: match.name,
        audioData: extracted.audioData || '',
        midiData: extracted.midiData,
        isMidi: match.isMidi || extracted.isMidi,
        loop: ac.loop ?? match.isMidi,
        msndCno: match.msndCno,
      });
    }

    builtScenes.push({
      id: `ai_scene_${sIdx}_${Math.random().toString(36).slice(2, 6)}`,
      bkgdCno: matchedBg.bkgdCno,
      sceneName: matchedBg.name,
      icam: initialIcam,
      cameraAngle: { yaw: 0, pitch: 0 },
      cameraCuts,
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

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
  ParsedTemplate,
  TDF_FONT_OPTIONS,
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

  // Match meaningful keyword overlap (e.g. "Wave", "Run Scared", "Fly", "Bang!", "Open and Close")
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

export async function generateAiMovie(options: {
  prompt: string;
  catalog: ThreeDmmCatalog;
  soundCatalog: CatalogSoundItem[];
}): Promise<Movie> {
  const { prompt, catalog, soundCatalog } = options;
  if (catalog.scenes.length === 0 || catalog.actors.length === 0) {
    throw new Error('3D Movie Maker catalog is still loading. Please wait a moment and try again.');
  }

  // Pick a diverse balanced slice of real 3DMM sounds (MIDI music, SFX, and speech) for the AI director
  const midiSounds = soundCatalog.filter((s) => s.category === 'music').slice(0, 18);
  const sfxSounds = soundCatalog.filter((s) => s.category === 'sfx').slice(0, 28);
  const speechSounds = soundCatalog.filter((s) => s.category === 'speech').slice(0, 18);
  const pickedSounds = [...midiSounds, ...sfxSounds, ...speechSounds];

  const catalogSummary = {
    scenes: catalog.scenes.map((s) => ({ name: s.name, viewCount: Math.max(1, s.views.length) })),
    actors: catalog.actors.map((a) => ({
      name: a.name,
      actions: COMMON_ACTOR_ACTIONS,
    })),
    props: catalog.props.map((p) => {
      const extra: string[] = [];
      if (/rocket/i.test(p.name)) extra.push('Fly');
      if (/coffin|safe|chest/i.test(p.name)) extra.push('Open and Close');
      if (/explosio/i.test(p.name)) extra.push('Bang!', 'Grow Fast');
      return {
        name: p.name,
        actions: extra.length > 0 ? [...extra, ...COMMON_PROP_ACTIONS] : COMMON_PROP_ACTIONS,
      };
    }),
    tdtFonts: TDF_FONT_OPTIONS.map((f) => f.name),
    tdtShapes: TDT_SHAPE_OPTIONS.map((s) => s.name),
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
    throw new Error(payload.error || `AI Movie Generator request failed (${res.status}).`);
  }

  const plan = payload.moviePlan;
  const swatches = await loadTdtMaterialSwatches().catch(() => []);
  const builtScenes: Scene[] = [];

  for (let sIdx = 0; sIdx < (plan.scenes || []).length; sIdx++) {
    const sp = plan.scenes[sIdx];
    const matchedBg = findSceneMatch(sp.sceneName, catalog.scenes);
    const totalFrames = Math.round(clamp(sp.durationFrames || 60, 18, 240));
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
      const catActor = findActorMatch(ap.name, catalog.actors);
      let tmpl: ParsedTemplate | null = null;
      try {
        tmpl = await loadTemplate(catActor.tmplCno);
      } catch {
        tmpl = null;
      }

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
      const catProp = findPropMatch(pp.name, catalog.props);
      let tmpl: ParsedTemplate | null = null;
      try {
        tmpl = await loadTemplate(catProp.tmplCno);
      } catch {
        tmpl = null;
      }

      const pakfs: Record<number, PropActionKeyframe> = {};
      for (const seg of pp.actionSegments || []) {
        const f = Math.round(clamp(seg.frame, 0, totalFrames));
        const resolved = tmpl
          ? resolveTemplateAction(tmpl, seg.actionName)
          : { anid: undefined, name: seg.actionName || 'at rest' };
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
        keyframes: buildKeyframes(pp.keyframes, totalFrames, (pIdx % 2 === 0 ? -4.5 : 4.5), -2),
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
      tdtTexts.push({
        id: `ai_tdt_${sIdx}_${tIdx}_${Math.random().toString(36).slice(2, 6)}`,
        text: textVal.slice(0, 28),
        tdfCno: font.tdfCno,
        tdts: shape.tdts,
        mtrlCno: swatches[tIdx % Math.max(1, swatches.length)]?.mtrlCno,
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

    // Hydrate authentic SNDS.3CN WAV / MIDS sound cues
    const audios: ImportedAudioCue[] = [];
    const usedAudioKeys = new Set<string>();
    for (let aIdx = 0; aIdx < (sp.audioCues || []).length; aIdx++) {
      const ac = sp.audioCues![aIdx];
      const cleanName = (ac.soundName || '').trim().toLowerCase();
      if (!cleanName) continue;
      const match =
        soundCatalog.find((s) => s.name.toLowerCase() === cleanName) ||
        soundCatalog.find((s) => s.name.toLowerCase().includes(cleanName) || cleanName.includes(s.name.toLowerCase()));
      if (!match) continue;
      const f = Math.round(clamp(ac.frame ?? 0, 0, totalFrames));
      const key = `${f}:${match.category === 'music' ? 'midi' : match.msndCno}`;
      if (usedAudioKeys.has(key)) continue;
      usedAudioKeys.add(key);

      const extracted = await sound3DMM.extractMsndCueData(match.msndCno).catch(() => null);
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

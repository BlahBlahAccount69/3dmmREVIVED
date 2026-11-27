export interface TrainingMovieHighlight {
  sceneName: string;
  frames: number;
  cuts?: { f: number; v: number }[];
  actors?: {
    name: string;
    actions?: string[];
    kfs?: { f: number; x: number; y: number; z: number; rotY: number }[];
  }[];
  props?: { name: string; actions?: string[] }[];
  tdts?: { text: string; action: string; x: number; y: number; z: number }[];
  texts?: { text: string; start: number; end: number; scroll?: boolean }[];
  audio?: string[];
  sounds?: string[];
}

export interface TrainingMovieRecord {
  id: string;
  title: string;
  source: '3dmmstudio' | 'official' | string;
  rating: number | null;
  review?: string;
  sceneCount: number;
  totalFrames: number;
  cutsCount: number;
  tdtCount: number;
  textBoxCount: number;
  hasScrollingCredits?: boolean;
  tags?: string[];
  highlights?: TrainingMovieHighlight[];
}

export interface CorpusAnimationGrammar {
  trainedOnMovies: number;
  fullySimulated3mmScenes: number;
  recommendedSceneDurationRange?: [number, number];
  recommendedActionHoldFrames?: [number, number];
  recommendedMoveDurationFrames?: [number, number];
  recommendedCutIntervalFrames?: [number, number];
  topActionTransitions?: { transition: string; count: number }[];
  signatureChoreographyPatterns?: {
    scene: string;
    dur: number;
    actor: string;
    actions: string[];
    kfs: { f: number; x: number; y: number; z: number; rotY: number }[];
  }[];
}

export interface TrainingCorpus {
  corpusStats?: {
    totalMovies: number;
    studioMoviesCount: number;
    officialMoviesCount: number;
    totalScenesAnalyzed: number;
    medianSceneFrames: number;
    medianCutIntervalFrames: number;
    topScenes?: { name: string; count: number }[];
    topActors?: { name: string; count: number }[];
    topTdtActions?: { name: string; count: number }[];
  };
  corpusAnimationGrammar?: CorpusAnimationGrammar;
  movies: TrainingMovieRecord[];
}

const serializedCorpusCache = new WeakMap<TrainingCorpus, string>();

export function serializeFullTrainingCorpusJson(corpus: TrainingCorpus): string {
  const existing = serializedCorpusCache.get(corpus);
  if (existing !== undefined) return existing;
  if (!corpus || !Array.isArray(corpus.movies) || corpus.movies.length === 0) {
    serializedCorpusCache.set(corpus, '');
    return '';
  }
  const fullPayload = {
    corpusStats: corpus.corpusStats || null,
    corpusAnimationGrammar: corpus.corpusAnimationGrammar || null,
    trainedMovies: corpus.movies.map((m) => ({
      id: m.id,
      title: m.title,
      source: m.source,
      rating: m.rating,
      ...(m.review ? { review: m.review } : {}),
      sceneCount: m.sceneCount,
      totalFrames: m.totalFrames,
      cutsCount: m.cutsCount,
      tdtCount: m.tdtCount,
      textBoxCount: m.textBoxCount,
      hasScrollingCredits: Boolean(m.hasScrollingCredits),
      highlights: m.highlights || [],
    })),
  };
  const json = JSON.stringify(fullPayload);
  serializedCorpusCache.set(corpus, json);
  return json;
}

export function rankTrainedMoviesForPrompt(
  corpus: TrainingCorpus,
  prompt: string,
  targetSceneCount: number
) {
  if (!corpus || !Array.isArray(corpus.movies) || corpus.movies.length === 0) return [];
  const tokens = (prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  return corpus.movies
    .map((movie) => {
      let score = 0;
      if (/enriched enlightenment/i.test(movie.title)) score += 10;
      if (movie.rating !== null && movie.rating >= 7) score += 6;
      else if (movie.rating !== null && movie.rating >= 5) score += 2;
      else if (movie.rating !== null && movie.rating <= 3) score -= 2;

      if (movie.source === 'official') score += 3;
      if (movie.sceneCount >= Math.max(6, targetSceneCount - 1)) score += 4;
      if (movie.hasScrollingCredits) score += 1;
      if (movie.tdtCount > 0) score += 1;
      const hasRichKfs = (movie.highlights || []).some((h) =>
        (h.actors || []).some((a) => (a.kfs?.length || 0) >= 2)
      );
      if (hasRichKfs) score += 4;

      const haystack = [
        movie.id,
        movie.title,
        movie.review || '',
        ...(movie.tags || []),
        ...(movie.highlights || []).map((h) => h.sceneName),
        ...(movie.highlights || []).flatMap((h) => (h.props || []).map((p) => p.name)),
        ...(movie.highlights || []).flatMap((h) => (h.actors || []).map((a) => a.name)),
      ]
        .join(' ')
        .toLowerCase();

      for (const tok of tokens) {
        if (haystack.includes(tok)) score += 10;
      }
      return { movie, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function selectFullTrainedCorpusContext(
  corpus: TrainingCorpus | null | undefined,
  prompt: string,
  targetSceneCount: number
): {
  corpusPromptText: string;
  matchedMovieNames: string[];
} {
  if (!corpus || !Array.isArray(corpus.movies) || corpus.movies.length === 0) {
    return { corpusPromptText: '', matchedMovieNames: [] };
  }

  const ranked = rankTrainedMoviesForPrompt(corpus, prompt, targetSceneCount);
  const topPriority = ranked.slice(0, 10).map((r) => r.movie);
  const matchedMovieNames = topPriority.map((m) => `${m.title} (${m.id})`);
  const fullJson = serializeFullTrainingCorpusJson(corpus);

  const pickBestHighlight = (hs: TrainingMovieHighlight[]) => {
    const scoreH = (h: TrainingMovieHighlight) => {
      const actors = h.actors || [];
      const multiAct = actors.filter((a) => (a.actions?.length || 0) >= 3).length;
      const twoAct = actors.filter((a) => (a.actions?.length || 0) >= 2).length;
      const hasMove = actors.some((a) => {
        const kfs = a.kfs || [];
        return (
          kfs.length >= 2 &&
          Math.hypot(kfs[kfs.length - 1].x - kfs[0].x, kfs[kfs.length - 1].z - kfs[0].z) > 1.2
        );
      });
      return (
        multiAct * 10 + twoAct * 4 + (hasMove ? 6 : 0) + Math.min(4, actors.length) + (h.cuts?.length || 0)
      );
    };
    return [...hs].sort((a, b) => scoreH(b) - scoreH(a))[0] || hs[0];
  };

  const priorityDigestLines: string[] = [];
  for (const m of topPriority) {
    const hs = m.highlights || [];
    const arc = hs.map((h) => `${h.sceneName}(${h.frames}f)`).join(' -> ');
    const animHighlight = pickBestHighlight(hs);
    const cutPattern = (animHighlight?.cuts || [])
      .slice(0, 6)
      .map((c) => `f${c.f}->v${c.v}`)
      .join(', ');
    const actorBlocking = (animHighlight?.actors || [])
      .slice(0, 6)
      .map((a) => {
        const acts = (a.actions || []).slice(0, 8).join(' -> ');
        const kfsStr = (a.kfs || [])
          .slice(0, 6)
          .map((k) => `f${k.f}(${k.x},${k.y},${k.z},rotY:${k.rotY})`)
          .join('->');
        return `${a.name}[${acts || 'At Rest'}]${kfsStr ? ` path=${kfsStr}` : ''}`;
      })
      .join(' | ');
    const propSummary = (animHighlight?.props || [])
      .filter((p) => p.name && p.name !== 'CustomProp')
      .slice(0, 6)
      .map((p) => `${p.name}${p.actions?.length ? `[${p.actions.slice(0, 3).join(',')}]` : ''}`)
      .join(', ');
    const audioTiming = Array.from(
      new Set(
        hs
          .flatMap((h) => h.audio || h.sounds || [])
          .map((raw) => raw.trim())
          .filter((name) => Boolean(name) && !/\.(mp3|mp4)/i.test(name))
      )
    )
      .slice(0, 10)
      .join(', ');

    priorityDigestLines.push(
      `- "${m.title}" [id=${m.id}, ${m.source}, ${m.sceneCount} scenes, rating=${m.rating ?? 'N/A'}/10]: arc=${arc}${
        cutPattern ? `; cuts=${cutPattern}` : ''
      }${actorBlocking ? `; blocking=${actorBlocking}` : ''}${
        propSummary ? `; props=${propSummary}` : ''
      }${audioTiming ? `; audio=${audioTiming}` : ''}`
    );
  }

  const allTitlesRoster = ranked
    .map(
      ({ movie }, idx) =>
        `${idx + 1}. "${movie.title}" (id:${movie.id}, ${movie.source}, ${movie.sceneCount}s, ${movie.totalFrames}f, rating:${movie.rating ?? 'N/A'})`
    )
    .join(' | ');

  const grammar = corpus.corpusAnimationGrammar;
  const topTransitions = (grammar?.topActionTransitions || [])
    .map((t) => `${t.transition}(${t.count})`)
    .join(' | ');

  const patternLines = (grammar?.signatureChoreographyPatterns || [])
    .map((p) => {
      const kfsStr = (p.kfs || [])
        .slice(0, 6)
        .map((k) => `f${k.f}(${k.x},${k.y},${k.z},rotY:${k.rotY})`)
        .join('->');
      return `  * [${p.scene}, ${p.dur}f] ${p.actor}: actions=[${p.actions.join(' -> ')}]${kfsStr ? ` path=${kfsStr}` : ''}`;
    })
    .join('\n');

  const grammarBlock = `
CORPUS-TRAINED 3DMM ANIMATION GRAMMAR (${grammar?.trainedOnMovies ?? corpus.movies.length} movies, ${grammar?.fullySimulated3mmScenes ?? 196} fully-simulated scenes — APPLY TO EVERY SCENE):
- REAL TIMING: Moves take 6–15 frames (~1–2.5s), NEVER 0->sceneEnd! Action holds change every 6–18 frames; camera cuts hit every 10–22 frames on arrivals & reactions.
- MULTI-BEAT ACTING REQUIRED: Active actors MUST have 3–6+ distinct actionSegments per scene (e.g. f0:Walk Fast -> f10:Greet -> f14:Talk -> f28:Laugh -> f36:Jump -> f44:At Rest). NEVER generate lazy 2-segment [f0:Walk Fast, end:At Rest] slides or lines of frozen At Rest statues!
- STAGGER & STAGE DEPTH: Stagger when actors move (Actor A arrives f0..11 then Talks; Actor B starts Think/Talk Sitting f0..14, walks f14..24, Laughs/Jumps f24..38; extras arrive mid-scene or animate in background Z=-7..-3). Orient partners face-to-face via rotY = atan2(partnerX-x, partnerZ-z).
- CORPUS TRANSITION MOTIFS: ${topTransitions || 'At Rest -> Walk Fast -> Talk -> Laugh -> At Rest | Talk Sitting -> Sit, Talk, Stand -> Jump -> Faint -> Get Up | Sneak -> At Rest -> Run Scared -> Fall'}
${patternLines ? `- REAL TRAINED ACTOR CHAINS FROM CORPUS:\n${patternLines}` : ''}
- CONCRETE TARGET CHOREOGRAPHY JSON SHAPE (model every scene on this quality):
  {"cameraCuts":[{"frame":0,"viewIndex":0},{"frame":14,"viewIndex":2},{"frame":30,"viewIndex":1}],"actors":[{"name":"Gustave","actionSegments":[{"frame":0,"actionName":"Walk Fast"},{"frame":10,"actionName":"Greet"},{"frame":16,"actionName":"Talk"},{"frame":30,"actionName":"Jump"},{"frame":38,"actionName":"At Rest"}],"keyframes":[{"frame":0,"x":-8,"y":0,"z":2.5,"rotY":1.32},{"frame":10,"x":-2,"y":0,"z":1,"rotY":1.45},{"frame":30,"x":-2,"y":1.2,"z":1,"rotY":1.45},{"frame":38,"x":-2,"y":0,"z":1,"rotY":0.4}]},{"name":"Wanda","actionSegments":[{"frame":0,"actionName":"Think"},{"frame":12,"actionName":"Walk Slowly"},{"frame":20,"actionName":"Talk"},{"frame":34,"actionName":"Laugh"},{"frame":44,"actionName":"At Rest"}],"keyframes":[{"frame":0,"x":5,"y":0,"z":-1.5,"rotY":-1.2},{"frame":12,"x":5,"y":0,"z":-1.5,"rotY":-1.35},{"frame":20,"x":2.2,"y":0,"z":0.5,"rotY":-1.45}]}]}`;

  const corpusPromptText = `\nALL ${corpus.movies.length} TRAINED MOVIES ROSTER (${corpus.corpusStats?.totalScenesAnalyzed ?? 670} analyzed scenes):\n${allTitlesRoster}\n\nTOP PROMPT-MATCHED & FEATURED TRAINED MOVIE BREAKDOWNS:\n${priorityDigestLines.join('\n')}${grammarBlock}\n\nCOMPLETE TRAINED_MOVIES_FULL_CORPUS JSON (ALL ${corpus.movies.length} MOVIES, ALL HIGHLIGHTS, ACTORS, KEYFRAMES, PROPS, TITLES & AUDIO — STUDY AND EMULATE THESE REAL MOVIES):\n${fullJson}`;

  return { corpusPromptText, matchedMovieNames };
}

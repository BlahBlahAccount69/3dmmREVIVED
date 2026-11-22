import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function readDotEnvGeminiKey(): string | null {
  try {
    const envPath = path.resolve(__dirname, '.env');
    if (!fs.existsSync(envPath)) return null;
    const raw = fs.readFileSync(envPath, 'utf8');
    const parsed = dotenv.parse(raw);
    const val = (parsed.GEMINI_API_KEY || '').replace(/^[“"']+|[”"']+$/g, '').trim();
    return val || null;
  } catch {
    return null;
  }
}

const MODEL_FALLBACK_CHAIN: { model: string; thinkingLevel?: ThinkingLevel }[] = [
  { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
  { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW },
  { model: 'gemini-3.5-flash-lite' },
  { model: 'gemini-2.5-flash' },
];

interface CatalogSummaryPayload {
  scenes: { name: string; viewCount: number }[];
  actors: (string | { name: string })[];
  commonActorActions?: string[];
  props: (string | { name: string })[];
  commonPropActions?: string[];
  specialPropActions?: Record<string, string[]>;
  tdtFonts: string[];
  tdtShapes: string[];
  tdtActions?: string[];
  sounds: { name: string; category: 'sfx' | 'music' | 'speech' }[];
}

interface TrainingMovieHighlight {
  sceneName: string;
  frames: number;
  cuts?: { f: number; v: number }[];
  actors?: { name: string; actions?: string[]; kfs?: { f: number; x: number; y: number; z: number; rotY: number }[] }[];
  props?: { name: string; actions?: string[] }[];
  tdt?: { text: string; action: string; x: number; y: number; z: number }[];
  textBoxes?: { text: string; start: number; end: number; scroll?: boolean }[];
  sounds?: string[];
}

interface TrainingMovieRecord {
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

interface TrainingCorpus {
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
  movies: TrainingMovieRecord[];
}

function loadTrainingCorpus(): TrainingCorpus | null {
  try {
    const filePath = path.resolve(__dirname, 'server', 'training_data.json');
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as TrainingCorpus;
    if (!parsed || !Array.isArray(parsed.movies)) return null;
    return parsed;
  } catch (err) {
    console.warn('Could not load server/training_data.json:', err);
    return null;
  }
}

const TRAINING_CORPUS = loadTrainingCorpus();

const NUMBER_WORD_MAP: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

function extractRequestedSceneCount(prompt: string): number | null {
  if (!prompt) return null;
  const digitMatch =
    prompt.match(/\b(?:with|make|create|generate|have|at\s+least|exactly)?\s*(\d{1,2})\s*[- ]?\s*scenes?\b/i) ||
    prompt.match(/\bscenes?\s*[:=]\s*(\d{1,2})\b/i);
  if (digitMatch) {
    const n = Number.parseInt(digitMatch[1], 10);
    if (Number.isFinite(n) && n >= 1) {
      return Math.min(20, n);
    }
  }

  const wordPattern = new RegExp(
    `\\b(${Object.keys(NUMBER_WORD_MAP).join('|')})\\s*[- ]?\\s*scenes?\\b`,
    'i'
  );
  const wordMatch = prompt.match(wordPattern);
  if (wordMatch) {
    const n = NUMBER_WORD_MAP[wordMatch[1].toLowerCase()];
    if (n) return n;
  }
  return null;
}

function selectCompactTrainingExemplars(prompt: string, targetSceneCount: number): string {
  if (!TRAINING_CORPUS || TRAINING_CORPUS.movies.length === 0) {
    return '';
  }

  const tokens = (prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  const scored = TRAINING_CORPUS.movies
    .filter((m) => Array.isArray(m.highlights) && m.highlights.length > 0 && m.sceneCount >= 2)
    .map((movie) => {
      let score = 0;
      if (movie.rating !== null && movie.rating >= 7) score += 6;
      else if (movie.rating !== null && movie.rating >= 5) score += 2;
      else if (movie.rating !== null && movie.rating <= 3) score -= 4;

      if (movie.source === 'official') score += 3;
      if (movie.sceneCount >= Math.max(4, targetSceneCount - 2)) score += 4;
      if (movie.hasScrollingCredits) score += 1;
      if (movie.tdtCount > 0) score += 1;

      const haystack = [
        movie.title,
        movie.review || '',
        ...(movie.tags || []),
        ...(movie.highlights || []).map((h) => h.sceneName),
      ]
        .join(' ')
        .toLowerCase();

      for (const tok of tokens) {
        if (haystack.includes(tok)) score += 5;
      }

      return { movie, score };
    })
    .sort((a, b) => b.score - a.score);

  const chosen: TrainingMovieRecord[] = [];
  const seenTitles = new Set<string>();
  for (const item of scored) {
    const baseTitle = item.movie.title.replace(/\s*\([^)]*\)\s*/g, '').toLowerCase();
    if (seenTitles.has(baseTitle)) continue;
    seenTitles.add(baseTitle);
    chosen.push(item.movie);
    if (chosen.length >= 2) break;
  }

  if (chosen.length === 0) return '';

  const lines: string[] = [];
  for (const m of chosen) {
    const hs = (m.highlights || []).slice(0, 3);
    const arc = hs.map((h) => `${h.sceneName}(${h.frames}f)`).join(' -> ');
    const lead = hs.find((h) => (h.actors?.length || 0) > 0) || hs[0];
    const leadActors = (lead?.actors || [])
      .slice(0, 2)
      .map((a) => `${a.name}[${(a.actions || []).slice(0, 2).join(',')}]`)
      .join(', ');
    const leadTdt = (lead?.tdt || [])
      .slice(0, 1)
      .map((t) => `"${t.text}"(${t.action})`)
      .join('');
    const reviewSnippet = (m.review || '').replace(/\s+/g, ' ').slice(0, 110);
    lines.push(
      `- "${m.title}" [${m.source}, ${m.sceneCount} scenes, rating=${m.rating ?? 'N/A'}/10]: arc=${arc}${
        leadActors ? `; cast=${leadActors}` : ''
      }${leadTdt ? `; 3DWord=${leadTdt}` : ''}${reviewSnippet ? `; note="${reviewSnippet}"` : ''}`
    );
  }
  return `\nMATCHED CORPUS EXEMPLARS:\n${lines.join('\n')}`;
}

function buildMoviePlanSchema(requestedSceneCount: number | null) {
  const sceneDesc =
    requestedSceneCount !== null
      ? `MUST contain at least ${requestedSceneCount} distinct scenes in story order (${requestedSceneCount} scenes requested). Never merge or drop scenes below ${requestedSceneCount}. Keep each scene tight (30-56 frames) so all ${requestedSceneCount} scenes fit cleanly.`
      : '5 to 7 distinct scenes in story order covering setup, complication, escalation/twist, climax, and ending/credits. Never stop at only 2-3 scenes.';

  return {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      plot: {
        type: Type.STRING,
        description: 'Cohesive 2-4 sentence plot summary covering beginning, twist, and ending.',
      },
      scenes: {
        type: Type.ARRAY,
        description: sceneDesc,
        items: {
          type: Type.OBJECT,
          properties: {
            sceneName: { type: Type.STRING },
            durationFrames: { type: Type.INTEGER },
            cameraCuts: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  frame: { type: Type.INTEGER },
                  viewIndex: { type: Type.INTEGER },
                },
                required: ['frame', 'viewIndex'],
              },
            },
            actors: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  actionSegments: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        frame: { type: Type.INTEGER },
                        actionName: { type: Type.STRING },
                      },
                      required: ['frame', 'actionName'],
                    },
                  },
                  keyframes: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        frame: { type: Type.INTEGER },
                        x: { type: Type.NUMBER },
                        y: { type: Type.NUMBER },
                        z: { type: Type.NUMBER },
                        rotY: { type: Type.NUMBER },
                        scale: { type: Type.NUMBER },
                      },
                      required: ['frame', 'x', 'y', 'z', 'rotY'],
                    },
                  },
                },
                required: ['name', 'actionSegments', 'keyframes'],
              },
            },
            props: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  actionSegments: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        frame: { type: Type.INTEGER },
                        actionName: { type: Type.STRING },
                      },
                      required: ['frame', 'actionName'],
                    },
                  },
                  keyframes: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        frame: { type: Type.INTEGER },
                        x: { type: Type.NUMBER },
                        y: { type: Type.NUMBER },
                        z: { type: Type.NUMBER },
                        rotY: { type: Type.NUMBER },
                        rotZ: { type: Type.NUMBER },
                        scale: { type: Type.NUMBER },
                      },
                      required: ['frame', 'x', 'y', 'z', 'rotY'],
                    },
                  },
                },
                required: ['name', 'actionSegments', 'keyframes'],
              },
            },
            tdtTexts: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  fontName: { type: Type.STRING },
                  shapeName: { type: Type.STRING },
                  action: { type: Type.STRING },
                  colorHex: { type: Type.STRING },
                  startFrame: { type: Type.INTEGER },
                  endFrame: { type: Type.INTEGER },
                  x: { type: Type.NUMBER },
                  y: { type: Type.NUMBER },
                  z: { type: Type.NUMBER },
                  scale: { type: Type.NUMBER },
                },
                required: ['text', 'fontName', 'shapeName', 'x', 'y', 'z'],
              },
            },
            textBoxes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  startFrame: { type: Type.INTEGER },
                  endFrame: { type: Type.INTEGER },
                  placement: { type: Type.STRING },
                  isScrolling: { type: Type.BOOLEAN },
                  colorHex: { type: Type.STRING },
                  bgColorHex: { type: Type.STRING },
                },
                required: ['text', 'startFrame', 'endFrame', 'placement', 'isScrolling'],
              },
            },
            audioCues: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  frame: { type: Type.INTEGER },
                  soundName: { type: Type.STRING },
                  loop: { type: Type.BOOLEAN },
                },
                required: ['frame', 'soundName'],
              },
            },
          },
          required: ['sceneName', 'durationFrames', 'cameraCuts', 'actors', 'props'],
        },
      },
    },
    required: ['title', 'plot', 'scenes'],
  };
}

const AUTHENTIC_TDT_ACTIONS_LIST =
  'At Rest, Flip Letters, Spin Letters, Cartwheel Letters, Side to Side, Rock, Back and Forth, Grow and Shrink, Flip, Spin, Cartwheel, The Wave, Hide and Appear, Walk Forward*, Hop, Stretch';

const PRETRAINED_3DMM_SYSTEM_INSTRUCTION = `You are a master Microsoft 3D Movie Maker director trained on a 45-film .3mm corpus (604 scenes across classic 3DMM sample movies + community hits from 3dmmstudio.co.uk including Asylum, Lord of the Flies, Who's the Director Anyway?, Baked Goods, Domicile Destructo's Nightmare, Venus 31, The Thief, Sprog, The Book, Terror at McZee Manor).
Emit compact, tight, fast JSON matching the schema—never waste extra filler keyframes.

CORPUS-DISTILLED 3DMM DIRECTION RULES (6 FPS: 6 frames = 1 second; median scene = 46f, median cut = 18f):
1. FULL MULTI-SCENE STORYTELLING (DEFAULT 5-7 SCENES, OR EXACT REQUESTED COUNT):
   - Always build a proper multi-scene story arc instead of rushing into 2-3 short scenes:
     * Scene 1 (Setup): Title word or opening hook, introduce main character(s) & goal.
     * Middle Scenes (2..N-1): Travel across distinct locations (MY-Street, AD-Landscape, HH-Exterior, HH-Interior, HH-Lab, MY-Mall, AD-Airplane, AD-Cave, AD-Hut, etc.), rising tension, obstacles, discoveries, chases, gadgets/props (Rocket Fly, Treasure chest/Safe/Coffin Open and Close, Car, Explosio Bang!).
     * Final Scene (Climax & Payoff): Big physical reaction beats (Jump, Karate Kick, Faint, Laugh, Dance, Mad, Sad) + optional closing slow credits (isScrolling: true, placement: "credits" starting near the end, e.g. startFrame: durationFrames - 4, endFrame: durationFrames).
   - If the user asks for a specific number of scenes N, produce AT LEAST N distinct scenes (exact N). Keep each scene concise (30-56 frames, 2-3 camera cuts, 2-3 keyframes per moving character) so multi-scene movies remain fast.
2. CAMERA CUTS (2-3 cuts per scene):
   - Always include frame 0 plus 1-2 well-timed cuts (~16-22 frames apart; strictly 0 <= viewIndex < scene.viewCount).
   - Vary camera views (wide establishing -> closer action -> reaction punchline).
3. STAGE COORDINATES & FACING:
   - Keep actors & props clearly visible: x in [-6.5, 6.5], y in [0, 4.5], z in [-4.5, 6.5].
   - Facing: rotY = 0 faces camera, ~1.57 faces right, ~-1.57 faces left, ~3.14 faces away. Align rotY toward travel direction during walks/runs, then turn toward dialogue partner/camera on reaction beats.
   - Use 2-3 keyframes per moving entity (never frame-by-frame spam).
4. ACTING, PROP SYNC & SOUND LAYERING:
   - Pair travel keyframes with Walk Fast / Walk Slowly / Sneak / Run / Run Scared, and stationary beats with At Rest / Greet / Laugh / Dance / Jump / Karate Kick / Faint / Fall / Sit, Talk, Stand / Think / Yell / Mad, Sad.
   - Pair each scene with 1 music cue at frame 0 (loop: true) plus 1-2 SFX or speech cues aligned to physical beats.
5. AUTHENTIC 3D WORDS (TDT) & 2D TEXT BOXES:
   - For any 3D tdtTexts[].action, ONLY use authentic Microsoft 3DMM TDT actions: ${AUTHENTIC_TDT_ACTIONS_LIST}. NEVER invent fake actions like bounce, wobble, float, or pulse.
   - Use concise 2D dialogue/story captions (isScrolling: false) during dialogue beats (non-overlapping frame windows) and optional closing scrolling credits (isScrolling: true) at the end of the final scene.

STRICT RULE: Only use exact scene names, actor names, prop names, action names, font/shape names, TDT action names, and sound names from the provided catalogSummary.`;

async function generateWithFallback(prompt: string, catalogSummary: CatalogSummaryPayload) {
  const primaryKey = process.env.GEMINI_API_KEY?.trim() || null;
  const dotEnvKey = readDotEnvGeminiKey();
  const candidateKeys: string[] = [];
  if (primaryKey) candidateKeys.push(primaryKey);
  if (dotEnvKey && dotEnvKey !== primaryKey) candidateKeys.push(dotEnvKey);

  if (candidateKeys.length === 0) {
    throw new Error('GEMINI_API_KEY is not set in the server environment or .env file.');
  }

  const trimmedPrompt = (prompt || '').trim();
  const requestedSceneCount = extractRequestedSceneCount(trimmedPrompt);
  const targetSceneCount = requestedSceneCount ?? 5;
  const corpusExemplars = selectCompactTrainingExemplars(trimmedPrompt, targetSceneCount);
  const schema = buildMoviePlanSchema(requestedSceneCount);

  const sceneConstraintNote =
    requestedSceneCount !== null
      ? `\n\nMANDATORY SCENE COUNT: The user requested ${requestedSceneCount} scenes. Your JSON output MUST contain at least ${requestedSceneCount} (target exactly ${requestedSceneCount}) distinct scenes in the "scenes" array. Count every scene carefully before finishing.`
      : `\n\nMULTI-SCENE TARGET: Generate 5 to 7 distinct scenes with varied locations so the story feels complete (never stop at 2-3 scenes).`;

  const systemInstruction = `${PRETRAINED_3DMM_SYSTEM_INSTRUCTION}${corpusExemplars}${sceneConstraintNote}`;

  const userMessage = JSON.stringify({
    storyIdea:
      trimmedPrompt.length > 0
        ? trimmedPrompt
        : 'Create a hilarious, imaginative 6-scene 3D Movie Maker adventure with a clear setup, progression across locations, plot twist, climax, ending credits, dynamic camera cuts, expressive moving actors & props, 3D title word, and synced music/SFX.',
    ...(requestedSceneCount !== null ? { requestedSceneCount } : { targetSceneRange: '5-7' }),
    catalogSummary,
  });

  let lastErr: unknown;
  for (let keyIdx = 0; keyIdx < candidateKeys.length; keyIdx++) {
    const client = createGeminiClient(candidateKeys[keyIdx]);
    for (const entry of MODEL_FALLBACK_CHAIN) {
      try {
        const response = await client.models.generateContent({
          model: entry.model,
          contents: userMessage,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: schema,
            ...(entry.thinkingLevel
              ? { thinkingConfig: { thinkingLevel: entry.thinkingLevel } }
              : {}),
          },
        });
        const text = response.text?.trim();
        if (!text) {
          throw new Error(`Gemini (${entry.model}) returned an empty response.`);
        }
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
          throw new Error(`Gemini (${entry.model}) returned a plan with no scenes.`);
        }
        const minimumDesiredScenes = requestedSceneCount ?? 5;
        if (parsed.scenes.length < minimumDesiredScenes) {
          // Fast continuation request to append missing scenes if a model returned fewer scenes than desired
          const missing = minimumDesiredScenes - parsed.scenes.length;
          try {
            const extSchema = buildMoviePlanSchema(missing);
            const extPrompt = JSON.stringify({
              storyIdea: trimmedPrompt || 'Continue this 3DMM movie adventure to a satisfying climax and end credits.',
              existingTitle: parsed.title,
              existingPlot: parsed.plot,
              existingSceneNames: parsed.scenes.map((s: { sceneName?: string }) => s.sceneName),
              instruction: `Continue this story seamlessly and generate EXACTLY ${missing} additional distinct scenes to complete this ${minimumDesiredScenes}-scene movie.`,
              catalogSummary,
            });
            const extResp = await client.models.generateContent({
              model: entry.model,
              contents: extPrompt,
              config: {
                systemInstruction: PRETRAINED_3DMM_SYSTEM_INSTRUCTION,
                responseMimeType: 'application/json',
                responseSchema: extSchema,
                ...(entry.thinkingLevel
                  ? { thinkingConfig: { thinkingLevel: entry.thinkingLevel } }
                  : {}),
              },
            });
            const extText = extResp.text?.trim();
            if (extText) {
              const extParsed = JSON.parse(extText);
              if (Array.isArray(extParsed?.scenes) && extParsed.scenes.length > 0) {
                parsed.scenes = [...parsed.scenes, ...extParsed.scenes.slice(0, missing)];
              }
            }
          } catch (extErr) {
            console.warn('Scene continuation helper skipped:', extErr);
          }
        }
        return parsed;
      } catch (err: unknown) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `Gemini fallback check failed [key #${keyIdx + 1}, model=${entry.model}]:`,
          msg
        );
      }
    }
  }
  throw lastErr || new Error('All Gemini models failed to generate a movie.');
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY?.trim() || readDotEnvGeminiKey()),
    });
  });

  app.post('/api/ai/generate-movie', async (req, res) => {
    if (!process.env.GEMINI_API_KEY?.trim() && !readDotEnvGeminiKey()) {
      res.status(500).json({
        error:
          'GEMINI_API_KEY is missing on the server and .env. Add it in Settings > Secrets or .env and try again.',
      });
      return;
    }

    const { prompt, catalogSummary } = (req.body || {}) as {
      prompt?: string;
      catalogSummary?: CatalogSummaryPayload;
    };

    if (
      !catalogSummary ||
      !Array.isArray(catalogSummary.scenes) ||
      !Array.isArray(catalogSummary.actors) ||
      !Array.isArray(catalogSummary.props)
    ) {
      res.status(400).json({ error: 'Invalid catalogSummary payload.' });
      return;
    }

    try {
      const moviePlan = await generateWithFallback(prompt || '', catalogSummary);
      res.json({ moviePlan });
    } catch (err: unknown) {
      console.error('Gemini movie generation error:', err);
      const message = err instanceof Error ? err.message : 'Failed to generate movie with Gemini AI.';
      const status =
        /PERMISSION_DENIED|403/i.test(message)
          ? 403
          : /RESOURCE_EXHAUSTED|429/i.test(message)
          ? 429
          : /INVALID_ARGUMENT|400/i.test(message)
          ? 400
          : 500;
      res.status(status).json({ error: message });
    }
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`3D Movie Maker server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed starting server:', err);
  process.exit(1);
});

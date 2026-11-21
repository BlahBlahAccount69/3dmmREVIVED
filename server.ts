import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const aiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

interface CatalogSummaryPayload {
  scenes: { name: string; viewCount: number }[];
  actors: { name: string; actions: string[] }[];
  props: { name: string; actions: string[] }[];
  tdtFonts: string[];
  tdtShapes: string[];
  sounds: { name: string; category: 'sfx' | 'music' | 'speech' }[];
}

const MOVIE_PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'Catchy 3D Movie Maker film title.' },
    plot: {
      type: Type.STRING,
      description: 'A cohesive 2-4 sentence plot summary describing the story arc, characters, and ending.',
    },
    scenes: {
      type: Type.ARRAY,
      description: '2 to 4 scenes that tell the movie story in sequence.',
      items: {
        type: Type.OBJECT,
        properties: {
          sceneName: {
            type: Type.STRING,
            description: 'Exact background setting name from catalogSummary.scenes.',
          },
          durationFrames: {
            type: Type.INTEGER,
            description: 'Scene length in 6 FPS frames (typically 36 to 90 frames).',
          },
          cameraCuts: {
            type: Type.ARRAY,
            description: 'At least 2 camera angle cuts per scene (always include frame 0 plus mid-scene cuts).',
            items: {
              type: Type.OBJECT,
              properties: {
                frame: { type: Type.INTEGER, description: '0-based frame within the scene.' },
                viewIndex: {
                  type: Type.INTEGER,
                  description: '0-based camera view index strictly < scene viewCount.',
                },
              },
              required: ['frame', 'viewIndex'],
            },
          },
          actors: {
            type: Type.ARRAY,
            description: '1 to 3 actors in this scene with movements and action changes.',
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING, description: 'Exact actor name from catalogSummary.actors.' },
                actionSegments: {
                  type: Type.ARRAY,
                  description: 'Action changes over the scene.',
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      frame: { type: Type.INTEGER },
                      actionName: {
                        type: Type.STRING,
                        description: 'Matching action name for this actor (e.g. Walk Fast, Wave, Dance, Run Scared, Sit, At Rest).',
                      },
                    },
                    required: ['frame', 'actionName'],
                  },
                },
                keyframes: {
                  type: Type.ARRAY,
                  description: 'Stage-space motion keyframes (x in [-8,8], y in [0,5], z in [-6,10], rotY in radians, scale ~ 0.8..1.3).',
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
            description: '0 to 3 props in this scene, with optional movement & prop actions.',
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING, description: 'Exact prop name from catalogSummary.props.' },
                actionSegments: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      frame: { type: Type.INTEGER },
                      actionName: {
                        type: Type.STRING,
                        description: 'Valid action for this prop (e.g. At Rest, Grow, Grow Fast, Shrink, Spin, Spin Fast, Fly, Open and Close, Bang!).',
                      },
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
            description: 'Optional 0 to 2 3D text titles/callouts placed in the scene.',
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING, description: 'Short punchy 1-3 word 3D text (UPPERCASE or Title Case).' },
                fontName: { type: Type.STRING, description: 'One of catalogSummary.tdtFonts.' },
                shapeName: { type: Type.STRING, description: 'One of catalogSummary.tdtShapes.' },
                colorHex: { type: Type.STRING, description: 'Hex color like #f59e0b or #38bdf8.' },
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
            description: 'Optional 0 to 2 2D onscreen dialogue captions, title cards, or closing rolling credits.',
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING },
                startFrame: { type: Type.INTEGER },
                endFrame: { type: Type.INTEGER },
                placement: {
                  type: Type.STRING,
                  description: 'One of: top, bottom, center, credits',
                },
                isScrolling: {
                  type: Type.BOOLEAN,
                  description: 'True for slow rolling credits (especially final scene), false for static captions/dialogue.',
                },
                colorHex: { type: Type.STRING },
                bgColorHex: { type: Type.STRING },
              },
              required: ['text', 'startFrame', 'endFrame', 'placement', 'isScrolling'],
            },
          },
          audioCues: {
            type: Type.ARRAY,
            description: 'Optional 1 to 3 sound/MIDI music cues selected from catalogSummary.sounds.',
            items: {
              type: Type.OBJECT,
              properties: {
                frame: { type: Type.INTEGER },
                soundName: { type: Type.STRING, description: 'Exact name from catalogSummary.sounds.' },
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

async function generateWithRetry(prompt: string, catalogSummary: CatalogSummaryPayload) {
  if (!aiClient) {
    throw new Error('GEMINI_API_KEY is not set in the server environment.');
  }

  const systemInstruction = [
    'You are an award-winning director creating playful, cinematic Microsoft 3D Movie Maker films.',
    'Frame rate is 6 FPS (6 frames = 1 second). Scenes are typically 42 to 84 frames (7 to 14 seconds).',
    'Stage coordinates are relative to the active camera view center on the floor:',
    '- x: left (-8) to right (+8); y: floor (0) to elevated (+5); z: closer to camera (+7) to deeper into stage (-6).',
    '- rotY: facing toward camera is 0, facing right is ~1.57, facing left is ~-1.57, facing away is ~3.14.',
    '- Keep keyframes strictly inside comfortable framing so actors and props are clearly visible and never off-screen!',
    '- Coordinate actor movement smoothly: when an actor walks/runs from point A to point B across keyframes, face rotY along atan2(dx, dz) and switch actionSegments accordingly (e.g. Walk/Run during travel, Wave/Celebrate/Laugh/Sit/At Rest when stopped).',
    '- Use multiple cameraCuts per scene (frame 0 plus 1-3 cuts mid-scene) using valid 0-based viewIndex < viewCount for that scene.',
    '- Move and animate props meaningfully too (e.g., Rocket with Fly rising in y, Treasure chest with Open and Close, Car moving across stage, Explosio with Bang!).',
    '- Include a clear plot in the "plot" field, and creatively use 2D onscreen text boxes (dialogue captions, opening title, and/or slow scrolling end credits) and 3D text words where they fit the story—you do not need to force every element into every single scene, use them tastefully across the movie.',
    '- ONLY use exact scene names, actor names, prop names, TDT font/shape names, and sound names present in the provided catalogSummary.',
  ].join('\n');

  const userMessage = JSON.stringify({
    storyIdea:
      prompt && prompt.trim().length > 0
        ? prompt.trim()
        : 'Create a hilarious, imaginative 3-scene 3D Movie Maker adventure with a clear beginning, middle twist, finale, camera angle cuts, animated actors, moving props, 3D text, and slow closing credits.',
    catalogSummary,
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: userMessage,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: MOVIE_PLAN_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      const text = response.text?.trim();
      if (!text) {
        throw new Error('Gemini returned an empty response.');
      }
      return JSON.parse(text);
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Gemini attempt ${attempt + 1} failed:`, msg);
      const isTransient = /429|503|UNAVAILABLE|RESOURCE_EXHAUSTED|timeout|fetch failed/i.test(msg);
      if (!isTransient || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, hasGeminiKey: Boolean(process.env.GEMINI_API_KEY) });
  });

  app.post('/api/ai/generate-movie', async (req, res) => {
    if (!aiClient) {
      res.status(500).json({
        error: 'GEMINI_API_KEY is missing on the server. Add it in Settings > Secrets and try again.',
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
      const moviePlan = await generateWithRetry(prompt || '', catalogSummary);
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

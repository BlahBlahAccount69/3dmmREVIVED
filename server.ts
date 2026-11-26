import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, type Schema } from '@google/genai';
import {
  buildGeminiMoviePlanSchema,
  buildSystemInstruction,
  type CatalogSummaryPayload,
  extractRequestedActorCount,
  extractRequestedSceneCount,
  MODEL_FALLBACK_CHAIN,
} from './src/services/aiTrainingContext.ts';

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
    const val = (parsed.GEMINI_API_KEY || '')
      .replace(/^[“"']+|[”"']+$/g, '')
      .trim();
    return val || null;
  } catch {
    return null;
  }
}

interface TrainingMovieHighlight {
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
      if (movie.sceneCount >= Math.max(6, targetSceneCount - 1)) score += 5;
      if (movie.hasScrollingCredits) score += 1;
      if (movie.tdtCount > 0) score += 1;
      const hasRichKfs = (movie.highlights || []).some((h) =>
        (h.actors || []).some((a) => (a.kfs?.length || 0) >= 2)
      );
      if (hasRichKfs) score += 4;

      const haystack = [
        movie.title,
        movie.review || '',
        ...(movie.tags || []),
        ...(movie.highlights || []).map((h) => h.sceneName),
        ...(movie.highlights || []).flatMap((h) => (h.props || []).map((p) => p.name)),
      ]
        .join(' ')
        .toLowerCase();

      for (const tok of tokens) {
        if (haystack.includes(tok)) score += 6;
      }

      return { movie, score };
    })
    .sort((a, b) => b.score - a.score);

  const chosen: TrainingMovieRecord[] = [];
  const seenTitles = new Set<string>();

  // Always ensure Enriched Enlightenment + top community & official exemplars contribute animation patterns
  const eeMovie = TRAINING_CORPUS.movies.find((m) => /enriched enlightenment/i.test(m.title));
  if (eeMovie) {
    seenTitles.add(eeMovie.title.replace(/\s*\([^)]*\)\s*/g, '').toLowerCase());
    chosen.push(eeMovie);
  }

  for (const item of scored) {
    const baseTitle = item.movie.title.replace(/\s*\([^)]*\)\s*/g, '').toLowerCase();
    if (seenTitles.has(baseTitle)) continue;
    seenTitles.add(baseTitle);
    chosen.push(item.movie);
    if (chosen.length >= 6) break;
  }

  if (chosen.length === 0) return '';

  const lines: string[] = [];
  for (const m of chosen) {
    const hs = m.highlights || [];
    const arc = hs
      .slice(0, 5)
      .map((h) => `${h.sceneName}(${h.frames}f)`)
      .join(' -> ');

    // Pick highlight scene with richest animation keyframes + action chains
    const animHighlight =
      hs.find((h) => (h.actors || []).some((a) => (a.kfs?.length || 0) >= 2 && (a.actions?.length || 0) >= 2)) ||
      hs.find((h) => (h.actors || []).some((a) => (a.kfs?.length || 0) >= 2)) ||
      hs.find((h) => (h.actors?.length || 0) > 0) ||
      hs[0];

    const cutPattern = (animHighlight?.cuts || [])
      .slice(0, 5)
      .map((c) => `f${c.f}->v${c.v}`)
      .join(', ');

    const actorBlocking = (animHighlight?.actors || [])
      .slice(0, 3)
      .map((a) => {
        const acts = (a.actions || []).slice(0, 4).join(' -> ');
        const kfsStr = (a.kfs || [])
          .slice(0, 3)
          .map((k) => `f${k.f}(${k.x},${k.y},${k.z},rotY:${k.rotY})`)
          .join('->');
        return `${a.name}[${acts || 'At Rest'}]${kfsStr ? ` path=${kfsStr}` : ''}`;
      })
      .join(' | ');

    const propSummary = (animHighlight?.props || [])
      .filter((p) => p.name && p.name !== 'CustomProp')
      .slice(0, 4)
      .map((p) => `${p.name}${p.actions?.length ? `[${p.actions.slice(0, 2).join(',')}]` : ''}`)
      .join(', ');

    const audioTiming = Array.from(
      new Set(
        hs
          .flatMap((h) => h.audio || h.sounds || [])
          .map((raw) => raw.trim())
          .filter((name) => Boolean(name) && !/\.(mp3|mp4)/i.test(name))
      )
    )
      .slice(0, 6)
      .join(', ');

    lines.push(
      `- "${m.title}" [${m.source}, ${m.sceneCount} scenes, rating=${m.rating ?? 'N/A'}/10]: arc=${arc}${
        cutPattern ? `; cuts=${cutPattern}` : ''
      }${actorBlocking ? `; blocking=${actorBlocking}` : ''}${
        propSummary ? `; props=${propSummary}` : ''
      }${audioTiming ? `; audio=${audioTiming}` : ''}`
    );
  }

  return `\nTRAINED .3MM CORPUS ANIMATION, CAMERA & AUDIO EXEMPLARS (${TRAINING_CORPUS.corpusStats?.totalMovies ?? TRAINING_CORPUS.movies.length} movies, ${TRAINING_CORPUS.corpusStats?.totalScenesAnalyzed ?? 670} scenes — emulate multi-action chains, depth/diagonal keyframe paths, rapid viewIndex cuts, and real .3MM MIDIs/SFX/voices):\n${lines.join('\n')}`;
}

function toSdkThinkingLevel(level?: 'MINIMAL' | 'LOW'): ThinkingLevel | undefined {
  if (level === 'MINIMAL') return ThinkingLevel.MINIMAL;
  if (level === 'LOW') return ThinkingLevel.LOW;
  return undefined;
}

async function crawlDirectorFromSites(opts?: {
  threeDmmCookie?: string;
  redditCookie?: string;
}): Promise<{
  directorName: string | null;
  source: '3dmm.com' | 'reddit.com' | 'none';
  message: string;
}> {
  const fetchWithTimeout = async (url: string, headers: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      return await fetch(url, { signal: controller.signal, headers });
    } finally {
      clearTimeout(timer);
    }
  };

  let threeDmmNote = 'not logged in';
  try {
    const h3: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html,application/xhtml+xml',
    };
    if (opts?.threeDmmCookie) h3.Cookie = opts.threeDmmCookie;
    const r3 = await fetchWithTimeout('https://3dmm.com/', h3);
    const html3 = await r3.text();
    if (/cf_chl_opt|Just a moment/i.test(html3)) {
      threeDmmNote = '3dmm.com is behind Cloudflare verification';
    } else {
      const text3 = html3.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const m3 = text3.match(/\bWelcome,\s*([A-Za-z0-9_.\-]{2,36})/i);
      const candidate = m3?.[1]?.trim();
      if (candidate && !/^(to|back|guest|visitor|member)$/i.test(candidate)) {
        return {
          directorName: candidate,
          source: '3dmm.com',
          message: `Found director "${candidate}" from 3dmm.com.`,
        };
      }
    }
  } catch {
    threeDmmNote = '3dmm.com unreachable';
  }

  let redditNote = 'no active Reddit session';
  try {
    const hr: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json,text/html',
    };
    if (opts?.redditCookie) hr.Cookie = opts.redditCookie;
    const rr = await fetchWithTimeout('https://www.reddit.com/api/me.json', hr);
    const rrText = await rr.text();
    if (rr.ok && !/<title>\s*Blocked\s*<\/title>/i.test(rrText)) {
      try {
        const j = JSON.parse(rrText) as { data?: { name?: string } };
        const uname = j?.data?.name?.trim();
        if (uname) {
          return {
            directorName: uname,
            source: 'reddit.com',
            message: `Found director "${uname}" via reddit.com fallback.`,
          };
        }
      } catch {
        // non-JSON fallback check
      }
    } else if (/<title>\s*Blocked\s*<\/title>/i.test(rrText) || rr.status === 403 || rr.status === 429) {
      redditNote = 'reddit.com blocked unauthenticated server crawler';
    }
  } catch {
    redditNote = 'reddit.com unreachable';
  }

  return {
    directorName: null,
    source: 'none',
    message: `Could not auto-detect external account (${threeDmmNote}; ${redditNote}). Enter your Director Name directly below.`,
  };
}

async function generateWithFallback(
  prompt: string,
  catalogSummary: CatalogSummaryPayload,
  directorName?: string
) {
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
  const requestedActorCount = extractRequestedActorCount(trimmedPrompt);
  const targetSceneCount = requestedSceneCount ?? 8;
  const corpusExemplars = selectCompactTrainingExemplars(trimmedPrompt, targetSceneCount);
  const schema = buildGeminiMoviePlanSchema(requestedSceneCount) as unknown as Schema;

  const systemInstruction = buildSystemInstruction({
    prompt: trimmedPrompt,
    requestedSceneCount,
    requestedActorCount,
    corpusExemplars,
    directorName,
  });

  const userMessage = JSON.stringify({
    storyIdea:
      trimmedPrompt.length > 0
        ? trimmedPrompt
        : 'Create a hilarious, imaginative multi-scene (7-10+ scenes with intro & outro/credits) 3D Movie Maker adventure with varied scene lengths, scene transitions (cut/dissolve/fadeToBlack/fadeToWhite), clear setup, progression across different sets, custom character/prop names, multi-actor cast in varied costumes, animated & stretched/colored props, dynamic camera cuts, 3D word, 2D dialogue/credits, and real MIDIs, SFX, and existing voices from catalogSummary.sounds alongside selective new ttsVoices.',
    ...(requestedSceneCount !== null
      ? { requestedSceneCount }
      : { targetSceneRange: '7-12', minimumScenes: 7, supportsIntroAndOutro: true }),
    ...(requestedActorCount !== null ? { requestedActorCount } : {}),
    catalogSummary,
  });

  let lastErr: unknown;
  for (let keyIdx = 0; keyIdx < candidateKeys.length; keyIdx++) {
    const client = createGeminiClient(candidateKeys[keyIdx]);
    for (const entry of MODEL_FALLBACK_CHAIN) {
      const sdkThinking = toSdkThinkingLevel(entry.thinkingLevel);
      try {
        const response = await client.models.generateContent({
          model: entry.model,
          contents: userMessage,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: schema,
            maxOutputTokens: 65536,
            ...(sdkThinking ? { thinkingConfig: { thinkingLevel: sdkThinking } } : {}),
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

        const minimumDesiredScenes = requestedSceneCount ?? 7;
        let safetyRounds = 0;
        while (parsed.scenes.length < minimumDesiredScenes && safetyRounds < 3) {
          safetyRounds++;
          const missing = minimumDesiredScenes - parsed.scenes.length;
          try {
            const extSchema = buildGeminiMoviePlanSchema(missing) as unknown as Schema;
            const extPrompt = JSON.stringify({
              storyIdea:
                trimmedPrompt ||
                'Continue this 3DMM movie adventure seamlessly with rich multi-scene progression, real MIDIs/SFX/sample voices from catalogSummary.sounds, and a climactic finale & outro/credits.',
              existingTitle: parsed.title,
              existingPlot: parsed.plot,
              existingSceneNames: parsed.scenes.map((s: { sceneName?: string }) => s.sceneName),
              instruction: `Continue this exact story seamlessly and generate AT LEAST ${missing} additional distinct scenes so total scenes reaches ${minimumDesiredScenes} or more (>6 scenes). Do NOT repeat existing scenes.`,
              catalogSummary,
            });
            const extResp = await client.models.generateContent({
              model: entry.model,
              contents: extPrompt,
              config: {
                systemInstruction: buildSystemInstruction({
                  prompt: trimmedPrompt,
                  requestedSceneCount: missing,
                  requestedActorCount,
                  corpusExemplars,
                  directorName,
                }),
                responseMimeType: 'application/json',
                responseSchema: extSchema,
                maxOutputTokens: 65536,
                ...(sdkThinking ? { thinkingConfig: { thinkingLevel: sdkThinking } } : {}),
              },
            });
            const extText = extResp.text?.trim();
            if (!extText) break;
            const extParsed = JSON.parse(extText);
            if (Array.isArray(extParsed?.scenes) && extParsed.scenes.length > 0) {
              parsed.scenes = [...parsed.scenes, ...extParsed.scenes];
            } else {
              break;
            }
          } catch (extErr) {
            console.warn('Scene continuation helper skipped:', extErr);
            break;
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

const SAPI4_VOICE_LIMITS: Record<
  string,
  { voice: string; minPitch: number; maxPitch: number; defPitch: number; minSpeed: number; maxSpeed: number; defSpeed: number }
> = {
  bonzi: {
    voice: 'Adult Male #2, American English (TruVoice)',
    minPitch: 50,
    maxPitch: 400,
    defPitch: 140,
    minSpeed: 50,
    maxSpeed: 250,
    defSpeed: 157,
  },
  sam: {
    voice: 'Sam',
    minPitch: 50,
    maxPitch: 200,
    defPitch: 100,
    minSpeed: 30,
    maxSpeed: 450,
    defSpeed: 150,
  },
  mary: {
    voice: 'Mary',
    minPitch: 84,
    maxPitch: 338,
    defPitch: 169,
    minSpeed: 30,
    maxSpeed: 510,
    defSpeed: 170,
  },
  mike: {
    voice: 'Mike',
    minPitch: 84,
    maxPitch: 338,
    defPitch: 112,
    minSpeed: 30,
    maxSpeed: 510,
    defSpeed: 170,
  },
};

function resolveSapi4Params(rawVoice?: string, rawPitch?: number, rawSpeed?: number) {
  const clean = (rawVoice || '').trim();
  const low = clean.toLowerCase();

  let canonical = 'Sam';
  let limits = SAPI4_VOICE_LIMITS.sam;

  if (!clean) {
    canonical = 'Sam';
    limits = SAPI4_VOICE_LIMITS.sam;
  } else if (/bonzi|adult\s*male\s*#?2/i.test(low)) {
    canonical = 'Adult Male #2, American English (TruVoice)';
    limits = SAPI4_VOICE_LIMITS.bonzi;
  } else if (/truvoice|adult\s*(male|female)/i.test(low)) {
    const femaleMatch = low.match(/adult\s*female\s*#?([12])/i);
    const maleMatch = low.match(/adult\s*male\s*#?([1-8])/i);
    if (femaleMatch) {
      canonical = `Adult Female #${femaleMatch[1]}, American English (TruVoice)`;
    } else if (maleMatch) {
      canonical = `Adult Male #${maleMatch[1]}, American English (TruVoice)`;
    } else {
      canonical = 'Adult Male #1, American English (TruVoice)';
    }
    limits = SAPI4_VOICE_LIMITS.bonzi;
  } else if (/mary/i.test(low)) {
    if (/space/i.test(low)) canonical = 'Mary in Space';
    else if (/hall/i.test(low)) canonical = 'Mary in Hall';
    else if (/stadium/i.test(low)) canonical = 'Mary in Stadium';
    else if (/telephone/i.test(low)) canonical = 'Mary (for Telephone)';
    else canonical = 'Mary';
    limits = SAPI4_VOICE_LIMITS.mary;
  } else if (/mike/i.test(low)) {
    if (/space/i.test(low)) canonical = 'Mike in Space';
    else if (/hall/i.test(low)) canonical = 'Mike in Hall';
    else if (/stadium/i.test(low)) canonical = 'Mike in Stadium';
    else if (/telephone/i.test(low)) canonical = 'Mike (for Telephone)';
    else canonical = 'Mike';
    limits = SAPI4_VOICE_LIMITS.mike;
  } else if (/sam/i.test(low)) {
    canonical = 'Sam';
    limits = SAPI4_VOICE_LIMITS.sam;
  }

  const clampNum = (v: unknown, min: number, max: number, fallback: number) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(Math.max(min, Math.min(max, n)));
  };

  return {
    voice: canonical,
    pitch: clampNum(rawPitch, limits.minPitch, limits.maxPitch, limits.defPitch),
    speed: clampNum(rawSpeed, limits.minSpeed, limits.maxSpeed, limits.defSpeed),
  };
}

const ttsCache = new Map<string, string>();
const SAPI4_MAX_ATTEMPTS = 10;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY?.trim() || readDotEnvGeminiKey()),
    });
  });

  app.options(['/api/ai/generate-movie', '/api/ai/generate-movie/'], (_req, res) => {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.sendStatus(204);
  });

  app.post(['/api/tts/sapi4', '/api/tts/sapi4/'], async (req, res) => {
    const { text, voice, pitch, speed } = (req.body || {}) as {
      text?: string;
      voice?: string;
      pitch?: number;
      speed?: number;
    };

    const cleanText = String(text || '').trim().slice(0, 280);
    if (!cleanText) {
      res.status(400).json({ error: 'TTS text is required.' });
      return;
    }

    const params = resolveSapi4Params(voice, pitch, speed);
    const cacheKey = `${params.voice}|${params.pitch}|${params.speed}|${cleanText}`;
    const cached = ttsCache.get(cacheKey);
    if (cached) {
      res.json({ audioData: cached, ...params });
      return;
    }

    const url =
      `https://www.tetyys.com/SAPI4/SAPI4?text=${encodeURIComponent(cleanText)}` +
      `&voice=${encodeURIComponent(params.voice)}` +
      `&pitch=${params.pitch}&speed=${params.speed}`;

    let lastStatus = 502;
    let lastError = '';
    for (let attempt = 1; attempt <= SAPI4_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const upstream = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'BonziBuddy-TTS/1.0',
          },
        });
        lastStatus = upstream.status;
        if (upstream.ok) {
          const buf = Buffer.from(await upstream.arrayBuffer());
          if (buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
            const audioData = `data:audio/wav;base64,${buf.toString('base64')}`;
            if (ttsCache.size > 160) {
              const firstKey = ttsCache.keys().next().value;
              if (firstKey) ttsCache.delete(firstKey);
            }
            ttsCache.set(cacheKey, audioData);
            res.json({ audioData, ...params });
            return;
          }
          lastError = 'Upstream did not return valid RIFF WAV audio.';
        } else {
          lastError = `Upstream HTTP ${upstream.status}`;
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : 'SAPI4 upstream fetch error.';
      } finally {
        clearTimeout(timer);
      }

      if (attempt < SAPI4_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(800, 180 * attempt)));
      }
    }

    res.status(502).json({
      error: `SAPI4 TTS unreachable after ${SAPI4_MAX_ATTEMPTS} attempts (status ${lastStatus}${lastError ? `: ${lastError}` : ''}).`,
    });
  });

  app.all(['/api/director/resolve', '/api/director/resolve/'], async (req, res) => {
    const body = (req.body || {}) as { threeDmmCookie?: string; redditCookie?: string };
    const result = await crawlDirectorFromSites({
      threeDmmCookie: body.threeDmmCookie,
      redditCookie: body.redditCookie,
    });
    res.json(result);
  });

  app.post(['/api/ai/generate-movie', '/api/ai/generate-movie/'], async (req, res) => {
    if (!process.env.GEMINI_API_KEY?.trim() && !readDotEnvGeminiKey()) {
      res.status(500).json({
        error:
          'GEMINI_API_KEY is missing on the server. Add it in Settings > Secrets and try again.',
      });
      return;
    }

    const { prompt, catalogSummary, directorName } = (req.body || {}) as {
      prompt?: string;
      catalogSummary?: CatalogSummaryPayload;
      directorName?: string;
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

    let resolvedDirector = (directorName || '').trim();
    if (!resolvedDirector) {
      const crawled = await crawlDirectorFromSites();
      if (crawled.directorName) {
        resolvedDirector = crawled.directorName;
      }
    }

    try {
      const moviePlan = await generateWithFallback(
        prompt || '',
        catalogSummary,
        resolvedDirector || undefined
      );
      res.json({ moviePlan, directorName: resolvedDirector || undefined });
    } catch (err: unknown) {
      console.error('Gemini movie generation error:', err);
      const message =
        err instanceof Error ? err.message : 'Failed to generate movie with Gemini AI.';
      const status = /PERMISSION_DENIED|403/i.test(message)
        ? 403
        : /RESOURCE_EXHAUSTED|429/i.test(message)
        ? 429
        : /INVALID_ARGUMENT|400/i.test(message)
        ? 400
        : 500;
      res.status(status).json({ error: message });
    }
  });

  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: `Unknown API route: ${req.method} ${req.path}` });
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

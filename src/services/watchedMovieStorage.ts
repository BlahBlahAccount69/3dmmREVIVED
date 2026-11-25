import { ImportedAudioCue, Movie, Scene } from '../types/movie';

export const WATCHED_MOVIE_STORAGE_KEY = '3dmm_watched_movie_v1';

interface StoredWatchedMoviePayload {
  version: 1;
  savedAt: number;
  movie: Movie;
}

function isValidScene(s: unknown): s is Scene {
  if (!s || typeof s !== 'object') return false;
  const obj = s as Partial<Scene>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.bkgdCno === 'number' &&
    typeof obj.sceneName === 'string' &&
    typeof obj.totalFrames === 'number' &&
    Array.isArray(obj.actors) &&
    Array.isArray(obj.props) &&
    Array.isArray(obj.audios)
  );
}

function isValidMovie(m: unknown): m is Movie {
  if (!m || typeof m !== 'object') return false;
  const obj = m as Partial<Movie>;
  if (typeof obj.title !== 'string' || !Array.isArray(obj.scenes)) return false;
  return obj.scenes.every(isValidScene);
}

function trySetItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function stripAudioPayload(cue: ImportedAudioCue, stripAllInlineData: boolean): ImportedAudioCue {
  const hasMsndFallback = typeof cue.msndCno === 'number' && cue.msndCno >= 0;
  if (!stripAllInlineData && !hasMsndFallback) {
    return cue;
  }
  return {
    ...cue,
    audioData: '',
    ...(cue.midiData && (stripAllInlineData || hasMsndFallback) ? { midiData: undefined } : {}),
    ...(cue.playlist
      ? {
          playlist: cue.playlist.map((p) => ({
            ...p,
            audioData: undefined,
            midiData: undefined,
          })),
        }
      : {}),
  };
}

export function saveWatchedMovieToStorage(movie: Movie): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  if (!isValidMovie(movie) || movie.scenes.length === 0) return false;

  const basePayload: StoredWatchedMoviePayload = {
    version: 1,
    savedAt: Date.now(),
    movie,
  };

  try {
    // 1. Try saving full movie intact (including all custom/TTS audio & MIDI data)
    if (trySetItem(WATCHED_MOVIE_STORAGE_KEY, JSON.stringify(basePayload))) {
      return true;
    }

    // 2. Fallback for localStorage quota: strip inline blobs on cues that already have msndCno fallback
    const compactMsndMovie: Movie = {
      ...movie,
      scenes: movie.scenes.map((sc) => ({
        ...sc,
        audios: sc.audios.map((cue) => stripAudioPayload(cue, false)),
      })),
    };
    if (
      trySetItem(
        WATCHED_MOVIE_STORAGE_KEY,
        JSON.stringify({ version: 1, savedAt: Date.now(), movie: compactMsndMovie })
      )
    ) {
      return true;
    }

    // 3. Last-resort quota fallback: strip oversized inline audio blobs (> 24 KB) while keeping small cues & choreography
    const ultraCompactMovie: Movie = {
      ...movie,
      scenes: movie.scenes.map((sc) => ({
        ...sc,
        audios: sc.audios.map((cue) => {
          const totalLen = (cue.audioData?.length || 0) + (cue.midiData?.length || 0);
          return totalLen > 24576 ? stripAudioPayload(cue, true) : stripAudioPayload(cue, false);
        }),
      })),
    };
    return trySetItem(
      WATCHED_MOVIE_STORAGE_KEY,
      JSON.stringify({ version: 1, savedAt: Date.now(), movie: ultraCompactMovie })
    );
  } catch {
    return false;
  }
}

export function loadWatchedMovieFromStorage(): Movie | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(WATCHED_MOVIE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredWatchedMoviePayload> | Movie;
    const candidate =
      parsed && typeof parsed === 'object' && 'movie' in parsed
        ? (parsed as StoredWatchedMoviePayload).movie
        : (parsed as Movie);
    if (!isValidMovie(candidate) || candidate.scenes.length === 0) return null;
    return candidate;
  } catch {
    return null;
  }
}

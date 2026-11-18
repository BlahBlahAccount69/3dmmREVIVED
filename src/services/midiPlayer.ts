import { WorkletSynthesizer } from 'spessasynth_lib';

/**
 * Microsoft GS Wavetable SoundFont MIDI Synthesizer using spessasynth_lib AudioWorklet
 * + /3dmm/soundfont/MS_GS_Wavetable.sf2 (Roland GS Wavetable SoundFont),
 * supporting both Kauai MIDS chunks (millisecond varint deltas) and SMF (.MID) files.
 */

export interface MidiEvent {
  timeMs: number;
  status: number;
  data1: number;
  data2: number;
}

function readVarInt(bytes: Uint8Array, pos: { i: number }): number {
  let val = 0;
  let guard = 0;
  while (pos.i < bytes.length && guard < 5) {
    const b = bytes[pos.i++];
    val = (val << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
    guard++;
  }
  return val;
}

function expectedDataBytes(status: number): number {
  const type = status & 0xf0;
  if (type === 0xc0 || type === 0xd0) return 1;
  return 2;
}

export function parseMidsToEvents(bytes: Uint8Array): { events: MidiEvent[]; durationMs: number } {
  const events: MidiEvent[] = [];
  const pos = { i: 0 };
  let timeMs = 0;
  let runningStatus = 0;

  while (pos.i < bytes.length) {
    const deltaMs = readVarInt(bytes, pos);
    timeMs += Math.max(0, deltaMs);
    if (pos.i >= bytes.length) break;

    let status = bytes[pos.i];
    if (status < 0x80) {
      if (runningStatus === 0) break;
      status = runningStatus;
    } else {
      pos.i++;
      if (status < 0xf0) runningStatus = status;
    }

    if (status === 0xff) {
      if (pos.i >= bytes.length) break;
      const metaType = bytes[pos.i++];
      const len = readVarInt(bytes, pos);
      pos.i += len;
      if (metaType === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const len = readVarInt(bytes, pos);
      pos.i += len;
      continue;
    }

    const needed = expectedDataBytes(status);
    if (pos.i + needed > bytes.length) break;
    const d1 = bytes[pos.i++];
    const d2 = needed === 2 ? bytes[pos.i++] : 0;
    events.push({ timeMs, status, data1: d1, data2: d2 });
  }

  return { events, durationMs: timeMs };
}

export function parseSmfToEvents(bytes: Uint8Array): { events: MidiEvent[]; durationMs: number } {
  if (
    bytes.length < 14 ||
    bytes[0] !== 0x4d ||
    bytes[1] !== 0x54 ||
    bytes[2] !== 0x68 ||
    bytes[3] !== 0x64
  ) {
    return parseMidsToEvents(bytes);
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hdrLen = dv.getUint32(4, false);
  const ntrks = dv.getUint16(10, false);
  const division = dv.getUint16(12, false);
  const ppqn = (division & 0x8000) === 0 ? Math.max(1, division) : 96;

  interface TickEvent {
    tick: number;
    status: number;
    data1: number;
    data2: number;
    tempoUs?: number;
  }

  const rawEvents: TickEvent[] = [];
  let offset = 8 + hdrLen;

  for (let trk = 0; trk < ntrks && offset + 8 <= bytes.length; trk++) {
    const id = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const len = dv.getUint32(offset + 4, false);
    const end = Math.min(bytes.length, offset + 8 + len);
    const pos = { i: offset + 8 };
    offset = end;
    if (id !== 'MTrk') continue;

    let tick = 0;
    let runningStatus = 0;
    while (pos.i < end) {
      tick += readVarInt(bytes, pos);
      if (pos.i >= end) break;
      let status = bytes[pos.i];
      if (status < 0x80) {
        if (runningStatus === 0) break;
        status = runningStatus;
      } else {
        pos.i++;
        if (status < 0xf0) runningStatus = status;
      }

      if (status === 0xff) {
        if (pos.i >= end) break;
        const metaType = bytes[pos.i++];
        const mLen = readVarInt(bytes, pos);
        if (metaType === 0x51 && mLen === 3 && pos.i + 3 <= end) {
          const tempoUs =
            (bytes[pos.i] << 16) | (bytes[pos.i + 1] << 8) | bytes[pos.i + 2];
          rawEvents.push({ tick, status: 0xff, data1: 0x51, data2: 0, tempoUs });
        }
        pos.i += mLen;
        if (metaType === 0x2f) break;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const sLen = readVarInt(bytes, pos);
        pos.i += sLen;
        continue;
      }

      const needed = expectedDataBytes(status);
      if (pos.i + needed > end) break;
      const d1 = bytes[pos.i++];
      const d2 = needed === 2 ? bytes[pos.i++] : 0;
      rawEvents.push({ tick, status, data1: d1, data2: d2 });
    }
  }

  rawEvents.sort((a, b) => a.tick - b.tick);

  let tempoUs = 500000;
  let lastTick = 0;
  let timeMs = 0;
  const events: MidiEvent[] = [];

  for (const ev of rawEvents) {
    const dt = ev.tick - lastTick;
    if (dt > 0) {
      timeMs += (dt * (tempoUs / 1000)) / ppqn;
      lastTick = ev.tick;
    }
    if (ev.status === 0xff && ev.tempoUs) {
      tempoUs = ev.tempoUs;
    } else if (ev.status !== 0xff) {
      events.push({ timeMs, status: ev.status, data1: ev.data1, data2: ev.data2 });
    }
  }

  return { events, durationMs: timeMs };
}

class GsWavetableMidiPlayer {
  private ctx: AudioContext | null = null;
  private synth: WorkletSynthesizer | null = null;
  private synthInitPromise: Promise<WorkletSynthesizer | null> | null = null;
  private schedulerId: number | null = null;
  private playbackToken = 0;

  private ensureAudioContext(externalCtx?: AudioContext): AudioContext {
    if (externalCtx && this.ctx !== externalCtx) {
      this.ctx = externalCtx;
      this.synth = null;
      this.synthInitPromise = null;
    }
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private async ensureSynth(externalCtx?: AudioContext): Promise<WorkletSynthesizer | null> {
    const ctx = this.ensureAudioContext(externalCtx);
    if (this.synth) return this.synth;
    if (this.synthInitPromise) return this.synthInitPromise;

    this.synthInitPromise = (async () => {
      try {
        await ctx.audioWorklet.addModule('/3dmm/soundfont/spessasynth_processor.min.js');
        const synth = new WorkletSynthesizer(ctx);
        synth.connect(ctx.destination);
        await synth.isReady;

        const sfRes = await fetch('/3dmm/soundfont/MS_GS_Wavetable.sf2');
        if (!sfRes.ok) throw new Error(`Failed loading MS_GS_Wavetable.sf2 (${sfRes.status})`);
        const sfBuf = await sfRes.arrayBuffer();
        await synth.soundBankManager.addSoundBank(sfBuf, 'ms_gs_wavetable');
        synth.setSystemParameter('gain', 0.9);
        this.synth = synth;
        return synth;
      } catch (err) {
        console.warn('MS GS Wavetable Worklet init warning:', err);
        this.synthInitPromise = null;
        return null;
      }
    })();

    return this.synthInitPromise;
  }

  public stop() {
    this.playbackToken++;
    if (this.schedulerId !== null) {
      window.clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
    if (this.synth) {
      try {
        this.synth.stopAll(true);
      } catch {
        // ignore
      }
    }
  }

  private dispatchEvent(synth: WorkletSynthesizer, ev: MidiEvent) {
    const type = ev.status & 0xf0;
    const ch = ev.status & 0x0f;
    if (type === 0x90) {
      if (ev.data2 > 0) synth.noteOn(ch, ev.data1, ev.data2);
      else synth.noteOff(ch, ev.data1);
    } else if (type === 0x80) {
      synth.noteOff(ch, ev.data1);
    } else if (type === 0xc0) {
      synth.programChange(ch, ev.data1 & 0x7f);
    } else if (type === 0xb0) {
      synth.controllerChange(
        ch,
        (ev.data1 & 0x7f) as Parameters<WorkletSynthesizer['controllerChange']>[1],
        ev.data2 & 0x7f
      );
    } else if (type === 0xe0) {
      const pitchVal = ((ev.data2 & 0x7f) << 7) | (ev.data1 & 0x7f);
      synth.pitchWheel(ch, pitchVal);
    } else {
      synth.sendMessage([ev.status, ev.data1, ev.data2]);
    }
  }

  public async playEvents(
    events: MidiEvent[],
    durationMs: number,
    options?: { loop?: boolean; audioCtx?: AudioContext }
  ) {
    this.stop();
    if (events.length === 0) return;

    const token = this.playbackToken;
    const synth = await this.ensureSynth(options?.audioCtx);
    if (!synth || token !== this.playbackToken || !this.ctx) return;

    synth.reset();
    const loop = Boolean(options?.loop);
    const safeDur = Math.max(durationMs + 350, 500);
    let idx = 0;
    let songStartMs = performance.now();

    const pump = () => {
      if (token !== this.playbackToken || !this.synth) return;
      const elapsedMs = performance.now() - songStartMs;

      while (idx < events.length && events[idx].timeMs <= elapsedMs + 25) {
        this.dispatchEvent(this.synth, events[idx++]);
      }

      if (idx >= events.length) {
        if (loop) {
          if (elapsedMs >= safeDur) {
            this.synth.stopAll(false);
            songStartMs = performance.now();
            idx = 0;
          }
        } else if (elapsedMs > safeDur + 300) {
          this.stop();
        }
      }
    };

    pump();
    this.schedulerId = window.setInterval(pump, 20);
  }

  public playMidsBytes(bytes: Uint8Array, options?: { loop?: boolean; audioCtx?: AudioContext }) {
    const isSmf =
      bytes.length >= 4 &&
      bytes[0] === 0x4d &&
      bytes[1] === 0x54 &&
      bytes[2] === 0x68 &&
      bytes[3] === 0x64;
    const parsed = isSmf ? parseSmfToEvents(bytes) : parseMidsToEvents(bytes);
    void this.playEvents(parsed.events, parsed.durationMs, options);
  }

  public async playMidiUrl(url: string, options?: { loop?: boolean; audioCtx?: AudioContext }) {
    const res = await fetch(url);
    if (!res.ok) return;
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.playMidsBytes(bytes, options);
  }
}

export const midiPlayer = new GsWavetableMidiPlayer();

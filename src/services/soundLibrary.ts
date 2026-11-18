import { ChunkyFile, getArchive } from './chunkyParser';
import { ImportedAudioCue } from '../types/movie';
import { midiPlayer } from './midiPlayer';

export interface CatalogSoundItem {
  cno: number;
  msndCno: number;
  name: string;
  category: 'sfx' | 'music' | 'speech';
  isMidi: boolean;
}

const MS_ADPCM_ADAPTATION = [
  230, 230, 230, 230, 307, 409, 512, 614,
  768, 614, 512, 409, 307, 230, 230, 230,
];

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(dataUrlOrB64: string): Uint8Array {
  const b64 = dataUrlOrB64.includes(',') ? dataUrlOrB64.split(',')[1] : dataUrlOrB64;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decodes Microsoft ADPCM (wFormatTag = 2) or standard 8/16-bit PCM RIFF WAV files
 * from SNDS.3CN / public/3dmm/sound into Web Audio API AudioBuffer.
 */
function decodeWavBytesToAudioBuffer(
  ctx: AudioContext,
  bytes: Uint8Array
): Promise<AudioBuffer> | AudioBuffer {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (riff !== 'RIFF') {
    return ctx.decodeAudioData(toArrayBuffer(bytes));
  }

  let off = 12;
  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (off + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmtOffset = off + 8;
      fmtSize = size;
    } else if (id === 'data') {
      dataOffset = off + 8;
      dataSize = Math.min(size, bytes.length - dataOffset);
    }
    off += 8 + size + (size & 1);
  }

  if (fmtOffset < 0 || dataOffset < 0) {
    return ctx.decodeAudioData(toArrayBuffer(bytes));
  }

  const formatTag = dv.getUint16(fmtOffset, true);
  if (formatTag !== 2 || fmtSize < 22) {
    return ctx.decodeAudioData(toArrayBuffer(bytes));
  }

  // Microsoft ADPCM software decoder (fmt layout: +16 cbSize, +18 wSamplesPerBlock, +20 wNumCoef, +22 aCoeff)
  const channels = Math.max(1, Math.min(2, dv.getUint16(fmtOffset + 2, true)));
  const sampleRate = dv.getUint32(fmtOffset + 4, true) || 22050;
  const blockAlign = dv.getUint16(fmtOffset + 12, true) || 512;
  const samplesPerBlock = dv.getUint16(fmtOffset + 18, true) || 1012;
  const nCoeff = Math.min(64, dv.getUint16(fmtOffset + 20, true));

  const coeff1: number[] = [];
  const coeff2: number[] = [];
  for (let i = 0; i < nCoeff; i++) {
    coeff1.push(dv.getInt16(fmtOffset + 22 + i * 4, true));
    coeff2.push(dv.getInt16(fmtOffset + 22 + i * 4 + 2, true));
  }
  if (coeff1.length === 0) {
    return ctx.decodeAudioData(toArrayBuffer(bytes));
  }

  const numBlocks = Math.ceil(dataSize / blockAlign);
  const maxSamples = numBlocks * samplesPerBlock;
  const outChannels = Array.from({ length: channels }, () => new Float32Array(maxSamples));
  let totalOut = 0;

  for (let b = 0; b < numBlocks; b++) {
    const bStart = dataOffset + b * blockAlign;
    const bEnd = Math.min(dataOffset + dataSize, bStart + blockAlign);
    if (bEnd - bStart < 7 * channels) break;

    let p = bStart;
    const bPredictor: number[] = [];
    const delta: number[] = [];
    const samp1: number[] = [];
    const samp2: number[] = [];

    for (let ch = 0; ch < channels; ch++) {
      bPredictor.push(Math.min(coeff1.length - 1, bytes[p++]));
    }
    for (let ch = 0; ch < channels; ch++) {
      delta.push(dv.getInt16(p, true));
      p += 2;
    }
    for (let ch = 0; ch < channels; ch++) {
      samp1.push(dv.getInt16(p, true));
      p += 2;
    }
    for (let ch = 0; ch < channels; ch++) {
      samp2.push(dv.getInt16(p, true));
      p += 2;
    }

    let outIdx = totalOut;
    for (let ch = 0; ch < channels; ch++) {
      outChannels[ch][outIdx] = samp2[ch] / 32768;
      if (outIdx + 1 < maxSamples) outChannels[ch][outIdx + 1] = samp1[ch] / 32768;
    }
    outIdx += 2;

    let ch = 0;
    while (p < bEnd && outIdx < totalOut + samplesPerBlock && outIdx < maxSamples) {
      const byteVal = bytes[p++];
      for (const shift of [4, 0]) {
        const nibbleUnsigned = (byteVal >> shift) & 0x0f;
        const nibbleSigned = nibbleUnsigned >= 8 ? nibbleUnsigned - 16 : nibbleUnsigned;
        const idx = bPredictor[ch];
        // Truncating division toward 0 matches C/FFmpeg MS-ADPCM bit-for-bit
        let pred = Math.trunc((samp1[ch] * coeff1[idx] + samp2[ch] * coeff2[idx]) / 256);
        pred += nibbleSigned * delta[ch];
        pred = Math.max(-32768, Math.min(32767, pred));
        samp2[ch] = samp1[ch];
        samp1[ch] = pred;
        delta[ch] = Math.max(16, Math.trunc((MS_ADPCM_ADAPTATION[nibbleUnsigned] * delta[ch]) / 256));
        outChannels[ch][outIdx] = pred / 32768;

        ch++;
        if (ch >= channels) {
          ch = 0;
          outIdx++;
        }
        if (outIdx >= totalOut + samplesPerBlock || outIdx >= maxSamples) break;
      }
    }
    totalOut = outIdx;
  }

  const finalLen = Math.max(1, totalOut);
  const fadeSamples = Math.min(32, Math.floor(finalLen / 8));
  if (fadeSamples > 2) {
    for (let ch = 0; ch < channels; ch++) {
      const buf = outChannels[ch];
      for (let i = 0; i < fadeSamples; i++) {
        const w = (i + 1) / fadeSamples;
        buf[i] *= w;
        buf[finalLen - 1 - i] *= w;
      }
    }
  }

  const audioBuffer = ctx.createBuffer(channels, finalLen, sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    audioBuffer.copyToChannel(outChannels[ch].subarray(0, finalLen), ch);
  }
  return audioBuffer;
}

class Sound3DMMManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private wavRawCache = new Map<string, Promise<Uint8Array | null>>();
  private wavUrlCache = new Map<string, Promise<AudioBuffer | null>>();
  private msndBufferCache = new Map<number, Promise<AudioBuffer | null>>();
  private msndMidsCache = new Map<number, Promise<Uint8Array | null>>();
  private catalogPromise: Promise<CatalogSoundItem[]> | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private activeUiSource: AudioBufferSourceNode | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -8;
      comp.ratio.value = 4;
      comp.attack.value = 0.002;
      comp.release.value = 0.08;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.72;
      gain.connect(comp);
      comp.connect(this.ctx.destination);
      this.masterGain = gain;
    }
    return this.ctx;
  }

  private async ensureReadyCtx(): Promise<AudioContext> {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // ignore
      }
    }
    return ctx;
  }

  private getOutputNode(ctx: AudioContext): AudioNode {
    return this.masterGain || ctx.destination;
  }

  public preloadUiWavs(filenames: string[]) {
    for (const filename of filenames) {
      if (!this.wavRawCache.has(filename)) {
        const p = (async () => {
          const urls = [`/3dmm/sound/${filename}`, `/3dmm/shared_sound/${filename}`];
          for (const url of urls) {
            try {
              const res = await fetch(url);
              if (!res.ok) continue;
              const bytes = new Uint8Array(await res.arrayBuffer());
              if (
                bytes.length >= 12 &&
                bytes[0] === 0x52 &&
                bytes[1] === 0x49 &&
                bytes[2] === 0x46 &&
                bytes[3] === 0x46
              ) {
                return bytes;
              }
            } catch {
              // continue
            }
          }
          return null;
        })();
        this.wavRawCache.set(filename, p);
      }
    }
  }

  public stopMusic() {
    midiPlayer.stop();
  }

  public stopAll() {
    midiPlayer.stop();
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch {
        // ignore
      }
      this.activeSource = null;
    }
    if (this.activeUiSource) {
      try {
        this.activeUiSource.stop();
      } catch {
        // ignore
      }
      this.activeUiSource = null;
    }
  }

  public async playUiWav(filename: string) {
    try {
      const ctx = await this.ensureReadyCtx();
      let bufPromise = this.wavUrlCache.get(filename);
      if (!bufPromise) {
        bufPromise = (async () => {
          this.preloadUiWavs([filename]);
          const raw = await this.wavRawCache.get(filename);
          if (!raw) return null;
          return await decodeWavBytesToAudioBuffer(ctx, raw);
        })();
        this.wavUrlCache.set(filename, bufPromise);
      }
      const buffer = await bufPromise;
      if (!buffer) {
        this.wavUrlCache.delete(filename);
        return;
      }

      if (this.activeUiSource) {
        try {
          this.activeUiSource.stop();
        } catch {
          // ignore
        }
        this.activeUiSource = null;
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 0.55;
      src.connect(gain);
      gain.connect(this.getOutputNode(ctx));
      src.onended = () => {
        if (this.activeUiSource === src) this.activeUiSource = null;
      };
      this.activeUiSource = src;
      src.start();
    } catch {
      this.wavUrlCache.delete(filename);
    }
  }

  public async loadSoundCatalog(): Promise<CatalogSoundItem[]> {
    if (this.catalogPromise) return this.catalogPromise;

    this.catalogPromise = (async () => {
      const soundTh = await getArchive('/3dmm/3dmovie/SOUND.3TH', true);
      const items: CatalogSoundItem[] = [];

      const readList = async (ctg: string, category: CatalogSoundItem['category']) => {
        for (const meta of soundTh.getChunksByType(ctg)) {
          if (!meta.name || /sound stopper/i.test(meta.name)) continue;
          const raw = await soundTh.readChunk(ctg, meta.cno);
          const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          const msndCno = dv.getUint32(8, true);
          items.push({
            cno: meta.cno,
            msndCno,
            name: meta.name,
            category,
            isMidi: category === 'music',
          });
        }
      };

      await Promise.all([
        readList('SFTH', 'sfx'),
        readList('SVTH', 'speech'),
        readList('SMTH', 'music'),
      ]);

      return items;
    })();

    return this.catalogPromise;
  }

  /**
   * Resolves an MSND chunk from either an embedded .3MM ChunkyFile or SNDS.3CN,
   * supporting BOTH WAVE (SFX/Speech) and MIDS (MIDI Music) chunks.
   */
  public async extractMsndCueData(
    msndCno: number,
    customChunky?: ChunkyFile
  ): Promise<{ audioData: string; midiData?: string; isMidi: boolean; name?: string } | null> {
    try {
      const snds = await getArchive('/3dmm/3dmovie/SNDS.3CN', false);
      let archive: ChunkyFile = customChunky || snds;
      let msndMeta = archive.getChunkMeta('MSND', msndCno);
      if (!msndMeta && customChunky) {
        archive = snds;
        msndMeta = snds.getChunkMeta('MSND', msndCno);
      }
      if (!msndMeta) return null;

      const waveKid = archive.findKid(msndMeta, 'WAVE');
      if (waveKid) {
        const ctx = this.ensureCtx();
        const raw = await archive.readChunk('WAVE', waveKid.cno);
        const decoded = await decodeWavBytesToAudioBuffer(ctx, raw);
        const pcm16 = encodeAudioBufferToWav(decoded, false);
        const audioData = await blobToBase64(pcm16);
        return { audioData, isMidi: false, name: msndMeta.name };
      }

      const midsKid = archive.findKid(msndMeta, 'MIDS');
      if (midsKid) {
        const raw = await archive.readChunk('MIDS', midsKid.cno);
        const midiData = `data:audio/x-3dmm-mids;base64,${bytesToBase64(raw)}`;
        return { audioData: '', midiData, isMidi: true, name: msndMeta.name };
      }

      return null;
    } catch {
      return null;
    }
  }

  public async getMsndWaveDataUrl(msndCno: number): Promise<string | null> {
    const res = await this.extractMsndCueData(msndCno);
    return res?.audioData || null;
  }

  private async getStdMsndMids(msndCno: number): Promise<Uint8Array | null> {
    let p = this.msndMidsCache.get(msndCno);
    if (!p) {
      p = (async () => {
        const snds = await getArchive('/3dmm/3dmovie/SNDS.3CN', false);
        const msndMeta = snds.getChunkMeta('MSND', msndCno);
        if (!msndMeta) return null;
        const midsKid = snds.findKid(msndMeta, 'MIDS');
        if (!midsKid) return null;
        return await snds.readChunk('MIDS', midsKid.cno);
      })();
      this.msndMidsCache.set(msndCno, p);
    }
    return p;
  }

  public async playCatalogMsnd(msndCno: number, loop = false) {
    try {
      const ctx = await this.ensureReadyCtx();
      let bufPromise = this.msndBufferCache.get(msndCno);
      if (!bufPromise) {
        bufPromise = (async () => {
          const snds = await getArchive('/3dmm/3dmovie/SNDS.3CN', false);
          const msndMeta = snds.getChunkMeta('MSND', msndCno);
          if (!msndMeta) return null;
          const waveKid = snds.findKid(msndMeta, 'WAVE');
          if (!waveKid) return null;
          const bytes = await snds.readChunk('WAVE', waveKid.cno);
          return decodeWavBytesToAudioBuffer(ctx, bytes);
        })();
        this.msndBufferCache.set(msndCno, bufPromise);
      }
      const buf = await bufPromise;
      if (buf) {
        if (this.activeSource) {
          try {
            this.activeSource.stop();
          } catch {
            // ignore
          }
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.getOutputNode(ctx));
        src.start();
        this.activeSource = src;
        return;
      }

      // Check MIDS (MIDI music)
      const mids = await this.getStdMsndMids(msndCno);
      if (mids) {
        midiPlayer.playMidsBytes(mids, { loop, audioCtx: ctx });
      }
    } catch {
      // Ignore playback error
    }
  }

  public async playCue(cue: ImportedAudioCue) {
    const ctx = await this.ensureReadyCtx();
    if (cue.midiData) {
      midiPlayer.playMidsBytes(base64ToBytes(cue.midiData), {
        loop: cue.loop,
        audioCtx: ctx,
      });
      return;
    }
    if (cue.audioData) {
      await this.playBase64Audio(cue.id, cue.audioData);
      return;
    }
    if (cue.msndCno) {
      await this.playCatalogMsnd(cue.msndCno, cue.loop);
    }
  }

  public async playMidiFileUrl(url: string, loop = true) {
    const ctx = await this.ensureReadyCtx();
    await midiPlayer.playMidiUrl(url, { loop, audioCtx: ctx });
  }

  public async playBase64Audio(_id: string, audioDataUrl: string) {
    try {
      const ctx = await this.ensureReadyCtx();
      const res = await fetch(audioDataUrl);
      const ab = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.getOutputNode(ctx));
      src.start();
    } catch {
      try {
        const audio = new Audio(audioDataUrl);
        void audio.play();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Imports and 8-bit bitcrushes a custom audio file (22050Hz mono 8-bit PCM WAV) to match 3DMM audio,
   * returning a base64 DataURL ready to save directly into the single .3mm.json file.
   */
  public async bitcrushAudioFile(file: File): Promise<string> {
    const ctx = this.ensureCtx();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const targetRate = 22050;
    const duration = Math.min(audioBuffer.duration, 10.0);
    const offlineCtx = new OfflineAudioContext(1, Math.max(1, Math.floor(targetRate * duration)), targetRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const resampled = await offlineCtx.startRendering();
    const blob = encodeAudioBufferToWav(resampled, true);
    return blobToBase64(blob);
  }
}

function encodeAudioBufferToWav(buffer: AudioBuffer, eightBit: boolean): Blob {
  const samples = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const len = samples.length;
  const bytesPerSample = eightBit ? 1 : 2;
  const dataSize = len * bytesPerSample;
  const out = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(out);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * bytesPerSample, true);
  dv.setUint16(32, bytesPerSample, true);
  dv.setUint16(34, eightBit ? 8 : 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);

  if (eightBit) {
    for (let i = 0; i < len; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      const quantized = Math.round(((clamped + 1) * 0.5) * 255);
      dv.setUint8(44 + i, Math.max(0, Math.min(255, quantized)));
    }
  } else {
    for (let i = 0; i < len; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export const sound3DMM = new Sound3DMMManager();

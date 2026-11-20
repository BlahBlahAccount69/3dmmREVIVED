import * as THREE from 'three';
import { ChunkKid } from './chunkyParser';
import { loadBackgroundView, LoadedBackgroundView, loadTemplate } from './threeDmmEngine';
import { loadBasePalette } from './mbmpDecoder';
import {
  KeyframePosition,
  Movie,
  PropEntity,
  Scene,
} from '../types/movie';

/**
 * Binary writer for authentic Microsoft 3D Movie Maker CHN2 .3MM movie archives.
 * Produces valid MVIE -> SCEN -> GGFR / TBOX / ACTR -> PATH / GGAE / MSND (WAVE/MIDS)
 * binary files compatible with loadOfficial3mmMovie and original 3DMM structures.
 */

interface PendingChunk {
  ctg: string;
  cno: number;
  name: string;
  data: Uint8Array;
  kids: ChunkKid[];
}

function writeTagReversed(buf: Uint8Array, off: number, tag: string) {
  const s = tag.padEnd(4, ' ');
  buf[off + 0] = s.charCodeAt(3);
  buf[off + 1] = s.charCodeAt(2);
  buf[off + 2] = s.charCodeAt(1);
  buf[off + 3] = s.charCodeAt(0);
}

function writeFixed16(dv: DataView, off: number, val: number) {
  const fixed = Math.round(val * 65536);
  const clamped = Math.max(-2147483648, Math.min(2147483647, fixed));
  dv.setInt32(off, clamped, true);
}

const _rotEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _rotQuat = new THREE.Quaternion();
const _rotMat = new THREE.Matrix4();

function writeBmat34Rotation(dv: DataView, off: number, rotX: number, rotY: number, rotZ: number) {
  _rotEuler.set(rotX, rotY, rotZ, 'YXZ');
  _rotQuat.setFromEuler(_rotEuler);
  _rotMat.makeRotationFromQuaternion(_rotQuat);
  const el = _rotMat.elements; // column-major: col0=(0,1,2), col1=(4,5,6), col2=(8,9,10)
  writeFixed16(dv, off + 0, el[0]);  // m00
  writeFixed16(dv, off + 4, el[1]);  // m01
  writeFixed16(dv, off + 8, el[2]);  // m02
  writeFixed16(dv, off + 12, el[4]); // m10
  writeFixed16(dv, off + 16, el[5]); // m11
  writeFixed16(dv, off + 20, el[6]); // m12
  writeFixed16(dv, off + 24, el[8]); // m20
  writeFixed16(dv, off + 28, el[9]); // m21
  writeFixed16(dv, off + 32, el[10]); // m22
  writeFixed16(dv, off + 36, 0);     // tx
  writeFixed16(dv, off + 40, 0);     // ty
  writeFixed16(dv, off + 44, 0);     // tz
}

function buildGL(cbEntry: number, entries: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(12 + entries.length * cbEntry);
  const dv = new DataView(out.buffer);
  out[0] = 1;
  out[1] = 0;
  out[2] = 3;
  out[3] = 3;
  dv.setInt32(4, cbEntry, true);
  dv.setInt32(8, entries.length, true);
  for (let i = 0; i < entries.length; i++) {
    out.set(entries[i].subarray(0, cbEntry), 12 + i * cbEntry);
  }
  return out;
}

function buildGG(cbFixed: number, entries: Uint8Array[]): Uint8Array {
  let bvMac = 0;
  for (const e of entries) bvMac += e.length;
  const totalLen = 20 + bvMac + entries.length * 8;
  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  out[0] = 1;
  out[1] = 0;
  out[2] = 3;
  out[3] = 3;
  dv.setInt32(4, entries.length, true);
  dv.setInt32(8, bvMac, true);
  dv.setInt32(12, 0, true);
  dv.setInt32(16, cbFixed, true);

  let bv = 0;
  const locBase = 20 + bvMac;
  for (let i = 0; i < entries.length; i++) {
    out.set(entries[i], 20 + bv);
    dv.setInt32(locBase + i * 8, bv, true);
    dv.setInt32(locBase + i * 8 + 4, entries[i].length, true);
    bv += entries[i].length;
  }
  return out;
}

function encodeStn(name: string): Uint8Array {
  const clean = name.slice(0, 250);
  const out = new Uint8Array(3 + clean.length + 1);
  out[0] = 3;
  out[1] = 3;
  out[2] = clean.length;
  for (let i = 0; i < clean.length; i++) {
    out[3 + i] = clean.charCodeAt(i) & 0xff;
  }
  out[3 + clean.length] = 0;
  return out;
}

function base64ToBytes(dataUrlOrB64: string): Uint8Array {
  const b64 = dataUrlOrB64.includes(',') ? dataUrlOrB64.split(',')[1] : dataUrlOrB64;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class ChunkyBuilder {
  private chunks: PendingChunk[] = [];
  private nextCnoByCtg = new Map<string, number>();

  public allocCno(ctg: string): number {
    const cur = this.nextCnoByCtg.get(ctg) ?? 0;
    this.nextCnoByCtg.set(ctg, cur + 1);
    return cur;
  }

  public addChunk(ctg: string, data: Uint8Array, name = '', kids: ChunkKid[] = [], explicitCno?: number): number {
    const cno = explicitCno ?? this.allocCno(ctg);
    this.chunks.push({ ctg, cno, name, data, kids });
    return cno;
  }

  public build(): Uint8Array {
    const HEADER_SIZE = 128;
    let payloadEnd = HEADER_SIZE;
    const offsets: number[] = [];

    for (const ch of this.chunks) {
      offsets.push(payloadEnd);
      payloadEnd += ch.data.length;
    }

    // Build index entries
    const itemBytesList: Uint8Array[] = [];
    let bvMac = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const ch = this.chunks[i];
      const fp = offsets[i];
      const nameBytes = ch.name ? encodeStn(ch.name) : new Uint8Array(0);
      const itemLen = 20 + ch.kids.length * 12 + nameBytes.length;
      const item = new Uint8Array(itemLen);
      const dv = new DataView(item.buffer);

      writeTagReversed(item, 0, ch.ctg);
      dv.setUint32(4, ch.cno >>> 0, true);
      dv.setInt32(8, fp, true);
      const luGrf = ((ch.data.length & 0x00ffffff) << 8) | 0; // flags=0 uncompressed
      dv.setUint32(12, luGrf >>> 0, true);
      dv.setUint16(16, ch.kids.length, true);
      dv.setUint16(18, 0, true);

      for (let k = 0; k < ch.kids.length; k++) {
        const kid = ch.kids[k];
        const ko = 20 + k * 12;
        writeTagReversed(item, ko, kid.ctg);
        dv.setUint32(ko + 4, kid.cno >>> 0, true);
        dv.setUint32(ko + 8, kid.chid >>> 0, true);
      }

      if (nameBytes.length > 0) {
        item.set(nameBytes, 20 + ch.kids.length * 12);
      }

      itemBytesList.push(item);
      bvMac += itemLen;
    }

    const cbIndex = 20 + bvMac + this.chunks.length * 8;
    const fpIndex = payloadEnd;
    const totalSize = fpIndex + cbIndex;
    const out = new Uint8Array(totalSize);
    const hdrDv = new DataView(out.buffer);

    // 128-byte CHN2 header
    out[0] = 0x43; // 'C'
    out[1] = 0x48; // 'H'
    out[2] = 0x4e; // 'N'
    out[3] = 0x32; // '2'
    out[4] = 0x33; // '3'
    out[5] = 0x44; // 'D'
    out[6] = 0x4d; // 'M'
    out[7] = 0x4d; // 'M'
    hdrDv.setUint16(8, 1, true);
    hdrDv.setUint16(10, 4, true);
    hdrDv.setInt32(12, totalSize, true);
    hdrDv.setInt32(16, fpIndex, true);
    hdrDv.setInt32(20, fpIndex, true);
    hdrDv.setInt32(24, cbIndex, true);

    // Copy payloads
    for (let i = 0; i < this.chunks.length; i++) {
      out.set(this.chunks[i].data, offsets[i]);
    }

    // Write index
    const idxOff = fpIndex;
    const idxDv = new DataView(out.buffer, idxOff, cbIndex);
    out[idxOff + 0] = 1;
    out[idxOff + 1] = 0;
    out[idxOff + 2] = 3;
    out[idxOff + 3] = 3;
    idxDv.setInt32(4, this.chunks.length, true);
    idxDv.setInt32(8, bvMac, true);
    idxDv.setInt32(12, 20, true);
    idxDv.setInt32(16, 8, true);

    let bv = 0;
    const locBase = idxOff + 20 + bvMac;
    for (let i = 0; i < itemBytesList.length; i++) {
      const ib = itemBytesList[i];
      out.set(ib, idxOff + 20 + bv);
      idxDv.setInt32(i * 8 + (locBase - idxOff), bv, true);
      idxDv.setInt32(i * 8 + 4 + (locBase - idxOff), ib.length, true);
      bv += ib.length;
    }

    return out;
  }
}

function stagePointToWorld(
  scene: Scene,
  bgView: LoadedBackgroundView | null,
  kf: KeyframePosition
): KeyframePosition {
  if (scene.coordMode === 'world' || !bgView) {
    return kf;
  }
  const o = bgView.stageOrigin;
  const r = bgView.camRightXZ;
  const f = bgView.camForwardXZ;
  const facingCamRotY = Math.atan2(-f.x, -f.z);
  return {
    ...kf,
    x: o.x + r.x * kf.x - f.x * kf.z,
    y: o.y + kf.y,
    z: o.z + r.z * kf.x - f.z * kf.z,
    rotY: facingCamRotY + (kf.rotY || 0),
  };
}

function buildAevEntry(
  aet: number,
  nfrm: number,
  varBytes: Uint8Array,
  dnFrm = 0,
  irpt = 0,
  dwrOffset = 0
): Uint8Array {
  const out = new Uint8Array(20 + varBytes.length);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, aet, true);
  dv.setInt32(4, nfrm, true);
  dv.setInt32(8, dnFrm, true);
  dv.setInt32(12, irpt, true);
  writeFixed16(dv, 16, dwrOffset);
  if (varBytes.length > 0) out.set(varBytes, 20);
  return out;
}

function buildActorOrPropChunks(
  builder: ChunkyBuilder,
  scene: Scene,
  bgView: LoadedBackgroundView | null,
  opts: {
    tmplCno: number;
    costumeCmids?: number[];
    costumeMtrls?: { ibset: number; mtrlCno: number }[];
    keyframes: Record<number, KeyframePosition>;
    events: {
      frame: number;
      anid?: number;
      celOffset?: number;
      freeze?: boolean;
    }[];
  }
): number {
  const nfrmFirst = 1;
  const aevEntries: Uint8Array[] = [];

  // Costume chunks (aet = 2) at frame 1
  if (opts.costumeCmids) {
    opts.costumeCmids.forEach((cmid, idx) => {
      const vb = new Uint8Array(12);
      const dv = new DataView(vb.buffer);
      dv.setInt32(0, idx, true);
      dv.setInt32(4, cmid, true);
      dv.setInt32(8, 1, true); // fCmtl = true
      aevEntries.push(buildAevEntry(2, nfrmFirst, vb));
    });
  }
  if (opts.costumeMtrls) {
    opts.costumeMtrls.forEach((ov) => {
      const vb = new Uint8Array(28);
      const dv = new DataView(vb.buffer);
      dv.setInt32(0, ov.ibset, true);
      dv.setInt32(4, 0, true);
      dv.setInt32(8, 0, true); // fCmtl = false
      writeTagReversed(vb, 20, 'MTRL');
      dv.setUint32(24, ov.mtrlCno >>> 0, true);
      aevEntries.push(buildAevEntry(2, nfrmFirst, vb));
    });
  }

  // Action & freeze keyframes
  let lastFrozen = false;
  for (const ev of opts.events.sort((a, b) => a.frame - b.frame)) {
    const nfrm = nfrmFirst + Math.max(0, Math.round(ev.frame));
    if (ev.anid !== undefined) {
      const vb = new Uint8Array(8);
      const dv = new DataView(vb.buffer);
      dv.setInt32(0, ev.anid, true);
      dv.setInt32(4, Math.max(0, ev.celOffset ?? 0), true);
      aevEntries.push(buildAevEntry(1, nfrm, vb));
    }
    const wantFrozen = Boolean(ev.freeze);
    if (wantFrozen !== lastFrozen || ev.freeze) {
      const fb = new Uint8Array(4);
      new DataView(fb.buffer).setInt32(0, wantFrozen ? 1 : 0, true);
      aevEntries.push(buildAevEntry(8, nfrm, fb));
      lastFrozen = wantFrozen;
    }
  }

  // Spatial, Scale, Visibility keyframes
  const colorMap: Record<number, string> = {};
  const kfFrames = Object.keys(opts.keyframes).map(Number).sort((a, b) => a - b);
  let lastScaleKey = '1,1,1';
  let wasVisible = true;

  for (const f of kfFrames) {
    const rawKf = opts.keyframes[f];
    const worldKf = stagePointToWorld(scene, bgView, rawKf);
    const nfrm = nfrmFirst + Math.max(0, Math.round(f));

    if (rawKf.color) {
      colorMap[f] = rawKf.color;
    }

    if (rawKf.visible === false) {
      if (wasVisible || f === kfFrames[0]) {
        aevEntries.push(buildAevEntry(11, nfrm, new Uint8Array(0))); // aetRem
        wasVisible = false;
      }
      continue;
    }

    wasVisible = true;
    // aetAdd (0): persistent subroute origin + ya
    const addBuf = new Uint8Array(20);
    const addDv = new DataView(addBuf.buffer);
    writeFixed16(addDv, 0, worldKf.x);
    writeFixed16(addDv, 4, worldKf.y);
    writeFixed16(addDv, 8, worldKf.z);
    addDv.setInt16(14, Math.round(((worldKf.rotY || 0) * 65536) / (Math.PI * 2)), true);
    aevEntries.push(buildAevEntry(0, nfrm, addBuf));

    // aetRotH (12): full-precision 3D orientation matrix (rotX, rotY, rotZ)
    const rotBuf = new Uint8Array(48);
    writeBmat34Rotation(
      new DataView(rotBuf.buffer),
      0,
      worldKf.rotX || 0,
      worldKf.rotY || 0,
      worldKf.rotZ || 0
    );
    aevEntries.push(buildAevEntry(12, nfrm, rotBuf));

    const sx = rawKf.scaleX ?? 1;
    const sy = rawKf.scaleY ?? 1;
    const sz = rawKf.scaleZ ?? 1;
    const skey = `${sx.toFixed(3)},${sy.toFixed(3)},${sz.toFixed(3)}`;
    if (skey !== lastScaleKey || skey !== '1.000,1.000,1.000') {
      const pullBuf = new Uint8Array(12);
      const pdv = new DataView(pullBuf.buffer);
      writeFixed16(pdv, 0, sx);
      writeFixed16(pdv, 4, sy);
      writeFixed16(pdv, 8, sz);
      aevEntries.push(buildAevEntry(4, nfrm, pullBuf)); // aetPull
      lastScaleKey = skey;
    }
  }

  // Sort GGAE events by nfrm
  aevEntries.sort((a, b) => {
    const fa = new DataView(a.buffer, a.byteOffset, 8).getInt32(4, true);
    const fb = new DataView(b.buffer, b.byteOffset, 8).getInt32(4, true);
    return fa - fb;
  });

  const ggaeBytes = buildGG(20, aevEntries);
  const ggaeCno = builder.addChunk('GGAE', ggaeBytes);

  const pathBytes = buildGL(16, []);
  const pathCno = builder.addChunk('PATH', pathBytes);

  const actrKids: ChunkKid[] = [
    { ctg: 'PATH', cno: pathCno, chid: 0 },
    { ctg: 'GGAE', cno: ggaeCno, chid: 0 },
  ];

  if (Object.keys(colorMap).length > 0) {
    const colrBytes = new TextEncoder().encode(JSON.stringify(colorMap));
    const colrCno = builder.addChunk('COLR', colrBytes);
    actrKids.push({ ctg: 'COLR', cno: colrCno, chid: 0 });
  }

  const firstWorld =
    kfFrames.length > 0
      ? stagePointToWorld(scene, bgView, opts.keyframes[kfFrames[0]])
      : { x: 0, y: 0, z: 0, rotY: 0 };

  const actrBytes = new Uint8Array(44);
  const aDv = new DataView(actrBytes.buffer);
  actrBytes[0] = 1;
  actrBytes[1] = 0;
  actrBytes[2] = 3;
  actrBytes[3] = 3;
  writeFixed16(aDv, 4, firstWorld.x);
  writeFixed16(aDv, 8, firstWorld.y);
  writeFixed16(aDv, 12, firstWorld.z);
  writeTagReversed(actrBytes, 36, 'TMPL');
  aDv.setUint32(40, opts.tmplCno >>> 0, true);

  return builder.addChunk('ACTR', actrBytes, '', actrKids);
}

async function resolvePropAnid(prop: PropEntity, actionName: string, explicitAnid?: number): Promise<number> {
  if (explicitAnid !== undefined) return explicitAnid;
  try {
    const tmpl = await loadTemplate(prop.tmplCno);
    const norm = actionName.trim().toLowerCase();
    const match = tmpl.actions.find((a) => a.name.trim().toLowerCase() === norm);
    if (match) return match.anid;
    return tmpl.actions[0]?.anid ?? 0;
  } catch {
    return 0;
  }
}

function findClosestPaletteIndex(pal: Uint8Array, hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  let bestIdx = 30;
  let bestDist = Infinity;
  for (let i = 0; i < 256; i++) {
    const dr = (pal[i * 3 + 0] ?? 0) - r;
    const dg = (pal[i * 3 + 1] ?? 0) - g;
    const db = (pal[i * 3 + 2] ?? 0) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export async function exportMovieTo3mmBytes(movie: Movie): Promise<Uint8Array> {
  const palette = await loadBasePalette().catch(() => null);
  const builder = new ChunkyBuilder();
  const scenKids: ChunkKid[] = [];

  for (let sIdx = 0; sIdx < movie.scenes.length; sIdx++) {
    const scene = movie.scenes[sIdx];
    let bgView: LoadedBackgroundView | null = null;
    try {
      bgView = await loadBackgroundView(scene.bkgdCno, scene.icam);
    } catch {
      bgView = null;
    }

    const nfrmFirst = 1;
    const nfrmLast = nfrmFirst + Math.max(15, scene.totalFrames) - 1;
    const scenChildKids: ChunkKid[] = [];

    // 1. GGFR: Camera cuts (sevt=3) + Audio/MIDI cues (sevt=1)
    const ggfrEntries: { nfrm: number; bytes: Uint8Array }[] = [];

    const cuts =
      scene.cameraCuts && scene.cameraCuts.length > 0
        ? scene.cameraCuts
        : [{ frame: 0, icam: scene.icam }];
    for (const c of cuts) {
      const vb = new Uint8Array(4);
      new DataView(vb.buffer).setInt32(0, c.icam, true);
      const entry = new Uint8Array(12);
      const dv = new DataView(entry.buffer);
      const nfrm = nfrmFirst + Math.max(0, Math.round(c.frame));
      dv.setInt32(0, nfrm, true);
      dv.setInt32(4, 3, true); // sevt = 3 (camera cut)
      entry.set(vb, 8);
      ggfrEntries.push({ nfrm, bytes: entry });
    }

    for (const cue of scene.audios) {
      let targetMsndCno = cue.msndCno ?? -1;
      const isCustomPayload =
        targetMsndCno < 0 ||
        Boolean(cue.audioData && cue.audioData.includes('(8-bit)'));

      if (isCustomPayload && (cue.audioData || cue.midiData)) {
        const msndKids: ChunkKid[] = [];
        const isMidi = Boolean(cue.midiData);
        if (cue.midiData) {
          const midsBytes = base64ToBytes(cue.midiData);
          const midsCno = builder.addChunk('MIDS', midsBytes, cue.filename);
          msndKids.push({ ctg: 'MIDS', cno: midsCno, chid: 0 });
        } else if (cue.audioData) {
          const wavBytes = base64ToBytes(cue.audioData);
          const waveCno = builder.addChunk('WAVE', wavBytes, cue.filename);
          msndKids.push({ ctg: 'WAVE', cno: waveCno, chid: 0 });
        }

        const msndHeader = new Uint8Array(16);
        msndHeader[0] = 1;
        msndHeader[1] = 0;
        msndHeader[2] = 3;
        msndHeader[3] = 3;
        const mdv = new DataView(msndHeader.buffer);
        mdv.setInt32(4, isMidi ? 4 : 3, true); // sty
        mdv.setInt32(8, 1 << 16, true);
        mdv.setInt32(12, isMidi ? 1 : 0, true);
        targetMsndCno = builder.addChunk('MSND', msndHeader, cue.filename, msndKids);
      }

      if (targetMsndCno >= 0) {
        // SSE(16) + TAGC(20) = 36 bytes
        const vb = new Uint8Array(36);
        const vdv = new DataView(vb.buffer);
        vdv.setInt32(0, 256, true); // vlm
        vdv.setInt32(4, cue.isMidi ? 4 : 3, true); // sty
        vdv.setInt32(8, cue.loop ? 1 : 0, true); // fLoop
        vdv.setInt32(12, 1, true); // ctagc = 1
        vdv.setInt32(16, 0, true); // chid
        writeTagReversed(vb, 16 + 12, 'MSND');
        vdv.setUint32(16 + 16, targetMsndCno >>> 0, true);

        const entry = new Uint8Array(8 + vb.length);
        const dv = new DataView(entry.buffer);
        const nfrm = nfrmFirst + Math.max(0, Math.round(cue.frame));
        dv.setInt32(0, nfrm, true);
        dv.setInt32(4, 1, true); // sevt = 1 (sound)
        entry.set(vb, 8);
        ggfrEntries.push({ nfrm, bytes: entry });
      }
    }

    ggfrEntries.sort((a, b) => a.nfrm - b.nfrm);
    const ggfrBytes = buildGG(8, ggfrEntries.map((e) => e.bytes));
    const ggfrCno = builder.addChunk('GGFR', ggfrBytes);
    scenChildKids.push({ ctg: 'GGFR', cno: ggfrCno, chid: 0 });

    // 2. Actors
    let actrChid = 0;
    for (const actor of scene.actors) {
      const akfs = actor.actionKeyframes
        ? Object.entries(actor.actionKeyframes).map(([f, v]) => ({
            frame: Number(f),
            anid: v.anid,
            celOffset: v.celOffset,
            freeze: v.freeze,
          }))
        : [{ frame: 0, anid: actor.anid, celOffset: 0, freeze: false }];

      const actrCno = buildActorOrPropChunks(builder, scene, bgView, {
        tmplCno: actor.tmplCno,
        costumeCmids: actor.costumeCmids,
        costumeMtrls: actor.costumeMtrls,
        keyframes: actor.keyframes,
        events: akfs,
      });
      scenChildKids.push({ ctg: 'ACTR', cno: actrCno, chid: actrChid++ });
    }

    // 3. Props (preserving exact ACTNs like Bang!, Grow Fast, Fly, Open and Close, costumes & colors)
    for (const prop of scene.props) {
      const propEvents = prop.actionKeyframes
        ? await Promise.all(
            Object.entries(prop.actionKeyframes).map(async ([f, v]) => ({
              frame: Number(f),
              anid: await resolvePropAnid(prop, v.action, v.anid),
              celOffset: v.celOffset,
              freeze: v.freeze,
            }))
          )
        : [
            {
              frame: 0,
              anid: await resolvePropAnid(prop, prop.action, prop.anid),
              celOffset: 0,
              freeze: false,
            },
          ];

      const actrCno = buildActorOrPropChunks(builder, scene, bgView, {
        tmplCno: prop.tmplCno,
        costumeCmids: prop.costumeCmids,
        costumeMtrls: prop.costumeMtrls,
        keyframes: prop.keyframes,
        events: propEvents,
      });
      scenChildKids.push({ ctg: 'ACTR', cno: actrCno, chid: actrChid++ });
    }

    // 4. 3D Text (TDT)
    if (scene.tdtTexts) {
      for (const tdt of scene.tdtTexts) {
        const tdtBuf = new Uint8Array(24);
        const tdv = new DataView(tdtBuf.buffer);
        tdtBuf[0] = 1;
        tdtBuf[1] = 0;
        tdtBuf[2] = 3;
        tdtBuf[3] = 3;
        tdv.setInt32(4, tdt.tdts, true);
        tdv.setInt32(20, tdt.tdfCno, true);
        const tdtCno = builder.addChunk('TDT ', tdtBuf, tdt.text);
        const tdtTmplCno = builder.addChunk(
          'TMPL',
          new Uint8Array(16),
          tdt.text,
          [{ ctg: 'TDT ', cno: tdtCno, chid: 0 }],
          100000 + actrChid
        );
        const actrCno = buildActorOrPropChunks(builder, scene, bgView, {
          tmplCno: tdtTmplCno,
          costumeMtrls: tdt.mtrlCno !== undefined ? [{ ibset: 0, mtrlCno: tdt.mtrlCno }] : undefined,
          keyframes: tdt.keyframes,
          events: [],
        });
        scenChildKids.push({ ctg: 'ACTR', cno: actrCno, chid: actrChid++ });
      }
    }

    // 5. 2D Text Boxes (TBOX -> RTXT -> TEXT)
    if (scene.textBoxes) {
      for (let ti = 0; ti < scene.textBoxes.length; ti++) {
        const tb = scene.textBoxes[ti];
        const rawText = new TextEncoder().encode(tb.text);
        const txtBuf = new Uint8Array(2 + rawText.length);
        txtBuf[0] = 3;
        txtBuf[1] = 3;
        txtBuf.set(rawText, 2);
        const txtCno = builder.addChunk('TEXT', txtBuf);

        const fontBytes = new TextEncoder().encode((tb.fontName || 'Comic Sans MS').slice(0, 60));
        const rtxBuf = new Uint8Array(20 + fontBytes.length);
        const rtxDv = new DataView(rtxBuf.buffer);
        rtxBuf[0] = 1;
        rtxBuf[1] = 0;
        rtxBuf[2] = 3;
        rtxBuf[3] = 3;
        rtxDv.setInt32(4, Math.max(40, Math.round(tb.right - tb.left)), true);
        rtxDv.setInt32(8, 14, true);
        if (tb.bgColor && palette) {
          rtxDv.setUint32(12, 0xfe000000 | findClosestPaletteIndex(palette, tb.bgColor), true);
        } else {
          rtxDv.setUint32(12, 0xffffffff, true);
        }
        rtxBuf[18] = fontBytes.length;
        rtxBuf.set(fontBytes, 19);

        const rtxKids: ChunkKid[] = [{ ctg: 'TEXT', cno: txtCno, chid: 0 }];
        const glmpEntries: Uint8Array[] = [];
        const styleFlags = (tb.bold ? 1 : 0) | (tb.italic ? 2 : 0);
        const sizeDelta = (tb.fontSize ?? 14) - 14;
        if (styleFlags !== 0 || sizeDelta !== 0) {
          const e = new Uint8Array(8);
          const edv = new DataView(e.buffer);
          edv.setUint32(0, 0, true);
          e[3] = 1; // CHP
          edv.setInt16(4, styleFlags, true);
          edv.setInt16(6, sizeDelta, true);
          glmpEntries.push(e);
        }
        if (tb.color && palette) {
          const e = new Uint8Array(8);
          const edv = new DataView(e.buffer);
          edv.setUint32(0, 0, true);
          e[3] = 3; // foreground color palette index
          edv.setInt16(4, findClosestPaletteIndex(palette, tb.color), true);
          edv.setInt16(6, 0, true);
          glmpEntries.push(e);
        }
        if (glmpEntries.length > 0) {
          const glmpCno = builder.addChunk('GLMP', buildGL(8, glmpEntries));
          rtxKids.push({ ctg: 'GLMP', cno: glmpCno, chid: 0 });
        }
        const rtxCno = builder.addChunk('RTXT', rtxBuf, '', rtxKids);

        const tbBuf = new Uint8Array(36);
        const tbDv = new DataView(tbBuf.buffer);
        tbBuf[0] = 1;
        tbBuf[1] = 0;
        tbBuf[2] = 3;
        tbBuf[3] = 3;
        tbDv.setInt32(4, nfrmFirst + Math.max(0, Math.round(tb.startFrame)), true);
        tbDv.setInt32(8, nfrmFirst + Math.max(0, Math.round(tb.endFrame)), true);
        tbDv.setInt32(12, Math.round(tb.left), true);
        tbDv.setInt32(16, Math.round(tb.right), true);
        tbDv.setInt32(20, Math.round(tb.top), true);
        tbDv.setInt32(24, Math.round(tb.bottom), true);
        tbDv.setInt32(32, tb.isScrolling ? 0 : 1, true);
        const tbCno = builder.addChunk('TBOX', tbBuf, '', [{ ctg: 'RTXT', cno: rtxCno, chid: 0 }]);
        scenChildKids.push({ ctg: 'TBOX', cno: tbCno, chid: ti });
      }
    }

    const scenBuf = new Uint8Array(16);
    const scenDv = new DataView(scenBuf.buffer);
    scenBuf[0] = 1;
    scenBuf[1] = 0;
    scenBuf[2] = 3;
    scenBuf[3] = 3;
    scenDv.setInt32(4, nfrmLast, true);
    scenDv.setInt32(8, nfrmFirst, true);
    scenDv.setInt32(12, 3, true);

    const scenCno = builder.addChunk('SCEN', scenBuf, scene.sceneName, scenChildKids);
    scenKids.push({ ctg: 'SCEN', cno: scenCno, chid: sIdx });
  }

  const mvieBuf = new Uint8Array(8);
  mvieBuf[0] = 1;
  mvieBuf[1] = 0;
  mvieBuf[2] = 3;
  mvieBuf[3] = 3;
  mvieBuf[4] = 2;
  mvieBuf[6] = 2;
  builder.addChunk('MVIE', mvieBuf, movie.title, scenKids);

  return builder.build();
}

import * as THREE from 'three';

/**
 * Exact Microsoft 3D Movie Maker / Kauai Engine Binary Codecs & Collection Readers.
 * Ported directly from microsoft/Microsoft-3D-Movie-Maker (kauai/SRC/KCD2_386.C & CODKAUAI.CPP & GROUPS.CPP).
 */

export function readTagReversed(bytes: Uint8Array, off: number): string {
  return String.fromCharCode(bytes[off + 3], bytes[off + 2], bytes[off + 1], bytes[off]);
}

export function readStn(bytes: Uint8Array, off: number, maxEnd: number): string {
  if (off + 3 > maxEnd) return '';
  const len = bytes[off + 2];
  const end = Math.min(maxEnd, off + 3 + len);
  let s = '';
  for (let i = off + 3; i < end; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/**
 * KCD2 Decompressor (matching kauai/SRC/KCD2_386.C verbatim).
 * srcAfterFlags begins immediately AFTER the 8-byte header ('KCD2' + BE uint32 len) + 1 byte bFlags.
 */
export function decodeKcd2(srcAfterFlags: Uint8Array, cbUncomp: number): Uint8Array {
  const out = new Uint8Array(cbUncomp);
  const p = new Uint8Array(srcAfterFlags.length + 16);
  p.set(srcAfterFlags, 0);
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);

  let op = 0;
  let sp = 4;
  let ibit = 0;
  let luCur = dv.getUint32(0, true);

  const adv = (cb: number) => {
    if (cb > 0) {
      sp += cb;
      luCur = dv.getUint32(sp - 4, true);
    }
  };

  while (op < cbUncomp) {
    let t = luCur >>> ibit;
    let cbit = 0;
    while ((t & 1) !== 0) {
      cbit++;
      t >>>= 1;
      if (cbit > 11) break;
    }
    if (cbit > 11) break;

    const cbBase = 1 << cbit;
    let cb = cbBase + ((luCur >>> (ibit + cbit + 1)) & (cbBase - 1));
    ibit += 2 * cbit + 1;
    adv(ibit >>> 3);
    ibit &= 7;

    if ((luCur & (1 << ibit)) === 0) {
      ibit++;
      if (cb === 1) {
        out[op++] = (luCur >>> ibit) & 0xff;
        ibit += 8;
        adv(ibit >>> 3);
        ibit &= 7;
      } else if (ibit === 8) {
        for (let i = 0; i < cb && op < cbUncomp; i++) {
          out[op++] = p[sp - 3 + i];
        }
        adv(cb + 1);
        ibit = 0;
      } else {
        const lo = (luCur >>> ibit) & ((1 << (8 - ibit)) - 1);
        for (let i = 0; i < cb - 1 && op < cbUncomp; i++) {
          out[op++] = p[sp - 3 + i];
        }
        adv(cb);
        if (op < cbUncomp) {
          out[op++] = (lo | ((luCur << (8 - ibit)) & 0xff)) & 0xff;
        }
        ibit &= 7;
      }
    } else {
      ibit++;
      cb++;
      let bits = 6;
      let base = 1;
      if ((luCur & (1 << ibit)) === 0) {
        bits = 6;
        base = 1;
        ibit += 1;
      } else if (((luCur >>> ibit) & 3) === 1) {
        bits = 9;
        base = 0x41;
        ibit += 2;
      } else if (((luCur >>> ibit) & 7) === 3) {
        bits = 12;
        base = 0x241;
        ibit += 3;
      } else {
        bits = 20;
        base = 0x1241;
        ibit += 3;
        cb++;
      }

      const dib = base + ((luCur >>> ibit) & ((1 << bits) - 1));
      ibit += bits;
      adv(ibit >>> 3);
      ibit &= 7;

      for (let i = 0; i < cb && op < cbUncomp; i++) {
        out[op] = out[op - dib];
        op++;
      }
    }
  }

  return out;
}

/**
 * KCDC Decompressor (matching kauai/SRC/CODKAUAI.CPP).
 * Used in ACTOR.3TH, PROP.3TH, BKGDS.3TH, MTRL.3TH, SOUND.3TH.
 */
export function decodeKcdc(srcAfterFlags: Uint8Array, cbUncomp: number): Uint8Array {
  const out = new Uint8Array(cbUncomp);
  const p = new Uint8Array(srcAfterFlags.length + 16);
  p.set(srcAfterFlags, 0);
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);

  let op = 0;
  let sp = 4;
  let ibit = 0;
  let luCur = dv.getUint32(0, true);

  const adv = (cb: number) => {
    if (cb > 0) {
      sp += cb;
      luCur = dv.getUint32(sp - 4, true);
    }
  };

  while (op < cbUncomp) {
    if ((luCur & (1 << ibit)) === 0) {
      out[op++] = (luCur >>> (ibit + 1)) & 0xff;
      ibit += 9;
      adv(ibit >>> 3);
      ibit &= 7;
    } else {
      let dib = 0;
      let bits = 0;
      let base = 0;
      let cb = 1;

      if (((luCur >>> (ibit + 1)) & 1) === 0) {
        bits = 6;
        base = 1;
        ibit += 2;
      } else if (((luCur >>> (ibit + 2)) & 1) === 0) {
        bits = 9;
        base = 0x41;
        ibit += 3;
      } else if (((luCur >>> (ibit + 3)) & 1) === 0) {
        bits = 12;
        base = 0x241;
        ibit += 4;
      } else {
        dib = (luCur >>> (ibit + 4)) & 0xfffff;
        if (dib === 0xfffff) break;
        dib += 0x1241;
        ibit += 24;
        cb++;
      }

      if (bits > 0) {
        dib = base + ((luCur >>> ibit) & ((1 << bits) - 1));
        ibit += bits;
      }

      adv(ibit >>> 3);
      ibit &= 7;

      let t = luCur >>> ibit;
      let cbit = 0;
      while ((t & 1) !== 0) {
        cbit++;
        t >>>= 1;
        if (cbit > 11) break;
      }
      if (cbit > 11) break;

      const cbBase = 1 << cbit;
      cb += cbBase + ((luCur >>> (ibit + cbit + 1)) & (cbBase - 1));
      ibit += 2 * cbit + 1;
      adv(ibit >>> 3);
      ibit &= 7;

      for (let i = 0; i < cb && op < cbUncomp; i++) {
        out[op] = out[op - dib];
        op++;
      }
    }
  }

  return out;
}

export function unpackChunkBytes(raw: Uint8Array, isPacked: boolean): Uint8Array {
  if (!isPacked || raw.length < 9) return raw;
  const sig = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const cbUncomp = dv.getUint32(4, false); // big endian
  if (sig === 'KCD2') {
    return decodeKcd2(raw.subarray(9), cbUncomp);
  }
  if (sig === 'KCDC') {
    return decodeKcdc(raw.subarray(9), cbUncomp);
  }
  return raw;
}

export interface KauaiGL {
  cbEntry: number;
  count: number;
  data: Uint8Array;
  dv: DataView;
  entryOffset(index: number): number;
}

export function parseGL(bytes: Uint8Array): KauaiGL {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cbEntry = dv.getInt32(4, true);
  const count = dv.getInt32(8, true);
  return {
    cbEntry,
    count,
    data: bytes,
    dv,
    entryOffset: (index: number) => 12 + index * cbEntry,
  };
}

export interface KauaiGGEntry {
  index: number;
  fixedOffset: number;
  varOffset: number;
  varLength: number;
  totalLength: number;
}

export interface KauaiGG {
  count: number;
  cbFixed: number;
  data: Uint8Array;
  dv: DataView;
  getEntry(index: number): KauaiGGEntry;
}

export function parseGG(bytes: Uint8Array): KauaiGG {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getInt32(4, true);
  const bvMac = dv.getInt32(8, true);
  const cbFixed = dv.getInt32(16, true);
  const dataBase = 20;
  const locBase = 20 + bvMac;

  return {
    count,
    cbFixed,
    data: bytes,
    dv,
    getEntry(index: number): KauaiGGEntry {
      const bv = dv.getInt32(locBase + index * 8, true);
      const cb = dv.getInt32(locBase + index * 8 + 4, true);
      const fixedOffset = dataBase + bv;
      return {
        index,
        fixedOffset,
        varOffset: fixedOffset + cbFixed,
        varLength: Math.max(0, cb - cbFixed),
        totalLength: cb,
      };
    },
  };
}

export function readFixed16(dv: DataView, byteOffset: number): number {
  return dv.getInt32(byteOffset, true) / 65536;
}

export function readBmat34ToMatrix4(dv: DataView, byteOffset: number, target = new THREE.Matrix4()): THREE.Matrix4 {
  const m00 = dv.getInt32(byteOffset + 0, true) / 65536;
  const m01 = dv.getInt32(byteOffset + 4, true) / 65536;
  const m02 = dv.getInt32(byteOffset + 8, true) / 65536;

  const m10 = dv.getInt32(byteOffset + 12, true) / 65536;
  const m11 = dv.getInt32(byteOffset + 16, true) / 65536;
  const m12 = dv.getInt32(byteOffset + 20, true) / 65536;

  const m20 = dv.getInt32(byteOffset + 24, true) / 65536;
  const m21 = dv.getInt32(byteOffset + 28, true) / 65536;
  const m22 = dv.getInt32(byteOffset + 32, true) / 65536;

  const tx = dv.getInt32(byteOffset + 36, true) / 65536;
  const ty = dv.getInt32(byteOffset + 40, true) / 65536;
  const tz = dv.getInt32(byteOffset + 44, true) / 65536;

  return target.set(
    m00, m10, m20, tx,
    m01, m11, m21, ty,
    m02, m12, m22, tz,
    0, 0, 0, 1
  );
}

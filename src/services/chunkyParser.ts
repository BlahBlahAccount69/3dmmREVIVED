import { readStn, readTagReversed, unpackChunkBytes } from './kauaiCodec';

export interface ChunkKid {
  ctg: string;
  cno: number;
  chid: number;
}

export interface ChunkMeta {
  ctg: string;
  cno: number;
  fp: number;
  cb: number;
  flags: number;
  packed: boolean;
  kids: ChunkKid[];
  name: string;
}

/**
 * Browser reader for Microsoft 3D Movie Maker CHN2 chunky archives (.3TH, .3CN, .3MM).
 * Uses HTTP Range requests for large .3CN archives (TMPLS.3CN, BKGDS.3CN, SNDS.3CN) when
 * supported by the static server, falling back cleanly to full-buffer fetch otherwise.
 */
export class ChunkyFile {
  public readonly url: string | null;
  public readonly chunks: ChunkMeta[] = [];
  private byKey = new Map<string, ChunkMeta>();
  private byCtg = new Map<string, ChunkMeta[]>();
  private fullBuffer: Uint8Array | null = null;
  private chunkCache = new Map<string, Uint8Array>();
  private pendingFullLoad: Promise<Uint8Array> | null = null;
  private rangeSupported: boolean | null = null;

  private constructor(url: string | null) {
    this.url = url;
  }

  public static fromBuffer(buffer: ArrayBuffer | Uint8Array, url: string | null = null): ChunkyFile {
    const cf = new ChunkyFile(url);
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    cf.fullBuffer = bytes;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (sig !== 'CHN2') {
      throw new Error(`Invalid ChunkyFile signature "${sig}" (expected CHN2)`);
    }
    const fpIndex = dv.getInt32(20, true);
    const cbIndex = dv.getInt32(24, true);
    cf.parseIndex(bytes.subarray(fpIndex, fpIndex + cbIndex));
    return cf;
  }

  public static async fromUrl(url: string, preloadWhole = false): Promise<ChunkyFile> {
    const cf = new ChunkyFile(url);
    if (preloadWhole) {
      await cf.loadFullBuffer();
      return cf;
    }

    try {
      const headRes = await fetch(url, { headers: { Range: 'bytes=0-63' } });
      if (headRes.status === 206) {
        const headBuf = new Uint8Array(await headRes.arrayBuffer());
        const dv = new DataView(headBuf.buffer, headBuf.byteOffset, headBuf.byteLength);
        const sig = String.fromCharCode(headBuf[0], headBuf[1], headBuf[2], headBuf[3]);
        if (sig === 'CHN2') {
          const fpIndex = dv.getInt32(20, true);
          const cbIndex = dv.getInt32(24, true);
          const idxRes = await fetch(url, {
            headers: { Range: `bytes=${fpIndex}-${fpIndex + cbIndex - 1}` },
          });
          if (idxRes.status === 206) {
            const idxBuf = new Uint8Array(await idxRes.arrayBuffer());
            if (idxBuf.length === cbIndex) {
              cf.rangeSupported = true;
              cf.parseIndex(idxBuf);
              return cf;
            }
          }
        }
      }
    } catch {
      // Fallback below
    }

    cf.rangeSupported = false;
    await cf.loadFullBuffer();
    return cf;
  }

  private async loadFullBuffer(): Promise<Uint8Array> {
    if (this.fullBuffer) return this.fullBuffer;
    if (!this.url) throw new Error('ChunkyFile has no URL or buffer');
    if (this.pendingFullLoad) return this.pendingFullLoad;

    this.pendingFullLoad = fetch(this.url).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to fetch ${this.url}: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      this.fullBuffer = buf;
      if (this.chunks.length === 0) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const fpIndex = dv.getInt32(20, true);
        const cbIndex = dv.getInt32(24, true);
        this.parseIndex(buf.subarray(fpIndex, fpIndex + cbIndex));
      }
      return buf;
    });

    return this.pendingFullLoad;
  }

  private parseIndex(idxBytes: Uint8Array) {
    const dv = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
    const ilocMac = dv.getInt32(4, true);
    const bvMac = dv.getInt32(8, true);
    const dataBase = 20;
    const locBase = dataBase + bvMac;

    for (let i = 0; i < ilocMac; i++) {
      const bv = dv.getInt32(locBase + i * 8, true);
      const cbItem = dv.getInt32(locBase + i * 8 + 4, true);
      const off = dataBase + bv;

      const ctg = readTagReversed(idxBytes, off);
      const cno = dv.getUint32(off + 4, true);
      const fp = dv.getInt32(off + 8, true);
      const luGrf = dv.getUint32(off + 12, true);
      const flags = luGrf & 0xff;
      const cb = luGrf >>> 8;
      const ckid = dv.getUint16(off + 16, true);

      const kids: ChunkKid[] = [];
      for (let k = 0; k < ckid; k++) {
        const ko = off + 20 + k * 12;
        kids.push({
          ctg: readTagReversed(idxBytes, ko),
          cno: dv.getUint32(ko + 4, true),
          chid: dv.getUint32(ko + 8, true),
        });
      }

      const nameOff = off + 20 + ckid * 12;
      const name = readStn(idxBytes, nameOff, off + cbItem);

      const meta: ChunkMeta = {
        ctg,
        cno,
        fp,
        cb,
        flags,
        packed: (flags & 0x04) !== 0,
        kids,
        name,
      };
      this.chunks.push(meta);
      this.byKey.set(`${ctg}:${cno}`, meta);
      let arr = this.byCtg.get(ctg);
      if (!arr) {
        arr = [];
        this.byCtg.set(ctg, arr);
      }
      arr.push(meta);
    }
  }

  public getChunkMeta(ctg: string, cno: number): ChunkMeta | undefined {
    return this.byKey.get(`${ctg}:${cno >>> 0}`);
  }

  public getChunksByType(ctg: string): ChunkMeta[] {
    return this.byCtg.get(ctg) || [];
  }

  public findKid(parent: ChunkMeta, ctg: string, chid?: number): ChunkMeta | undefined {
    const kid = parent.kids.find(
      (k) => k.ctg === ctg && (chid === undefined || k.chid === (chid >>> 0))
    );
    if (!kid) return undefined;
    return this.getChunkMeta(kid.ctg, kid.cno);
  }

  public findKids(parent: ChunkMeta, ctg: string): { kid: ChunkKid; meta: ChunkMeta }[] {
    const res: { kid: ChunkKid; meta: ChunkMeta }[] = [];
    for (const kid of parent.kids) {
      if (kid.ctg === ctg) {
        const meta = this.getChunkMeta(kid.ctg, kid.cno);
        if (meta) res.push({ kid, meta });
      }
    }
    return res;
  }

  public async readRawChunk(ctg: string, cno: number): Promise<Uint8Array> {
    const meta = this.getChunkMeta(ctg, cno);
    if (!meta) throw new Error(`Missing chunk ${ctg}:${cno} in ${this.url || 'buffer'}`);

    if (this.fullBuffer) {
      return this.fullBuffer.subarray(meta.fp, meta.fp + meta.cb);
    }

    if (this.rangeSupported && this.url) {
      const res = await fetch(this.url, {
        headers: { Range: `bytes=${meta.fp}-${meta.fp + meta.cb - 1}` },
      });
      if (res.status === 206) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === meta.cb) return bytes;
      }
    }

    const buf = await this.loadFullBuffer();
    return buf.subarray(meta.fp, meta.fp + meta.cb);
  }

  public async readChunk(ctg: string, cno: number): Promise<Uint8Array> {
    const key = `${ctg}:${cno >>> 0}`;
    const cached = this.chunkCache.get(key);
    if (cached) return cached;

    const meta = this.getChunkMeta(ctg, cno);
    if (!meta) throw new Error(`Missing chunk ${key}`);

    const raw = await this.readRawChunk(ctg, cno);
    const unpacked = unpackChunkBytes(raw, meta.packed);
    this.chunkCache.set(key, unpacked);
    return unpacked;
  }
}

const openArchivePromises = new Map<string, Promise<ChunkyFile>>();

export function getArchive(path: string, preloadWhole = false): Promise<ChunkyFile> {
  const key = `${path}:${preloadWhole ? 'full' : 'lazy'}`;
  let p = openArchivePromises.get(key);
  if (!p) {
    p = ChunkyFile.fromUrl(path, preloadWhole);
    openArchivePromises.set(key, p);
  }
  return p;
}

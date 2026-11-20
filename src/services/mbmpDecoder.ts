import * as THREE from 'three';
import { parseGL } from './kauaiCodec';
import { assetUrl } from '../utils/assetUrl';

/**
 * 256-entry RGB palette [r0, g0, b0, r1, g1, b1, ...].
 */
export type Palette256 = Uint8Array;

let basePalettePromise: Promise<Palette256> | null = null;

/**
 * Loads the official 3DMM master 8-bit palette from /3dmm/bmp/SOCPAL.BMP.
 */
export function loadBasePalette(): Promise<Palette256> {
  if (basePalettePromise) return basePalettePromise;
  basePalettePromise = fetch(assetUrl('3dmm/bmp/SOCPAL.BMP')).then(async (res) => {
    if (!res.ok) throw new Error(`Failed to load SOCPAL.BMP (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const biSize = dv.getUint32(14, true);
    const palOff = 14 + biSize;
    const pal = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const o = palOff + i * 4;
      if (o + 3 <= bytes.length) {
        pal[i * 3 + 0] = bytes[o + 2]; // R
        pal[i * 3 + 1] = bytes[o + 1]; // G
        pal[i * 3 + 2] = bytes[o + 0]; // B
      }
    }
    return pal;
  });
  return basePalettePromise;
}

/**
 * Overlays a BKGD GLCR color table onto the base SOCPAL palette starting at bIndexBase (usually 10).
 * CLR entry is 4 bytes: { bBlue, bGreen, bRed, bZero }.
 */
export function applyGlcrPalette(
  basePal: Palette256,
  glcrBytes: Uint8Array,
  bIndexBase = 10
): Palette256 {
  const pal = new Uint8Array(basePal);
  const gl = parseGL(glcrBytes);
  const count = Math.min(gl.count, 256 - bIndexBase);
  for (let i = 0; i < count; i++) {
    const o = gl.entryOffset(i);
    const dst = (bIndexBase + i) * 3;
    pal[dst + 0] = gl.data[o + 2]; // R
    pal[dst + 1] = gl.data[o + 1]; // G
    pal[dst + 2] = gl.data[o + 0]; // B
  }
  return pal;
}

export interface DecodedMbmp {
  width: number;
  height: number;
  left: number;
  top: number;
  rgba: Uint8ClampedArray;
}

/**
 * Decodes a Kauai MBMP chunk (RLE-encoded 8-bit paletted image with transparency).
 */
export function decodeMbmp(mbmpBytes: Uint8Array, palette: Palette256): DecodedMbmp | null {
  if (mbmpBytes.length < 28) return null;
  const dv = new DataView(mbmpBytes.buffer, mbmpBytes.byteOffset, mbmpBytes.byteLength);
  const fMask = mbmpBytes[4] !== 0;
  const bFill = mbmpBytes[5];
  const left = dv.getInt32(8, true);
  const top = dv.getInt32(12, true);
  const right = dv.getInt32(16, true);
  const bottom = dv.getInt32(20, true);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  const rgcbOff = 28;
  let pxOff = rgcbOff + height * 2;

  for (let y = 0; y < height; y++) {
    const rowLen = dv.getInt16(rgcbOff + y * 2, true);
    const rowEnd = Math.min(mbmpBytes.length, pxOff + Math.max(0, rowLen));
    let p = pxOff;
    let x = 0;

    while (p < rowEnd && x < width) {
      x += mbmpBytes[p++]; // transparent run
      if (p >= rowEnd || x >= width) break;
      const opq = mbmpBytes[p++];
      if (fMask) {
        const r = palette[bFill * 3 + 0];
        const g = palette[bFill * 3 + 1];
        const b = palette[bFill * 3 + 2];
        const count = Math.min(opq, width - x);
        for (let k = 0; k < count; k++) {
          const dst = ((y * width) + x + k) * 4;
          rgba[dst + 0] = r;
          rgba[dst + 1] = g;
          rgba[dst + 2] = b;
          rgba[dst + 3] = 255;
        }
        x += opq;
      } else {
        const count = Math.min(opq, width - x, rowEnd - p);
        for (let k = 0; k < count; k++) {
          const idx = mbmpBytes[p + k];
          const dst = ((y * width) + x + k) * 4;
          rgba[dst + 0] = palette[idx * 3 + 0];
          rgba[dst + 1] = palette[idx * 3 + 1];
          rgba[dst + 2] = palette[idx * 3 + 2];
          rgba[dst + 3] = 255;
        }
        p += opq;
        x += opq;
      }
    }

    pxOff = rowEnd;
  }

  return { width, height, left, top, rgba };
}

let sharedCanvas: HTMLCanvasElement | null = null;

export function mbmpToDataUrl(mbmpBytes: Uint8Array, palette: Palette256): string | null {
  const decoded = decodeMbmp(mbmpBytes, palette);
  if (!decoded) return null;
  if (!sharedCanvas) sharedCanvas = document.createElement('canvas');
  sharedCanvas.width = decoded.width;
  sharedCanvas.height = decoded.height;
  const ctx = sharedCanvas.getContext('2d');
  if (!ctx) return null;
  const imgData = new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height);
  ctx.putImageData(imgData, 0, 0);
  return sharedCanvas.toDataURL('image/png');
}

/**
 * Decodes a BRender TMAP (texture map) chunk into a Three.js DataTexture.
 * In 3DMM TMPLS.3CN, TMAP row 0 corresponds directly to UV v=0 (bottom) and
 * row height-1 to UV v=1 (top), matching BMDL vertex UVs and TXXF transforms.
 */
export function decodeTmapToTexture(tmapBytes: Uint8Array, palette: Palette256): THREE.DataTexture | null {
  if (tmapBytes.length < 20) return null;
  const dv = new DataView(tmapBytes.buffer, tmapBytes.byteOffset, tmapBytes.byteLength);
  const cbRow = dv.getInt16(4, true);
  const type = tmapBytes[6];
  const width = dv.getInt16(12, true);
  const height = dv.getInt16(14, true);
  if (width <= 0 || height <= 0 || width > 2048 || height > 2048) return null;

  const pixStart = tmapBytes.length - height * cbRow;
  const dataStart = pixStart >= 18 ? pixStart : 20;
  const rgba = new Uint8Array(width * height * 4);

  if (type === 3) {
    // BR_PMT_INDEX_8
    for (let y = 0; y < height; y++) {
      const rowOff = dataStart + y * cbRow;
      for (let x = 0; x < width; x++) {
        const idx = tmapBytes[rowOff + x] ?? 0;
        const dst = (y * width + x) * 4;
        rgba[dst + 0] = palette[idx * 3 + 0];
        rgba[dst + 1] = palette[idx * 3 + 1];
        rgba[dst + 2] = palette[idx * 3 + 2];
        rgba[dst + 3] = 255;
      }
    }
  } else if (type === 4 || type === 5) {
    // BR_PMT_RGB_555 or RGB_565
    for (let y = 0; y < height; y++) {
      const rowOff = dataStart + y * cbRow;
      for (let x = 0; x < width; x++) {
        const val = dv.getUint16(rowOff + x * 2, true);
        const dst = (y * width + x) * 4;
        if (type === 4) {
          rgba[dst + 0] = ((val >> 10) & 31) << 3;
          rgba[dst + 1] = ((val >> 5) & 31) << 3;
          rgba[dst + 2] = (val & 31) << 3;
        } else {
          rgba[dst + 0] = ((val >> 11) & 31) << 3;
          rgba[dst + 1] = ((val >> 5) & 63) << 2;
          rgba[dst + 2] = (val & 31) << 3;
        }
        rgba[dst + 3] = 255;
      }
    }
  } else if (type === 6) {
    // BR_PMT_RGB_888
    for (let y = 0; y < height; y++) {
      const rowOff = dataStart + y * cbRow;
      for (let x = 0; x < width; x++) {
        const p = rowOff + x * 3;
        const dst = (y * width + x) * 4;
        rgba[dst + 0] = tmapBytes[p + 2] ?? 0;
        rgba[dst + 1] = tmapBytes[p + 1] ?? 0;
        rgba[dst + 2] = tmapBytes[p + 0] ?? 0;
        rgba[dst + 3] = 255;
      }
    }
  } else {
    return null;
  }

  const tex = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Extracts the dominant uniform skin tone hex from an actor's 8-bit indexed face/skin TMAP
 * (sampling lower chin/cheek & side border pixels, skipping background/black/eye pixels)
 * so hands and non-face body parts never accidentally display eyes/mouth textures.
 */
export function extractSkinHexFromTmap(tmapBytes: Uint8Array, palette: Palette256): string | null {
  if (tmapBytes.length < 20) return null;
  const dv = new DataView(tmapBytes.buffer, tmapBytes.byteOffset, tmapBytes.byteLength);
  const cbRow = dv.getInt16(4, true);
  const type = tmapBytes[6];
  const width = dv.getInt16(12, true);
  const height = dv.getInt16(14, true);
  if (type !== 3 || width <= 8 || height <= 8) return null;

  const pixStart = tmapBytes.length - height * cbRow;
  const dataStart = pixStart >= 18 ? pixStart : 20;

  const buckets = new Map<string, { count: number; rSum: number; gSum: number; bSum: number }>();
  const yStart = Math.floor(height * 0.65);

  for (let y = yStart; y < height; y++) {
    const rowOff = dataStart + y * cbRow;
    for (let x = 0; x < width; x += 2) {
      const idx = tmapBytes[rowOff + x] ?? 0;
      if (idx === 0) continue;
      const r = palette[idx * 3 + 0];
      const g = palette[idx * 3 + 1];
      const b = palette[idx * 3 + 2];
      // Skip near-black hair/outlines and near-white eye whites
      if (r + g + b < 45 || (r > 240 && g > 240 && b > 240)) continue;
      const key = `${r >> 4}_${g >> 4}_${b >> 4}`;
      const entry = buckets.get(key);
      if (entry) {
        entry.count++;
        entry.rSum += r;
        entry.gSum += g;
        entry.bSum += b;
      } else {
        buckets.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
      }
    }
  }

  let best: { count: number; rSum: number; gSum: number; bSum: number } | null = null;
  for (const b of buckets.values()) {
    if (!best || b.count > best.count) best = b;
  }
  if (!best || best.count === 0) return null;
  const rr = Math.round(best.rSum / best.count);
  const gg = Math.round(best.gSum / best.count);
  const bb = Math.round(best.bSum / best.count);
  return (
    '#' +
    [rr, gg, bb].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
  );
}

/**
 * Decodes a BRender 16-bit ZBMP chunk (544x306 depth map per CAM view in BKGDS.3CN)
 * into a lossless RGBA8 DataTexture storing high byte in R and low byte in G.
 * Rows are flipped vertically so v=0 maps to the bottom of the screen in WebGL shaders.
 */
export function decodeZbmpToDepthTexture(
  zbmpBytes: Uint8Array
): { width: number; height: number; texture: THREE.DataTexture } | null {
  if (zbmpBytes.length < 12) return null;
  const dv = new DataView(zbmpBytes.buffer, zbmpBytes.byteOffset, zbmpBytes.byteLength);
  const width = dv.getInt16(8, true);
  const height = dv.getInt16(10, true);
  if (width <= 0 || height <= 0 || width > 2048 || height > 2048) return null;

  const expectedPixBytes = width * height * 2;
  const pixStart = zbmpBytes.length - expectedPixBytes;
  if (pixStart < 8) return null;

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y;
    const srcRowOff = pixStart + srcRow * width * 2;
    const dstRowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const z16 = dv.getUint16(srcRowOff + x * 2, true);
      const dst = dstRowOff + x * 4;
      rgba[dst + 0] = (z16 >>> 8) & 0xff;
      rgba[dst + 1] = z16 & 0xff;
      rgba[dst + 2] = 0;
      rgba[dst + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { width, height, texture };
}

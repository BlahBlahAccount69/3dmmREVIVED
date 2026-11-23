import * as THREE from 'three';
import { TdtAction } from '../types/movie';
import { ChunkyFile, ChunkMeta, getArchive } from './chunkyParser';
import {
  parseGL,
  parseGG,
  readBmat34ToMatrix4,
  readFixed16,
} from './kauaiCodec';
import {
  applyGlcrPalette,
  decodeTmapToTexture,
  decodeZbmpToDepthTexture,
  extractSkinHexFromTmap,
  loadBasePalette,
  mbmpToDataUrl,
  Palette256,
} from './mbmpDecoder';
import { PropAction } from '../types/movie';
import { assetUrl } from '../utils/assetUrl';

export interface CatalogActorItem {
  tmplCno: number;
  tmthCno: number;
  name: string;
  thumbDataUrl: string | null;
}

export interface CatalogPropItem {
  tmplCno: number;
  prthCno: number;
  name: string;
  thumbDataUrl: string | null;
}

export interface CatalogCameraView {
  icam: number;
  cathCno: number;
  thumbDataUrl: string | null;
}

export interface CatalogSceneItem {
  bkgdCno: number;
  name: string;
  thumbDataUrl: string | null;
  views: CatalogCameraView[];
}

export interface ThreeDmmCatalog {
  actors: CatalogActorItem[];
  props: CatalogPropItem[];
  scenes: CatalogSceneItem[];
}

export interface ActionCelPartSpec {
  chidModl: number;
  imat34: number;
}

export interface ParsedAction {
  anid: number;
  name: string;
  grfactn: number;
  cels: {
    dwr: number;
    parts: ActionCelPartSpec[];
  }[];
  matrices: THREE.Matrix4[];
}

export interface ParsedCmtl {
  cmid: number;
  ibset: number;
  materials: THREE.Material[];
  colors: string[];
  tmapCnos: (number | null)[];
  skinHexes: (string | null)[];
  overrideGeometries: (THREE.BufferGeometry | null)[];
}

export interface ParsedTemplate {
  tmplCno: number;
  name: string;
  isProp: boolean;
  isTdt: boolean;
  xaRest: number;
  yaRest: number;
  zaRest: number;
  parentIds: number[];
  bodyPartSets: number[];
  costumeSets: number[][];
  actions: { anid: number; name: string }[];
  defaultPoseActions: ParsedAction[];
  bmdls: Map<number, THREE.BufferGeometry>;
  cmtls: Map<number, ParsedCmtl>;
  actionCache: Map<number, ParsedAction>;
  tmplsFile: ChunkyFile;
  tmplMeta: ChunkMeta;
}

export interface TemplateRig {
  root: THREE.Group;
  bodyRoot: THREE.Group;
  parts: THREE.Group[];
  meshes: THREE.Mesh[];
  baseMaterialColors: THREE.Color[];
  overrideGeometries: (THREE.BufferGeometry | null)[];
  template: ParsedTemplate;
  costumeCmids: number[];
  baseScale: number;
}

export interface LoadedBackgroundView {
  bkgdCno: number;
  bkgdName: string;
  icam: number;
  fovDeg: number;
  hither: number;
  yon: number;
  apos: THREE.Vector3;
  stageOrigin: THREE.Vector3;
  aposes: THREE.Vector3[];
  camMatrix: THREE.Matrix4;
  camPosition: THREE.Vector3;
  camQuaternion: THREE.Quaternion;
  camForwardXZ: THREE.Vector3;
  camRightXZ: THREE.Vector3;
  backdropDataUrl: string | null;
  zbmpDepthTexture: THREE.DataTexture | null;
  lights: { type: number; color: number; intensity: number; matrix: THREE.Matrix4 }[];
}

export interface ParsedTdfFont {
  tdfCno: number;
  name: string;
  widths: number[];
  glyphGeos: Map<number, THREE.BufferGeometry>;
}

let catalogPromise: Promise<ThreeDmmCatalog> | null = null;
const templateCache = new Map<string, Promise<ParsedTemplate>>();
const bgViewCache = new Map<string, Promise<LoadedBackgroundView>>();
const directMtrlCache = new Map<string, Promise<THREE.Material | null>>();
const tdfFontCache = new Map<number, Promise<ParsedTdfFont | null>>();

/**
 * Loads the complete official catalog from ACTOR.3TH, PROP.3TH, BKGDS.3TH, TMPLS.3CN, and BKGDS.3CN:
 * 45 actors, 21 props, 12 scenes (188 camera views) with decoded MBMP thumbnails and authentic names.
 */
export function loadThreeDmmCatalog(): Promise<ThreeDmmCatalog> {
  if (catalogPromise) return catalogPromise;

  catalogPromise = (async () => {
    const [palette, actorTh, propTh, bkgdsTh, tmplsCn, bkgdsCn] = await Promise.all([
      loadBasePalette(),
      getArchive(assetUrl('3dmm/3dmovie/ACTOR.3TH'), true),
      getArchive(assetUrl('3dmm/3dmovie/PROP.3TH'), true),
      getArchive(assetUrl('3dmm/3dmovie/BKGDS.3TH'), true),
      getArchive(assetUrl('3dmm/3dmovie/TMPLS.3CN'), false),
      getArchive(assetUrl('3dmm/3dmovie/BKGDS.3CN'), false),
    ]);

    // Extract 45 Actors
    const actors: CatalogActorItem[] = [];
    for (const tmth of actorTh.getChunksByType('TMTH')) {
      const data = await actorTh.readChunk('TMTH', tmth.cno);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const tmplCno = dv.getUint32(8, true);
      const tmplMeta = tmplsCn.getChunkMeta('TMPL', tmplCno);

      let thumbDataUrl: string | null = null;
      const gokd = actorTh.findKid(tmth, 'GOKD');
      if (gokd) {
        const mbmp = actorTh.findKid(gokd, 'MBMP');
        if (mbmp) {
          const mbmpBytes = await actorTh.readChunk('MBMP', mbmp.cno);
          thumbDataUrl = mbmpToDataUrl(mbmpBytes, palette);
        }
      }

      actors.push({
        tmplCno,
        tmthCno: tmth.cno,
        name: tmplMeta?.name || `Actor ${tmplCno}`,
        thumbDataUrl,
      });
    }

    // Extract 21 Props
    const props: CatalogPropItem[] = [];
    for (const prth of propTh.getChunksByType('PRTH')) {
      const data = await propTh.readChunk('PRTH', prth.cno);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const tmplCno = dv.getUint32(8, true);
      const tmplMeta = tmplsCn.getChunkMeta('TMPL', tmplCno);

      let thumbDataUrl: string | null = null;
      const gokd = propTh.findKid(prth, 'GOKD');
      if (gokd) {
        const mbmp = propTh.findKid(gokd, 'MBMP');
        if (mbmp) {
          const mbmpBytes = await propTh.readChunk('MBMP', mbmp.cno);
          thumbDataUrl = mbmpToDataUrl(mbmpBytes, palette);
        }
      }

      props.push({
        tmplCno,
        prthCno: prth.cno,
        name: tmplMeta?.name || `Prop ${tmplCno}`,
        thumbDataUrl,
      });
    }

    // Extract 12 Scenes + 188 Camera Views
    const scenes: CatalogSceneItem[] = [];
    for (const bkth of bkgdsTh.getChunksByType('BKTH')) {
      const data = await bkgdsTh.readChunk('BKTH', bkth.cno);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const bkgdCno = dv.getUint32(8, true);
      const bkgdMeta = bkgdsCn.getChunkMeta('BKGD', bkgdCno);

      let sceneThumb: string | null = null;
      const rootGokd = bkgdsTh.findKid(bkth, 'GOKD');
      if (rootGokd) {
        const mbmp = bkgdsTh.findKid(rootGokd, 'MBMP');
        if (mbmp) {
          sceneThumb = mbmpToDataUrl(await bkgdsTh.readChunk('MBMP', mbmp.cno), palette);
        }
      }

      const views: CatalogCameraView[] = [];
      const cathKids = bkgdsTh
        .findKids(bkth, 'CATH')
        .sort((a, b) => a.kid.chid - b.kid.chid);

      for (const { kid, meta: cathMeta } of cathKids) {
        const cathData = await bkgdsTh.readChunk('CATH', cathMeta.cno);
        const cathDv = new DataView(
          cathData.buffer,
          cathData.byteOffset,
          cathData.byteLength
        );
        const realIcam = cathData.byteLength >= 12 ? cathDv.getInt32(8, true) : kid.chid;

        let viewThumb: string | null = null;
        const cathGokd = bkgdsTh.findKid(cathMeta, 'GOKD');
        const viewMbmp =
          bkgdsTh.findKid(cathMeta, 'MBMP') ||
          (cathGokd ? bkgdsTh.findKid(cathGokd, 'MBMP') : undefined);
        if (viewMbmp) {
          viewThumb = mbmpToDataUrl(await bkgdsTh.readChunk('MBMP', viewMbmp.cno), palette);
        } else if (kid.chid === 0) {
          viewThumb = sceneThumb;
        }
        views.push({
          icam: realIcam,
          cathCno: cathMeta.cno,
          thumbDataUrl: viewThumb || sceneThumb,
        });
      }

      scenes.push({
        bkgdCno,
        name: (bkgdMeta?.name || `Background ${bkgdCno}`).replace(/\s+Background$/i, ''),
        thumbDataUrl: sceneThumb || views[0]?.thumbDataUrl || null,
        views,
      });
    }

    return { actors, props, scenes };
  })().catch((err) => {
    catalogPromise = null;
    throw err;
  });

  return catalogPromise;
}

/**
 * Parses a BRender BMDL chunk into a Three.js BufferGeometry.
 */
export function parseBmdlGeometry(bmdlBytes: Uint8Array): THREE.BufferGeometry {
  const dv = new DataView(bmdlBytes.buffer, bmdlBytes.byteOffset, bmdlBytes.byteLength);
  const cver = dv.getInt16(4, true);
  const cfac = dv.getInt16(6, true);

  if (cver <= 0 || cfac <= 0) {
    return new THREE.BufferGeometry();
  }

  const positions = new Float32Array(cver * 3);
  const uvs = new Float32Array(cver * 2);

  for (let i = 0; i < cver; i++) {
    const vOff = 48 + i * 32;
    positions[i * 3 + 0] = readFixed16(dv, vOff + 0);
    positions[i * 3 + 1] = readFixed16(dv, vOff + 4);
    positions[i * 3 + 2] = readFixed16(dv, vOff + 8);
    uvs[i * 2 + 0] = readFixed16(dv, vOff + 12);
    uvs[i * 2 + 1] = readFixed16(dv, vOff + 16);
  }

  const indices = new Uint32Array(cfac * 3);
  const brfBase = 48 + cver * 32;
  for (let f = 0; f < cfac; f++) {
    const fOff = brfBase + f * 32;
    indices[f * 3 + 0] = dv.getUint16(fOff + 0, true);
    indices[f * 3 + 1] = dv.getUint16(fOff + 2, true);
    indices[f * 3 + 2] = dv.getUint16(fOff + 4, true);
  }

  // Compute signed volume and centroid-outward score to detect inward-wound shells
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < cver; i++) {
    cx += positions[i * 3 + 0];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  cx /= cver; cy /= cver; cz /= cver;

  let signedVol = 0;
  let outScore = 0;
  for (let f = 0; f < cfac; f++) {
    const i0 = indices[f * 3 + 0], i1 = indices[f * 3 + 1], i2 = indices[f * 3 + 2];
    if (i0 >= cver || i1 >= cver || i2 >= cver) continue;
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
    const cxv = positions[i2 * 3], cyv = positions[i2 * 3 + 1], czv = positions[i2 * 3 + 2];
    signedVol += (ax * (by * czv - bz * cyv) + ay * (bz * cxv - bx * czv) + az * (bx * cyv - by * cxv)) / 6;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cxv - ax, acy = cyv - ay, acz = czv - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const fmx = (ax + bx + cxv) / 3 - cx;
    const fmy = (ay + by + cyv) / 3 - cy;
    const fmz = (az + bz + czv) / 3 - cz;
    outScore += fmx * nx + fmy * ny + fmz * nz;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  computeWeldedSmoothNormals(geo);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  geo.userData.signedVol = signedVol;
  geo.userData.outScore = outScore;
  return geo;
}

/**
 * Welds normals across duplicate spatial vertices (e.g. UV seams in BRender BMDLs)
 * so smooth Gouraud shading flows seamlessly across body & prop contours.
 */
function computeWeldedSmoothNormals(geo: THREE.BufferGeometry) {
  const posAttr = geo.getAttribute('position');
  const normAttr = geo.getAttribute('normal');
  if (!posAttr || !normAttr) return;

  const accum = new Map<string, [number, number, number]>();
  const keys = new Array<string>(posAttr.count);

  for (let i = 0; i < posAttr.count; i++) {
    const key = `${Math.round(posAttr.getX(i) * 500)}_${Math.round(posAttr.getY(i) * 500)}_${Math.round(posAttr.getZ(i) * 500)}`;
    keys[i] = key;
    const nx = normAttr.getX(i);
    const ny = normAttr.getY(i);
    const nz = normAttr.getZ(i);
    const prev = accum.get(key);
    if (prev) {
      prev[0] += nx;
      prev[1] += ny;
      prev[2] += nz;
    } else {
      accum.set(key, [nx, ny, nz]);
    }
  }

  for (let i = 0; i < posAttr.count; i++) {
    const sum = accum.get(keys[i]);
    if (!sum) continue;
    const len = Math.hypot(sum[0], sum[1], sum[2]);
    if (len > 1e-6) {
      normAttr.setXYZ(i, sum[0] / len, sum[1] / len, sum[2] / len);
    }
  }
  normAttr.needsUpdate = true;
}

async function parseMtrlToThree(
  archive: ChunkyFile,
  mtrlMeta: ChunkMeta,
  palette: Palette256
): Promise<{ material: THREE.Material; tmapCno: number | null; skinHex: string | null }> {
  const data = await archive.readChunk('MTRL', mtrlMeta.cno);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = data.length >= 16 ? dv.getUint16(14, true) : 0;
  const bIndexBase = data[14] ?? 0;
  const cIndexRange = data[15] ?? 0;
  // BR_MATF_TWO_SIDED = 0x0800; default BRender rendering is single-sided FrontSide
  const matSide = (flags & 0x0800) !== 0 ? THREE.DoubleSide : THREE.FrontSide;

  const tmapKid = archive.findKid(mtrlMeta, 'TMAP', 0) || archive.findKid(mtrlMeta, 'TMAP');
  if (tmapKid) {
    const tmapBytes = await archive.readChunk('TMAP', tmapKid.cno);
    const tex = decodeTmapToTexture(tmapBytes, palette);
    if (tex) {
      const txxfKid = archive.findKid(mtrlMeta, 'TXXF', 0) || archive.findKid(mtrlMeta, 'TXXF');
      if (txxfKid) {
        const txxfBytes = await archive.readChunk('TXXF', txxfKid.cno);
        if (txxfBytes.length >= 28) {
          const tdv = new DataView(txxfBytes.buffer, txxfBytes.byteOffset, txxfBytes.byteLength);
          const a = readFixed16(tdv, 4);
          const b = readFixed16(tdv, 8);
          const c = readFixed16(tdv, 12);
          const d = readFixed16(tdv, 16);
          const tx = readFixed16(tdv, 20);
          const ty = readFixed16(tdv, 24);

          tex.wrapS =
            Math.abs(a) > 1.005 || Math.abs(c) > 0.01
              ? THREE.RepeatWrapping
              : THREE.ClampToEdgeWrapping;
          tex.wrapT =
            Math.abs(d) > 1.005 || Math.abs(b) > 0.01
              ? THREE.RepeatWrapping
              : THREE.ClampToEdgeWrapping;

          if (Math.abs(b) < 1e-5 && Math.abs(c) < 1e-5) {
            tex.repeat.set(a, d);
            tex.offset.set(tx, ty);
          } else {
            tex.matrixAutoUpdate = false;
            tex.matrix.set(a, c, tx, b, d, ty, 0, 0, 1);
          }
          tex.needsUpdate = true;
        }
      }

      const skinHex = extractSkinHexFromTmap(tmapBytes, palette);
      return {
        material: new THREE.MeshStandardMaterial({
          map: tex,
          flatShading: false,
          roughness: 0.7,
          metalness: 0.05,
          side: matSide,
        }),
        tmapCno: tmapKid.cno,
        skinHex,
      };
    }
  }

  let r = data[6] ?? 180;
  let g = data[5] ?? 180;
  let b = data[4] ?? 180;

  if (cIndexRange > 0 || bIndexBase > 0) {
    const palIdx = Math.min(255, bIndexBase + Math.max(0, Math.floor(cIndexRange * 0.65)));
    r = palette[palIdx * 3 + 0];
    g = palette[palIdx * 3 + 1];
    b = palette[palIdx * 3 + 2];
  }

  return {
    material: new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace),
      flatShading: false,
      roughness: 0.65,
      metalness: 0.08,
      side: matSide,
    }),
    tmapCno: null,
    skinHex: null,
  };
}

export async function resolveMtrlHex(
  mtrlCno: number,
  palette: Palette256,
  overrideArchive?: ChunkyFile
): Promise<string | undefined> {
  const mtrlsCn = await getArchive(assetUrl('3dmm/3dmovie/MTRLS.3CN'), false).catch(() => null);
  const srcArchive =
    overrideArchive?.getChunkMeta('MTRL', mtrlCno) ? overrideArchive : mtrlsCn;
  const meta = srcArchive?.getChunkMeta('MTRL', mtrlCno);
  if (!srcArchive || !meta) return undefined;
  const parsed = await parseMtrlToThree(srcArchive, meta, palette);
  if (parsed.tmapCno !== null) return parsed.skinHex ?? undefined;
  const std = parsed.material as THREE.MeshStandardMaterial;
  return std.color ? '#' + std.color.getHexString() : undefined;
}

export async function loadDirectMtrl(
  mtrlCno: number,
  overrideArchive?: ChunkyFile
): Promise<THREE.Material | null> {
  const key = overrideArchive ? `custom:${mtrlCno}` : `std:${mtrlCno}`;
  const cached = directMtrlCache.get(key);
  if (cached) return cached;
  const p = (async () => {
    const palette = await loadBasePalette();
    if (overrideArchive) {
      const customMeta = overrideArchive.getChunkMeta('MTRL', mtrlCno);
      if (customMeta) return (await parseMtrlToThree(overrideArchive, customMeta, palette)).material;
    }
    const mtrlsCn = await getArchive(assetUrl('3dmm/3dmovie/MTRLS.3CN'), false);
    const meta = mtrlsCn.getChunkMeta('MTRL', mtrlCno);
    if (!meta) return null;
    return (await parseMtrlToThree(mtrlsCn, meta, palette)).material;
  })().catch(() => {
    directMtrlCache.delete(key);
    return null;
  });
  directMtrlCache.set(key, p);
  return p;
}

export function loadTdfFont(tdfCno: number): Promise<ParsedTdfFont | null> {
  const cached = tdfFontCache.get(tdfCno);
  if (cached) return cached;
  const p = (async () => {
    const tdfs = await getArchive(assetUrl('3dmm/3dmovie/TDFS.3CN'), false);
    const tdfMeta = tdfs.getChunkMeta('TDF ', tdfCno) || tdfs.getChunksByType('TDF ')[0];
    if (!tdfMeta) return null;
    const raw = await tdfs.readChunk('TDF ', tdfMeta.cno);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const widths: number[] = [];
    for (let i = 0; i < 256 && 12 + i * 4 + 4 <= raw.length; i++) {
      widths.push(readFixed16(dv, 12 + i * 4));
    }
    return {
      tdfCno: tdfMeta.cno,
      name: tdfMeta.name || `Font ${tdfMeta.cno}`,
      widths,
      glyphGeos: new Map<number, THREE.BufferGeometry>(),
    };
  })().catch(() => {
    tdfFontCache.delete(tdfCno);
    return null;
  });
  tdfFontCache.set(tdfCno, p);
  return p;
}

export const TDF_FONT_OPTIONS = [
  { tdfCno: 2, name: 'Comic' },
  { tdfCno: 0, name: 'Arial MT' },
  { tdfCno: 1, name: 'Arial Round' },
  { tdfCno: 3, name: 'Gill Sans' },
  { tdfCno: 4, name: 'Placard' },
];

export const TDT_SHAPE_OPTIONS = [
  { tdts: 0, name: 'Straight' },
  { tdts: 2, name: 'Arch' },
  { tdts: 1, name: 'Circle' },
  { tdts: 3, name: 'Mountain' },
  { tdts: 4, name: 'Valley' },
  { tdts: 6, name: 'Vertical' },
  { tdts: 7, name: 'Curved' },
];

export interface TdtMaterialSwatch {
  mtrlCno: number;
  hex: string;
}

let tdtMaterialSwatchesPromise: Promise<TdtMaterialSwatch[]> | null = null;

export function loadTdtMaterialSwatches(): Promise<TdtMaterialSwatch[]> {
  if (tdtMaterialSwatchesPromise) return tdtMaterialSwatchesPromise;
  tdtMaterialSwatchesPromise = (async () => {
    const [palette, mtrlsCn] = await Promise.all([
      loadBasePalette(),
      getArchive(assetUrl('3dmm/3dmovie/MTRLS.3CN'), false),
    ]);
    const swatches: TdtMaterialSwatch[] = [];
    for (const meta of mtrlsCn.getChunksByType('MTRL')) {
      if (meta.cno < 25344 || meta.cno > 25360) continue;
      const parsed = await parseMtrlToThree(mtrlsCn, meta, palette);
      const std = parsed.material as THREE.MeshStandardMaterial;
      const hex = std.color ? '#' + std.color.getHexString() : '#f59e0b';
      swatches.push({ mtrlCno: meta.cno, hex });
    }
    return swatches;
  })().catch(() => {
    tdtMaterialSwatchesPromise = null;
    return [];
  });
  return tdtMaterialSwatchesPromise;
}

/**
 * Builds an authentic 3DMM 3D Text THREE.Group using glyph BMDLs from TDFS.3CN,
 * applying tdts layout shape (0=flat, 1=circle, 2=arch, 6=vertical, 7=curved) and MTRL material.
 */
export async function buildTdtTextGroup(
  text: string,
  tdfCno: number,
  tdts: number,
  mtrlCno?: number
): Promise<THREE.Group> {
  const group = new THREE.Group();
  const [font, tdfs, mtrl] = await Promise.all([
    loadTdfFont(tdfCno),
    getArchive(assetUrl('3dmm/3dmovie/TDFS.3CN'), false),
    mtrlCno !== undefined ? loadDirectMtrl(mtrlCno) : Promise.resolve(null),
  ]);

  const material = mtrl
    ? mtrl.clone()
    : new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        flatShading: false,
        roughness: 0.45,
        metalness: 0.15,
        side: THREE.DoubleSide,
      });
  const baseHex = (material as THREE.MeshStandardMaterial).color
    ? '#' + (material as THREE.MeshStandardMaterial).color.getHexString()
    : '#f59e0b';
  group.userData.baseColor = baseHex;

  if (!font) return group;
  const tdfMeta = tdfs.getChunkMeta('TDF ', font.tdfCno);
  if (!tdfMeta) return group;

  const normalizedText = (text || '')
    .replace(/\r\n/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
  const chars = Array.from(normalizedText);
  const charCodes = chars.map((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 32 && code <= 255 ? code : 32;
  });

  await Promise.all(
    Array.from(new Set(charCodes)).map(async (code) => {
      if (font.glyphGeos.has(code)) return;
      const kid = tdfs.findKid(tdfMeta, 'BMDL', code);
      if (kid) {
        const bytes = await tdfs.readChunk('BMDL', kid.cno);
        font.glyphGeos.set(code, parseBmdlGeometry(bytes));
      } else {
        // Fallback to swapped ASCII case if glyph BMDL is absent
        const alt =
          code >= 97 && code <= 122 ? code - 32 : code >= 65 && code <= 90 ? code + 32 : -1;
        if (alt >= 32) {
          const altKid = tdfs.findKid(tdfMeta, 'BMDL', alt);
          if (altKid) {
            const bytes = await tdfs.readChunk('BMDL', altKid.cno);
            font.glyphGeos.set(code, parseBmdlGeometry(bytes));
          }
        }
      }
    })
  );

  const advances = charCodes.map((c) => {
    const w = font.widths[c] ?? 3.0;
    return w > 0.1 ? w : 2.5;
  });
  const totalWidth = advances.reduce((a, b) => a + b, 0);

  if (tdts === 6) {
    // Vertical stack
    let curY = (chars.length - 1) * 5.2;
    for (let i = 0; i < charCodes.length; i++) {
      const geo = font.glyphGeos.get(charCodes[i]);
      if (geo && geo.attributes.position) {
        const mesh = new THREE.Mesh(geo, material);
        mesh.position.set(0, curY, 0);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.restPos = mesh.position.clone();
        mesh.userData.restRotY = mesh.rotation.y;
        mesh.userData.restRotZ = mesh.rotation.z;
        mesh.userData.restScaleY = mesh.scale.y;
        mesh.userData.charIdx = i;
        mesh.userData.xrFract = charCodes.length > 1 ? i / (charCodes.length - 1) : 0.5;
        group.add(mesh);
      }
      curY -= 5.4;
    }
    return group;
  }

  let curX = -totalWidth * 0.5;

  for (let i = 0; i < charCodes.length; i++) {
    const adv = advances[i];
    const cx = curX + adv * 0.5;
    curX += adv;

    const geo = font.glyphGeos.get(charCodes[i]);
    if (!geo || !geo.attributes.position) continue;

    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const normPos = totalWidth > 0.1 ? cx / (totalWidth * 0.5) : 0; // -1..1
    const xrFract = totalWidth > 0.1 ? (cx + totalWidth * 0.5) / totalWidth : 0.5;
    if (tdts === 1) {
      // Circle / Ring wrap
      const radius = Math.max(8, totalWidth / (2 * Math.PI) + 4);
      const theta = (normPos * Math.PI * 0.85);
      mesh.position.set(Math.sin(theta) * radius, 0, Math.cos(theta) * radius - radius);
      mesh.rotation.y = theta;
    } else if (tdts === 2 || tdts === 7) {
      // Arch / Curved ribbon
      const archY = (1 - normPos * normPos) * 3.5;
      mesh.position.set(cx, archY, 0);
      mesh.rotation.z = -normPos * 0.25;
    } else if (tdts === 3) {
      // Mountain / Pyramid scale
      const s = 1.0 + (1 - Math.abs(normPos)) * 0.65;
      mesh.position.set(cx, 0, 0);
      mesh.scale.set(1, s, 1);
    } else if (tdts === 4) {
      // Valley
      const s = 0.75 + Math.abs(normPos) * 0.65;
      mesh.position.set(cx, 0, 0);
      mesh.scale.set(1, s, 1);
    } else {
      // 0 = Standard flat straight horizontal 3D text
      mesh.position.set(cx, 0, 0);
    }

    mesh.userData.restPos = mesh.position.clone();
    mesh.userData.restRotY = mesh.rotation.y;
    mesh.userData.restRotZ = mesh.rotation.z;
    mesh.userData.restScaleY = mesh.scale.y;
    mesh.userData.charIdx = i;
    mesh.userData.xrFract = Math.max(0, Math.min(1, xrFract));
    group.add(mesh);
  }

  return group;
}

async function parseCmtl(
  archive: ChunkyFile,
  cmtlMeta: ChunkMeta,
  cmid: number,
  palette: Palette256
): Promise<ParsedCmtl> {
  const bytes = await archive.readChunk('CMTL', cmtlMeta.cno);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ibset = dv.getInt32(4, true);

  let maxChid = -1;
  for (const k of cmtlMeta.kids) {
    if (k.ctg === 'MTRL' || k.ctg === 'BMDL') {
      if ((k.chid | 0) > maxChid) maxChid = k.chid | 0;
    }
  }
  const cbprt = maxChid + 1;
  const materials: THREE.Material[] = [];
  const colors: string[] = [];
  const tmapCnos: (number | null)[] = [];
  const skinHexes: (string | null)[] = [];
  const overrideGeometries: (THREE.BufferGeometry | null)[] = [];

  for (let i = 0; i < cbprt; i++) {
    const mKid = archive.findKid(cmtlMeta, 'MTRL', i);
    if (mKid) {
      const parsed = await parseMtrlToThree(archive, mKid, palette);
      materials.push(parsed.material);
      tmapCnos.push(parsed.tmapCno);
      skinHexes.push(parsed.skinHex);
      const stdMat = parsed.material as THREE.MeshStandardMaterial;
      colors.push(parsed.skinHex || ('#' + (stdMat.color ? stdMat.color.getHexString() : 'cccccc')));
    } else {
      materials.push(
        new THREE.MeshStandardMaterial({
          color: 0xcccccc,
          flatShading: false,
          roughness: 0.68,
        })
      );
      tmapCnos.push(null);
      skinHexes.push(null);
      colors.push('#cccccc');
    }

    const bKid = archive.findKid(cmtlMeta, 'BMDL', i);
    if (bKid) {
      const bData = await archive.readChunk('BMDL', bKid.cno);
      overrideGeometries.push(parseBmdlGeometry(bData));
    } else {
      overrideGeometries.push(null);
    }
  }

  return { cmid, ibset, materials, colors, tmapCnos, skinHexes, overrideGeometries };
}

export async function loadAction(
  template: ParsedTemplate,
  anid: number
): Promise<ParsedAction | null> {
  const cached = template.actionCache.get(anid);
  if (cached) return cached;

  const actnMeta = template.tmplsFile.findKid(template.tmplMeta, 'ACTN', anid);
  if (!actnMeta) return null;

  const archive = template.tmplsFile;
  const actnBytes = await archive.readChunk('ACTN', actnMeta.cno);
  const actnDv = new DataView(actnBytes.buffer, actnBytes.byteOffset, actnBytes.byteLength);
  const grfactn = actnBytes.length >= 8 ? actnDv.getUint32(4, true) : 0;

  const ggclMeta = archive.findKid(actnMeta, 'GGCL', 0) || archive.findKid(actnMeta, 'GGCL');
  const glxfMeta = archive.findKid(actnMeta, 'GLXF', 0) || archive.findKid(actnMeta, 'GLXF');
  if (!ggclMeta || !glxfMeta) return null;

  const [ggclBytes, glxfBytes] = await Promise.all([
    archive.readChunk('GGCL', ggclMeta.cno),
    archive.readChunk('GLXF', glxfMeta.cno),
  ]);

  const glxf = parseGL(glxfBytes);
  const matrices: THREE.Matrix4[] = [];
  for (let i = 0; i < glxf.count; i++) {
    matrices.push(readBmat34ToMatrix4(glxf.dv, glxf.entryOffset(i)));
  }

  const ggcl = parseGG(ggclBytes);
  const cels: ParsedAction['cels'] = [];
  const neededBmdls: Promise<void>[] = [];

  for (let icel = 0; icel < ggcl.count; icel++) {
    const entry = ggcl.getEntry(icel);
    const dwr = readFixed16(ggcl.dv, entry.fixedOffset + 4);
    const cpsCount = Math.floor(entry.varLength / 4);
    const parts: ActionCelPartSpec[] = [];

    for (let ip = 0; ip < cpsCount; ip++) {
      const off = entry.varOffset + ip * 4;
      const chidModl = ggcl.dv.getInt16(off, true);
      const imat34 = ggcl.dv.getInt16(off + 2, true);
      parts.push({ chidModl, imat34 });

      if (chidModl >= 0 && !template.bmdls.has(chidModl)) {
        const bKid = archive.findKid(template.tmplMeta, 'BMDL', chidModl);
        if (bKid) {
          neededBmdls.push(
            archive.readChunk('BMDL', bKid.cno).then((raw) => {
              template.bmdls.set(chidModl, parseBmdlGeometry(raw));
            })
          );
        }
      }
    }
    cels.push({ dwr, parts });
  }

  if (neededBmdls.length > 0) {
    await Promise.all(neededBmdls);
  }

  const action: ParsedAction = {
    anid,
    name: actnMeta.name || (anid === 0 ? 'At Rest' : `Action ${anid}`),
    grfactn,
    cels,
    matrices,
  };
  template.actionCache.set(anid, action);
  return action;
}

/**
 * Loads and parses a real TMPL (actor or prop) from TMPLS.3CN (or an embedded ChunkyFile from a .3MM).
 */
export function loadTemplate(
  tmplCno: number,
  overrideArchive?: ChunkyFile
): Promise<ParsedTemplate> {
  const key = overrideArchive ? `custom:${tmplCno}` : `std:${tmplCno}`;
  if (!overrideArchive) {
    const cached = templateCache.get(key);
    if (cached) return cached;
  }

  const p = (async () => {
    const [palette, tmplsFile] = await Promise.all([
      loadBasePalette(),
      overrideArchive ? Promise.resolve(overrideArchive) : getArchive(assetUrl('3dmm/3dmovie/TMPLS.3CN'), false),
    ]);

    const tmplMeta = tmplsFile.getChunkMeta('TMPL', tmplCno);
    if (!tmplMeta) throw new Error(`TMPL:${tmplCno} not found`);

    const tmplBytes = await tmplsFile.readChunk('TMPL', tmplCno);
    const tmplDv = new DataView(tmplBytes.buffer, tmplBytes.byteOffset, tmplBytes.byteLength);
    const xaRest = tmplBytes.length >= 10 ? (tmplDv.getInt16(4, true) * Math.PI * 2) / 65536 : 0;
    const yaRest = tmplBytes.length >= 10 ? (tmplDv.getInt16(6, true) * Math.PI * 2) / 65536 : Math.PI / 2;
    const zaRest = tmplBytes.length >= 10 ? (tmplDv.getInt16(8, true) * Math.PI * 2) / 65536 : 0;
    const grftmpl = tmplBytes.length >= 16 ? tmplDv.getUint32(12, true) : 0;
    const isTdt = (grftmpl & 2) !== 0;
    const isProp = (grftmpl & 4) !== 0;

    const glpiMeta = tmplsFile.findKid(tmplMeta, 'GLPI');
    const glbsMeta = tmplsFile.findKid(tmplMeta, 'GLBS');
    const ggcmMeta = tmplsFile.findKid(tmplMeta, 'GGCM');

    const parentIds: number[] = [];
    if (glpiMeta) {
      const gl = parseGL(await tmplsFile.readChunk('GLPI', glpiMeta.cno));
      for (let i = 0; i < gl.count; i++) {
        parentIds.push(gl.dv.getInt16(gl.entryOffset(i), true));
      }
    }

    const bodyPartSets: number[] = [];
    if (glbsMeta) {
      const gl = parseGL(await tmplsFile.readChunk('GLBS', glbsMeta.cno));
      for (let i = 0; i < gl.count; i++) {
        bodyPartSets.push(gl.dv.getInt16(gl.entryOffset(i), true));
      }
    }

    const costumeSets: number[][] = [];
    if (ggcmMeta) {
      const gg = parseGG(await tmplsFile.readChunk('GGCM', ggcmMeta.cno));
      for (let i = 0; i < gg.count; i++) {
        const e = gg.getEntry(i);
        const cnt = Math.floor(e.varLength / 4);
        const ids: number[] = [];
        for (let k = 0; k < cnt; k++) {
          ids.push(gg.dv.getInt32(e.varOffset + k * 4, true));
        }
        costumeSets.push(ids);
      }
    }

    // List all ACTNs cleanly
    const actnKids = tmplsFile
      .findKids(tmplMeta, 'ACTN')
      .sort((a, b) => a.kid.chid - b.kid.chid);
    const actions = actnKids.map(({ kid, meta }) => ({
      anid: kid.chid,
      name: (meta.name || (kid.chid === 0 ? 'At Rest' : `Action ${kid.chid}`)).replace(/\s*\*$/, ''),
    }));

    // Load ALL CMTL costumes/textures cleanly (no artificial cap) so every texture & costume works
    const cmtls = new Map<number, ParsedCmtl>();
    const cmtlKids = tmplsFile.findKids(tmplMeta, 'CMTL');
    await Promise.all(
      cmtlKids.map(async ({ kid, meta }) => {
        const parsed = await parseCmtl(tmplsFile, meta, kid.chid, palette);
        cmtls.set(kid.chid, parsed);
      })
    );

    const parsedTemplate: ParsedTemplate = {
      tmplCno,
      name: tmplMeta.name || `Model ${tmplCno}`,
      isProp,
      isTdt,
      xaRest,
      yaRest,
      zaRest,
      parentIds,
      bodyPartSets,
      costumeSets,
      actions,
      defaultPoseActions: [],
      bmdls: new Map(),
      cmtls,
      actionCache: new Map(),
      tmplsFile,
      tmplMeta,
    };

    // Always preload Action 0 ('At Rest') so initial geometry & skeleton are ready immediately
    const act0 = await loadAction(parsedTemplate, 0);
    if (act0) parsedTemplate.defaultPoseActions.push(act0);

    // Flag isolated inward-wound open shells (e.g., Parachute canopy) that have no outward sibling twin,
    // so they remain visible from both sides while paired opposing-winding shells stay FrontSide.
    const geos = Array.from(parsedTemplate.bmdls.values());
    for (const geo of geos) {
      const vol = (geo.userData.signedVol as number) ?? 0;
      const outScore = (geo.userData.outScore as number) ?? 0;
      if (vol < -5 && outScore < -5 && geo.boundingBox) {
        const hasOutwardTwin = geos.some((other) => {
          if (other === geo || !other.boundingBox) return false;
          const oVol = (other.userData.signedVol as number) ?? 0;
          if (oVol <= 1) return false;
          return (
            other.boundingBox.min.distanceTo(geo.boundingBox!.min) < 1.0 &&
            other.boundingBox.max.distanceTo(geo.boundingBox!.max) < 1.0
          );
        });
        if (!hasOutwardTwin) {
          geo.userData.isIsolatedInwardShell = true;
        }
      }
    }

    return parsedTemplate;
  })();

  if (!overrideArchive) {
    const tracked = p.catch((err) => {
      templateCache.delete(key);
      throw err;
    });
    templateCache.set(key, tracked);
    return tracked;
  }
  return p;
}

/**
 * Instantiates a hierarchical Three.js rig from a parsed 3DMM TMPL (real BODY.CPP / TMPL.CPP hierarchy).
 * Rest orientation from TMPL header aligns local forward to +Z so rotation.y matches heading atan2(dx, dz).
 */
export function instantiateTemplateRig(
  template: ParsedTemplate,
  costumeCmids?: number[],
  costumeMtrls?: { ibset: number; mtrlCno: number }[]
): TemplateRig {
  const root = new THREE.Group();
  const bodyRoot = new THREE.Group();
  bodyRoot.rotation.set(template.xaRest, template.yaRest, template.zaRest, 'YXZ');
  root.add(bodyRoot);

  const cbactPart = Math.max(template.parentIds.length, 1);
  const parts: THREE.Group[] = [];
  const meshes: THREE.Mesh[] = [];

  const defaultMat = new THREE.MeshStandardMaterial({
    color: 0xd0d0d0,
    flatShading: false,
    roughness: 0.68,
    metalness: 0.08,
    side: THREE.FrontSide,
  });

  for (let i = 0; i < cbactPart; i++) {
    const grp = new THREE.Group();
    grp.matrixAutoUpdate = false;
    parts.push(grp);

    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), defaultMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    grp.add(mesh);
    meshes.push(mesh);
  }

  for (let i = 0; i < cbactPart; i++) {
    const pid = template.parentIds[i] ?? -1;
    if (pid < 0 || pid >= cbactPart || pid === i) {
      bodyRoot.add(parts[i]);
    } else {
      parts[pid].add(parts[i]);
    }
  }

  const rig: TemplateRig = {
    root,
    bodyRoot,
    parts,
    meshes,
    baseMaterialColors: meshes.map(() => new THREE.Color(0xd0d0d0)),
    overrideGeometries: new Array(cbactPart).fill(null),
    template,
    costumeCmids: costumeCmids ? [...costumeCmids] : [],
    baseScale: 1,
  };

  applyCostumeToRig(rig, costumeCmids || [], costumeMtrls);
  const act0 = template.actionCache.get(0);
  if (act0) applyActionCelToRig(rig, act0, 0);

  return rig;
}

export function applyCostumeToRig(
  rig: TemplateRig,
  costumeCmids: number[],
  costumeMtrls?: { ibset: number; mtrlCno: number }[]
) {
  const { template, meshes } = rig;
  const act0 = template.actionCache.get(0);
  const applyGen = ((rig.root.userData.costumeApplyGen as number) ?? 0) + 1;
  rig.root.userData.costumeApplyGen = applyGen;
  rig.overrideGeometries.fill(null);

  // Merge default costume per ibset FIRST so partial overrides never leave other body parts untextured!
  const chosenByIbset = new Map<number, ParsedCmtl>();
  for (const s of template.costumeSets) {
    const defId = s[0];
    if (defId !== undefined) {
      const defCmtl = template.cmtls.get(defId);
      if (defCmtl) chosenByIbset.set(defCmtl.ibset, defCmtl);
    }
  }
  for (const cmid of costumeCmids) {
    const cmtl = template.cmtls.get(cmid);
    if (cmtl) chosenByIbset.set(cmtl.ibset, cmtl);
  }

  chosenByIbset.forEach((cmtl) => {
    let ibmtl = 0;
    for (let iprt = 0; iprt < meshes.length; iprt++) {
      if (template.bodyPartSets[iprt] === cmtl.ibset) {
        const overrideGeo = cmtl.overrideGeometries[ibmtl] ?? null;
        rig.overrideGeometries[iprt] = overrideGeo;
        if (overrideGeo) {
          meshes[iprt].geometry = overrideGeo;
          meshes[iprt].visible = true;
        } else {
          const baseChidModl = act0?.cels[0]?.parts[iprt]?.chidModl ?? -1;
          if (baseChidModl < 0) {
            meshes[iprt].visible = false;
          } else {
            const baseGeo = template.bmdls.get(baseChidModl);
            if (baseGeo) meshes[iprt].geometry = baseGeo;
            meshes[iprt].visible = true;
          }
        }

        if (ibmtl < cmtl.materials.length) {
          const cloned = cmtl.materials[ibmtl].clone();
          if (meshes[iprt].geometry?.userData?.isIsolatedInwardShell) {
            cloned.side = THREE.DoubleSide;
          }
          delete meshes[iprt].userData.litMaterial;
          delete meshes[iprt].userData.unlitMaterial;
          meshes[iprt].material = cloned;
          const std = cloned as THREE.MeshStandardMaterial;
          rig.baseMaterialColors[iprt] = std.color ? std.color.clone() : new THREE.Color(0xffffff);
          if (rig.root.userData.enableShading === false) {
            applyObjectShadingMode(meshes[iprt], false);
          }
        }
        ibmtl++;
      }
    }
  });

  // Apply any direct MTRL overrides (aetCost with fCmtl = false, pointing to MTRLS.3CN)
  if (costumeMtrls && costumeMtrls.length > 0) {
    for (const ov of costumeMtrls) {
      void loadDirectMtrl(ov.mtrlCno).then((mat) => {
        if (!mat || rig.root.userData.costumeApplyGen !== applyGen) return;
        for (let iprt = 0; iprt < meshes.length; iprt++) {
          if (template.bodyPartSets[iprt] === ov.ibset) {
            const cloned = mat.clone();
            if (meshes[iprt].geometry?.userData?.isIsolatedInwardShell) {
              cloned.side = THREE.DoubleSide;
            }
            delete meshes[iprt].userData.litMaterial;
            delete meshes[iprt].userData.unlitMaterial;
            meshes[iprt].material = cloned;
            const std = cloned as THREE.MeshStandardMaterial;
            rig.baseMaterialColors[iprt] = std.color ? std.color.clone() : new THREE.Color(0xffffff);
            if (rig.root.userData.enableShading === false) {
              applyObjectShadingMode(meshes[iprt], false);
            }
          }
        }
      });
    }
  }
}

const _tintTmp = new THREE.Color();

export function applyRigColorOverride(rig: TemplateRig, colorHex?: string) {
  const { meshes, baseMaterialColors } = rig;
  if (colorHex) {
    _tintTmp.set(colorHex);
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      const mats = [
        mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | undefined,
        mesh.userData.litMaterial as THREE.MeshStandardMaterial | undefined,
        mesh.userData.unlitMaterial as THREE.MeshBasicMaterial | undefined,
      ];
      for (const mat of mats) {
        if (mat && mat.color) mat.color.copy(_tintTmp);
      }
    }
  } else {
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      const base = baseMaterialColors[i];
      if (!base) continue;
      const mats = [
        mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | undefined,
        mesh.userData.litMaterial as THREE.MeshStandardMaterial | undefined,
        mesh.userData.unlitMaterial as THREE.MeshBasicMaterial | undefined,
      ];
      for (const mat of mats) {
        if (mat && mat.color) mat.color.copy(base);
      }
    }
  }
}

export function applyGroupColorOverride(group: THREE.Group, colorHex?: string) {
  const targetHex = colorHex || (group.userData.baseColor as string) || '#f59e0b';
  _tintTmp.set(targetHex);
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const mats = [
      mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | undefined,
      mesh.userData.litMaterial as THREE.MeshStandardMaterial | undefined,
      mesh.userData.unlitMaterial as THREE.MeshBasicMaterial | undefined,
    ];
    for (const mat of mats) {
      if (mat && mat.color) mat.color.copy(_tintTmp);
    }
  });
}

export function applyActionCelToRig(rig: TemplateRig, action: ParsedAction, frame: number) {
  const len = action.cels.length;
  if (len === 0) return;
  const icel = Math.max(0, Math.min(len - 1, Math.floor(frame)));
  const cel = action.cels[icel];
  const { parts, meshes, template, overrideGeometries } = rig;

  for (let iprt = 0; iprt < parts.length && iprt < cel.parts.length; iprt++) {
    const spec = cel.parts[iprt];
    if (spec.imat34 >= 0 && spec.imat34 < action.matrices.length) {
      parts[iprt].matrix.copy(action.matrices[spec.imat34]);
      parts[iprt].matrixWorldNeedsUpdate = true;
    }
    const overrideGeo = overrideGeometries[iprt];
    if (overrideGeo) {
      if (meshes[iprt].geometry !== overrideGeo) meshes[iprt].geometry = overrideGeo;
      meshes[iprt].visible = true;
    } else if (spec.chidModl >= 0) {
      const geo = template.bmdls.get(spec.chidModl);
      if (geo) {
        if (meshes[iprt].geometry !== geo) meshes[iprt].geometry = geo;
        meshes[iprt].visible = true;
      }
    } else {
      meshes[iprt].visible = false;
    }
    if (meshes[iprt].geometry?.userData?.isIsolatedInwardShell) {
      const mat = meshes[iprt].material as THREE.Material | undefined;
      if (mat && mat.side !== THREE.DoubleSide) {
        mat.side = THREE.DoubleSide;
        mat.needsUpdate = true;
      }
    }
  }
}

const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _sA = new THREE.Vector3();
const _sB = new THREE.Vector3();

/**
 * 24 FPS skeletal / part cel blending between adjacent 6 FPS cels.
 * Smoothly blends position, quaternion (slerp), and scale when body parts match,
 * holding on the final cel once finished (no looping).
 */
export function applyActionCelBlendedToRig(rig: TemplateRig, action: ParsedAction, frame: number) {
  const len = action.cels.length;
  if (len === 0) return;
  if (frame >= len - 1) {
    applyActionCelToRig(rig, action, len - 1);
    return;
  }
  const clampedFrame = Math.max(0, frame);
  const baseIdx = Math.floor(clampedFrame);
  const frac = clampedFrame - baseIdx;
  if (frac < 1e-3 || len === 1) {
    applyActionCelToRig(rig, action, clampedFrame);
    return;
  }

  const icelA = Math.max(0, Math.min(len - 1, baseIdx));
  const icelB = Math.min(len - 1, icelA + 1);
  const celA = action.cels[icelA];
  const celB = action.cels[icelB];
  const { parts, meshes, template, overrideGeometries } = rig;

  for (let iprt = 0; iprt < parts.length && iprt < celA.parts.length; iprt++) {
    const specA = celA.parts[iprt];
    const specB = iprt < celB.parts.length ? celB.parts[iprt] : null;
    const overrideGeo = overrideGeometries[iprt];
    if (overrideGeo) {
      if (meshes[iprt].geometry !== overrideGeo) meshes[iprt].geometry = overrideGeo;
      meshes[iprt].visible = true;
    } else if (specA.chidModl >= 0) {
      const geo = template.bmdls.get(specA.chidModl);
      if (geo) {
        if (meshes[iprt].geometry !== geo) meshes[iprt].geometry = geo;
        meshes[iprt].visible = true;
      }
    } else {
      meshes[iprt].visible = false;
    }
    if (meshes[iprt].geometry?.userData?.isIsolatedInwardShell) {
      const mat = meshes[iprt].material as THREE.Material | undefined;
      if (mat && mat.side !== THREE.DoubleSide) {
        mat.side = THREE.DoubleSide;
        mat.needsUpdate = true;
      }
    }

    if (
      specB &&
      specA.chidModl === specB.chidModl &&
      specA.imat34 >= 0 &&
      specA.imat34 < action.matrices.length &&
      specB.imat34 >= 0 &&
      specB.imat34 < action.matrices.length
    ) {
      action.matrices[specA.imat34].decompose(_pA, _qA, _sA);
      action.matrices[specB.imat34].decompose(_pB, _qB, _sB);
      _qA.normalize();
      _qB.normalize();
      if (
        Number.isFinite(_qA.x) &&
        Number.isFinite(_qB.x) &&
        Number.isFinite(_sA.x) &&
        Number.isFinite(_sB.x)
      ) {
        _pA.lerp(_pB, frac);
        _qA.slerp(_qB, frac).normalize();
        _sA.lerp(_sB, frac);
        parts[iprt].matrix.compose(_pA, _qA, _sA);
        parts[iprt].matrixWorldNeedsUpdate = true;
      } else {
        parts[iprt].matrix.copy(action.matrices[specA.imat34]);
        parts[iprt].matrixWorldNeedsUpdate = true;
      }
    } else if (specA.imat34 >= 0 && specA.imat34 < action.matrices.length) {
      parts[iprt].matrix.copy(action.matrices[specA.imat34]);
      parts[iprt].matrixWorldNeedsUpdate = true;
    }
  }
}

/**
 * Applies strictly requested prop actions (at rest, grow, grow fast, shrink, shrink fast, spin, spin fast)
 * on top of real 3DMM prop BMDL geometry.
 */
export function applyPropActionTransform(
  meshRoot: THREE.Group,
  action: PropAction,
  frame: number,
  totalFrames: number,
  baseScale = 1,
  baseRotY = 0,
  baseRotX = 0,
  baseRotZ = 0
) {
  const safeTotal = Math.max(totalFrames, 1);
  const t = Math.min(Math.max(frame / safeTotal, 0), 1);

  let scaleFactor = 1.0;
  let rotOffset = 0;

  switch (action) {
    case 'at rest':
      scaleFactor = 1.0;
      rotOffset = 0;
      break;
    case 'grow':
      scaleFactor = 0.75 + t * 0.9;
      break;
    case 'grow fast':
      scaleFactor = 0.5 + Math.min(t * 2.2, 1.0) * 1.45;
      break;
    case 'shrink':
      scaleFactor = Math.max(0.28, 1.25 - t * 0.85);
      break;
    case 'shrink fast':
      scaleFactor = Math.max(0.18, 1.4 - Math.min(t * 2.3, 1.0) * 1.15);
      break;
    case 'spin':
      rotOffset = frame * 0.22;
      break;
    case 'spin fast':
      rotOffset = frame * 0.62;
      break;
  }

  meshRoot.scale.setScalar(baseScale * scaleFactor);
  meshRoot.rotation.set(baseRotX, baseRotY + rotOffset, baseRotZ, 'YXZ');
}

export const TDT_ACTIONS: TdtAction[] = [
  'At Rest',
  'Flip Letters',
  'Spin Letters',
  'Cartwheel Letters',
  'Side to Side',
  'Rock',
  'Back and Forth',
  'Grow and Shrink',
  'Flip',
  'Spin',
  'Cartwheel',
  'The Wave',
  'Hide and Appear',
  'Walk Forward*',
  'Hop',
  'Stretch',
];

export const TDT_ACTION_TO_ANID: Record<TdtAction, number> = {
  'At Rest': 0,
  'Flip Letters': 1,
  'Spin Letters': 2,
  'Cartwheel Letters': 3,
  'Side to Side': 4,
  'Rock': 5,
  'Back and Forth': 6,
  'Grow and Shrink': 7,
  'Flip': 8,
  'Spin': 9,
  'Cartwheel': 10,
  'The Wave': 11,
  'Hide and Appear': 12,
  'Walk Forward*': 13,
  'Hop': 14,
  'Stretch': 15,
};

export function anidToTdtAction(anid: number): TdtAction {
  return TDT_ACTIONS[anid] ?? 'At Rest';
}

export function tdtActionToAnid(action?: string): number {
  const norm = normalizeTdtActionName(action);
  return TDT_ACTION_TO_ANID[norm] ?? 0;
}

export function normalizeTdtActionName(raw?: string): TdtAction {
  const clean = (raw || '').trim().toLowerCase();
  if (!clean || clean === 'at rest' || clean === 'rest') return 'At Rest';
  const exact = TDT_ACTIONS.find((a) => a.toLowerCase() === clean);
  if (exact) return exact;
  if (clean === 'walk forward' || clean === 'walk') return 'Walk Forward*';
  if (clean === 'wave') return 'The Wave';
  if (clean === 'pulse' || clean === 'grow' || clean === 'shrink') return 'Grow and Shrink';
  if (clean === 'bounce' || clean === 'jump') return 'Hop';
  if (clean === 'wobble') return 'Rock';
  if (clean === 'spin fast') return 'Spin Letters';
  if (clean === 'grow fast') return 'Grow and Shrink';
  if (clean === 'shrink fast') return 'Hide and Appear';
  if (clean === 'float') return 'The Wave';
  return 'At Rest';
}

const _tdtShearMat = new THREE.Matrix4();
const _tdtShapeMat = new THREE.Matrix4();
const _tdtPosTmp = new THREE.Vector3();
const _tdtQuatTmp = new THREE.Quaternion();
const _tdtEulerTmp = new THREE.Euler(0, 0, 0, 'YXZ');
const _tdtScaleTmp = new THREE.Vector3();

/**
 * Applies authentic Microsoft 3D Movie Maker TDT animations (TDT.CPP cels & transforms 0..15)
 * non-destructively on top of base keyframe transforms, resetting every glyph cleanly per frame.
 */
export function applyTdtActionTransform(
  group: THREE.Group,
  action: string,
  frame: number,
  _totalFrames: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  baseRotX: number,
  baseRotY: number,
  baseRotZ: number,
  worldPos?: THREE.Vector3
) {
  const act = normalizeTdtActionName(action);
  const anid = TDT_ACTION_TO_ANID[act] ?? 0;
  // Exact cel counts from TDT::_CcelOfTda in Microsoft 3DMM TDT.CPP
  const ccel =
    anid === 0
      ? 1
      : anid >= 8 && anid <= 13
        ? 24
        : 12;

  const icel = ((frame % ccel) + ccel) % ccel;
  const rFractCel = ccel > 1 ? icel / ccel : 0;
  const rSwing = Math.sin(Math.PI * 2 * rFractCel);

  let wordRotXOff = 0;
  let wordRotYOff = 0;
  let wordRotZOff = 0;

  if (act === 'Flip') {
    wordRotXOff = rFractCel * Math.PI * 2;
  } else if (act === 'Spin') {
    wordRotYOff = -rFractCel * Math.PI * 2;
  } else if (act === 'Cartwheel') {
    wordRotZOff = rFractCel * Math.PI * 2;
  }

  for (let i = 0; i < group.children.length; i++) {
    const mesh = group.children[i] as THREE.Mesh;
    const restPos = mesh.userData?.restPos as THREE.Vector3 | undefined;
    if (!restPos) continue;

    const restRotY = (mesh.userData.restRotY as number) ?? 0;
    const restRotZ = (mesh.userData.restRotZ as number) ?? 0;
    const restScaleY = (mesh.userData.restScaleY as number) ?? 1;
    const ich = (mesh.userData.charIdx as number) ?? i;
    const xrFract = (mesh.userData.xrFract as number) ?? 0.5;

    let lRotX = 0;
    let lRotY = 0;
    let lRotZ = 0;
    let lSx = 1;
    let lSy = 1;
    let lSz = 1;
    let lDx = 0;
    let lDy = 0;
    let lDz = 0;
    let shearYx = 0;
    let shearZx = 0;
    let shearYz = 0;

    switch (act) {
      case 'At Rest':
        break;
      case 'Flip Letters':
        lRotX = rFractCel * Math.PI * 2;
        break;
      case 'Spin Letters':
        lRotY = rFractCel * Math.PI * 2;
        break;
      case 'Cartwheel Letters':
        lRotZ = rFractCel * Math.PI * 2;
        break;
      case 'Side to Side':
        shearYx = 0.25 * rSwing;
        break;
      case 'Rock':
        shearZx = 0.5 * rSwing;
        break;
      case 'Back and Forth':
        shearYz = 0.5 * rSwing;
        break;
      case 'Grow and Shrink': {
        const sc = 1 + 0.25 * rSwing;
        lSx = sc;
        lSy = sc;
        lSz = sc;
        break;
      }
      case 'The Wave': {
        let rTheta = (xrFract - rFractCel) * (3 * Math.PI);
        if (rTheta < -2 * Math.PI) rTheta += 3 * Math.PI;
        rTheta = Math.max(0, Math.min(Math.PI, rTheta));
        lSy = 1 + Math.sin(rTheta);
        break;
      }
      case 'Hide and Appear': {
        let rTheta: number;
        if (icel < ccel / 2) {
          const dxr = (icel / (ccel / 2)) * (4 / 3);
          rTheta = (xrFract - dxr) * (3 * Math.PI) + 1.5 * Math.PI;
          rTheta = Math.max(0.5 * Math.PI, Math.min(1.5 * Math.PI, rTheta));
        } else {
          const dxr = ((icel - ccel / 2) / (ccel / 2)) * (4 / 3);
          rTheta = (xrFract - dxr) * (3 * Math.PI) + Math.PI;
          rTheta = Math.max(-0.5 * Math.PI, Math.min(0.5 * Math.PI, rTheta));
        }
        lSy = 0.1 + 0.5 + 0.5 * Math.sin(rTheta);
        break;
      }
      case 'Walk Forward*': {
        const fOdd = ich % 2 !== 0;
        const stepWalk = 0.22;
        let rTheta = rFractCel * Math.PI * 2;
        if (fOdd) {
          lDz = (icel < ccel / 2 ? ccel / 2 - icel : icel - ccel / 2) * stepWalk;
          rTheta -= Math.PI;
        } else {
          lDz = (icel < ccel / 2 ? icel : ccel - icel) * stepWalk;
        }
        rTheta = Math.max(0, Math.min(Math.PI, rTheta));
        lDy = Math.sin(rTheta) * 1.4;
        break;
      }
      case 'Hop': {
        const phaseSplit = (ccel * 2) / 3;
        if (icel < phaseSplit) {
          const rTheta = (icel / phaseSplit) * Math.PI;
          lDy = Math.sin(rTheta) * 1.65;
        } else {
          const rTheta = ((icel - phaseSplit) / (ccel / 3)) * Math.PI + Math.PI;
          lSy = 1 + Math.sin(rTheta) * 0.5;
        }
        break;
      }
      case 'Stretch': {
        const rTheta = rFractCel * Math.PI * 2 + 1.5 * Math.PI;
        lSx = 1.5 + 0.5 * Math.sin(rTheta);
        break;
      }
      default:
        break;
    }

    const hasShear = Math.abs(shearYx) > 1e-4 || Math.abs(shearZx) > 1e-4 || Math.abs(shearYz) > 1e-4;
    if (hasShear) {
      mesh.matrixAutoUpdate = false;
      _tdtEulerTmp.set(0, restRotY, restRotZ, 'YXZ');
      _tdtQuatTmp.setFromEuler(_tdtEulerTmp);
      _tdtScaleTmp.set(1, restScaleY, 1);
      _tdtShapeMat.compose(restPos, _tdtQuatTmp, _tdtScaleTmp);
      // Local shear matrix matching BrMatrix34PreShearY / PreShearZ
      _tdtShearMat.set(
        1, shearYx, shearYz, 0,
        0, 1, 0, 0,
        shearZx, 0, 1, 0,
        0, 0, 0, 1
      );
      mesh.matrix.copy(_tdtShapeMat).multiply(_tdtShearMat);
      mesh.matrixWorldNeedsUpdate = true;
    } else {
      mesh.matrixAutoUpdate = true;
      _tdtPosTmp.set(restPos.x + lDx, restPos.y + lDy, restPos.z + lDz);
      mesh.position.copy(_tdtPosTmp);
      mesh.rotation.set(lRotX, restRotY + lRotY, restRotZ + lRotZ, 'YXZ');
      mesh.scale.set(lSx, restScaleY * lSy, lSz);
    }
  }

  if (worldPos) {
    group.position.copy(worldPos);
  }
  group.scale.set(scaleX, scaleY, scaleZ);
  group.rotation.set(baseRotX + wordRotXOff, baseRotY + wordRotYOff, baseRotZ + wordRotZOff, 'YXZ');
}

/**
 * Toggles between:
 * - No Shading Mode (`enableShading === false`, default):
 *   - Textured objects (`map !== null`): unlit `MeshBasicMaterial` (no lighting/shading attenuation)
 *   - Untextured objects (`map === null`): lit `MeshStandardMaterial` with `flatShading: true`
 *   - Shadows OFF
 * - Smooth Shading + Shadows (`enableShading === true`):
 *   - All objects use lit `MeshStandardMaterial` with `flatShading: false` and shadows ON.
 */
export function applyObjectShadingMode(root: THREE.Object3D, enableShading: boolean) {
  root.userData.enableShading = enableShading;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    const curMat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | undefined;
    if (!curMat) return;

    let litMat = mesh.userData.litMaterial as THREE.MeshStandardMaterial | undefined;
    if (!litMat && (curMat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      litMat = curMat as THREE.MeshStandardMaterial;
      mesh.userData.litMaterial = litMat;
    }
    if (!litMat) return;

    if (curMat.color && litMat.color && curMat !== litMat) {
      litMat.color.copy(curMat.color);
    }

    const isTextured = Boolean(litMat.map);
    if (enableShading) {
      if (litMat.flatShading) {
        litMat.flatShading = false;
        litMat.needsUpdate = true;
      }
      if (mesh.material !== litMat) {
        mesh.material = litMat;
      }
    } else if (isTextured) {
      let unlitMat = mesh.userData.unlitMaterial as THREE.MeshBasicMaterial | undefined;
      if (!unlitMat) {
        unlitMat = new THREE.MeshBasicMaterial({
          map: litMat.map,
          color: litMat.color.clone(),
          side: litMat.side,
          transparent: litMat.transparent,
          opacity: litMat.opacity,
          alphaTest: litMat.alphaTest,
        });
        mesh.userData.unlitMaterial = unlitMat;
      } else {
        if (unlitMat.map !== litMat.map) {
          unlitMat.map = litMat.map;
          unlitMat.needsUpdate = true;
        }
        unlitMat.color.copy(litMat.color);
        unlitMat.side = litMat.side;
      }
      if (mesh.material !== unlitMat) {
        mesh.material = unlitMat;
      }
    } else {
      if (!litMat.flatShading) {
        litMat.flatShading = true;
        litMat.needsUpdate = true;
      }
      if (mesh.material !== litMat) {
        mesh.material = litMat;
      }
    }

    mesh.castShadow = enableShading;
    mesh.receiveShadow = enableShading;
  });
}

const _tmpScale = new THREE.Vector3();

/**
 * Loads a real 3DMM BKGD + CAM view from BKGDS.3CN (including GLCR palette, 544x306 MBMP backdrop,
 * 544x306 16-bit ZBMP depth buffer, bmat34Cam matrix, FOV, all rgapos placement points, and GLLT lights).
 */
export function loadBackgroundView(bkgdCno: number, icam: number): Promise<LoadedBackgroundView> {
  const key = `${bkgdCno}:${icam}`;
  const cached = bgViewCache.get(key);
  if (cached) return cached;

  const p = (async () => {
    const [basePal, bkgdsCn] = await Promise.all([
      loadBasePalette(),
      getArchive(assetUrl('3dmm/3dmovie/BKGDS.3CN'), false),
    ]);

    const bkgdMeta = bkgdsCn.getChunkMeta('BKGD', bkgdCno);
    if (!bkgdMeta) throw new Error(`BKGD:${bkgdCno} not found in BKGDS.3CN`);

    const bkgdData = await bkgdsCn.readChunk('BKGD', bkgdCno);
    const bIndexBase = bkgdData[4] ?? 10;

    let palette = basePal;
    const glcrMeta = bkgdsCn.findKid(bkgdMeta, 'GLCR', 0) || bkgdsCn.findKid(bkgdMeta, 'GLCR');
    if (glcrMeta) {
      const glcrBytes = await bkgdsCn.readChunk('GLCR', glcrMeta.cno);
      palette = applyGlcrPalette(basePal, glcrBytes, bIndexBase);
    }

    const camKids = bkgdsCn.findKids(bkgdMeta, 'CAM ').sort((a, b) => a.kid.chid - b.kid.chid);
    const targetCamMeta =
      camKids.find((k) => k.kid.chid === icam)?.meta || camKids[0]?.meta;
    if (!targetCamMeta) throw new Error(`No CAM chunks in BKGD:${bkgdCno}`);

    const camBytes = await bkgdsCn.readChunk('CAM ', targetCamMeta.cno);
    const camDv = new DataView(camBytes.buffer, camBytes.byteOffset, camBytes.byteLength);

    const hither = readFixed16(camDv, 4);
    const yon = readFixed16(camDv, 8);
    const aFov = camDv.getUint16(12, true);
    const fovDeg = (aFov * 360) / 65536;
    const apos = new THREE.Vector3(
      readFixed16(camDv, 16),
      readFixed16(camDv, 20),
      readFixed16(camDv, 24)
    );
    const camMatrix = readBmat34ToMatrix4(camDv, 28);
    const camPosition = new THREE.Vector3();
    const camQuaternion = new THREE.Quaternion();
    camMatrix.decompose(camPosition, camQuaternion, _tmpScale);

    const camForwardXZ = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuaternion);
    camForwardXZ.y = 0;
    if (camForwardXZ.lengthSq() < 1e-6) camForwardXZ.set(0, 0, -1);
    else camForwardXZ.normalize();

    const camRightXZ = new THREE.Vector3(1, 0, 0).applyQuaternion(camQuaternion);
    camRightXZ.y = 0;
    if (camRightXZ.lengthSq() < 1e-6) camRightXZ.set(1, 0, 0);
    else camRightXZ.normalize();

    // Extract all authored APOS actor/prop placement points (rgapos[] starting at byte 76 in CAM chunk)
    const aposes: THREE.Vector3[] = [apos.clone()];
    for (let off = 76; off + 12 <= camBytes.length; off += 12) {
      const px = readFixed16(camDv, off);
      const py = readFixed16(camDv, off + 4);
      const pz = readFixed16(camDv, off + 8);
      if (
        Number.isFinite(px) &&
        Number.isFinite(py) &&
        Number.isFinite(pz) &&
        Math.abs(px) < 10000 &&
        Math.abs(py) < 10000 &&
        Math.abs(pz) < 10000
      ) {
        const cand = new THREE.Vector3(px, py, pz);
        if (!aposes.some((a) => a.distanceToSquared(cand) < 0.01)) {
          aposes.push(cand);
        }
      }
    }

    let backdropDataUrl: string | null = null;
    const mbmpMeta = bkgdsCn.findKid(targetCamMeta, 'MBMP');
    if (mbmpMeta) {
      const mbmpBytes = await bkgdsCn.readChunk('MBMP', mbmpMeta.cno);
      backdropDataUrl = mbmpToDataUrl(mbmpBytes, palette);
    }

    let zbmpDepthTexture: THREE.DataTexture | null = null;
    let zbData: { w: number; h: number; dv: DataView; pixStart: number } | null = null;
    const zbmpMeta = bkgdsCn.findKid(targetCamMeta, 'ZBMP');
    if (zbmpMeta) {
      const zbmpBytes = await bkgdsCn.readChunk('ZBMP', zbmpMeta.cno);
      const decoded = decodeZbmpToDepthTexture(zbmpBytes);
      if (decoded) {
        zbmpDepthTexture = decoded.texture;
        const zdv = new DataView(zbmpBytes.buffer, zbmpBytes.byteOffset, zbmpBytes.byteLength);
        const pixStart = zbmpBytes.length - decoded.width * decoded.height * 2;
        if (pixStart >= 8) {
          zbData = { w: decoded.width, h: decoded.height, dv: zdv, pixStart };
        }
      }
    }

    // Parse GLLT lights if present
    const lights: LoadedBackgroundView['lights'] = [];
    const glltMeta = bkgdsCn.findKid(bkgdMeta, 'GLLT');
    if (glltMeta) {
      const glltBytes = await bkgdsCn.readChunk('GLLT', glltMeta.cno);
      const gl = parseGL(glltBytes);
      for (let i = 0; i < gl.count; i++) {
        const o = gl.entryOffset(i);
        const lMat = readBmat34ToMatrix4(gl.dv, o);
        const intensity = gl.dv.byteLength >= o + 52 ? readFixed16(gl.dv, o + 48) : 1.0;
        const type = gl.dv.byteLength >= o + 56 ? gl.dv.getInt32(o + 52, true) : 1;
        lights.push({ type, color: 0xffffff, intensity: Math.max(0.3, intensity), matrix: lMat });
      }
    }

    // Compute guaranteed visible, unoccluded stageOrigin for 'stage' mode across all 188 CAMs
    const safeFov = fovDeg > 1 ? fovDeg : 47;
    const safeHither = hither > 0.01 ? hither : 1;
    const safeYon = yon > 10 ? yon : 5000;
    const testCam = new THREE.PerspectiveCamera(safeFov, 544 / 306, safeHither, safeYon);
    testCam.position.copy(camPosition);
    testCam.quaternion.copy(camQuaternion);
    testCam.updateMatrixWorld();
    testCam.matrixWorldInverse.copy(testCam.matrixWorld).invert();

    const isVisibleStagePoint = (pt: THREE.Vector3) => {
      const dist = pt.distanceTo(camPosition);
      if (dist < Math.max(6, safeHither + 2) || dist > safeYon * 0.85) return false;
      const p = pt.clone().project(testCam);
      if (p.z <= 0 || p.z >= 1 || Math.abs(p.x) > 0.72 || p.y < -0.92 || p.y > 0.48) return false;
      if (!zbData) return true;

      // Ensure chest (+5.0) and shins (+1.8) are NOT occluded by foreground ZBMP obstacles
      for (const hOff of [5.0, 1.8]) {
        const tp = new THREE.Vector3(pt.x, pt.y + hOff, pt.z).project(testCam);
        if (tp.z <= 0 || tp.z >= 1 || Math.abs(tp.x) > 0.95 || Math.abs(tp.y) > 0.95) return false;
        const px = Math.min(zbData.w - 1, Math.max(0, Math.round((tp.x * 0.5 + 0.5) * (zbData.w - 1))));
        const py = Math.min(zbData.h - 1, Math.max(0, Math.round((1 - (tp.y * 0.5 + 0.5)) * (zbData.h - 1))));
        const z16 = zbData.dv.getUint16(zbData.pixStart + (py * zbData.w + px) * 2, true);
        const zbNdc = z16 >= 32767 ? 1.0 : z16 / 32768.0;
        if (tp.z > zbNdc + 0.0005) return false;
      }
      return true;
    };

    let stageOrigin = aposes.find(isVisibleStagePoint)?.clone();
    if (!stageOrigin && zbData) {
      // Search centered & lower-screen floor intersections for an unoccluded placement spot
      const vpInv = new THREE.Matrix4()
        .multiplyMatrices(testCam.projectionMatrix, testCam.matrixWorldInverse)
        .invert();
      const targetFloorY = apos.y;
      let bestScore = Infinity;
      const nyList = [-0.45, -0.3, -0.6, -0.15, -0.75, 0.0];
      const nxList = [0, -0.22, 0.22, -0.45, 0.45, -0.65, 0.65];
      for (const ny of nyList) {
        for (const nx of nxList) {
          const rayPt = new THREE.Vector3(nx, ny, 0.5).applyMatrix4(vpInv);
          const dir = rayPt.sub(camPosition).normalize();
          if (Math.abs(dir.y) > 0.02) {
            const t = (targetFloorY - camPosition.y) / dir.y;
            if (t >= Math.max(6, safeHither + 3) && t <= 160) {
              const cand = camPosition.clone().addScaledVector(dir, t);
              if (isVisibleStagePoint(cand)) {
                const score = Math.abs(nx) * 2.0 + Math.abs(t - 26) * 0.04 + Math.abs(ny + 0.45);
                if (score < bestScore) {
                  bestScore = score;
                  stageOrigin = cand;
                }
              }
            }
          }
        }
      }
    }
    if (!stageOrigin) {
      // Fallback: project camera forward ~26 units at floor level y = apos.y
      const camFwd3 = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuaternion);
      const tFloor =
        Math.abs(camFwd3.y) > 0.05 && (apos.y - camPosition.y) / camFwd3.y > 6
          ? Math.min(48, (apos.y - camPosition.y) / camFwd3.y)
          : 26;
      stageOrigin = new THREE.Vector3(
        camPosition.x + camFwd3.x * tFloor,
        apos.y,
        camPosition.z + camFwd3.z * tFloor
      );
    }

    return {
      bkgdCno,
      bkgdName: (bkgdMeta.name || `Background ${bkgdCno}`).replace(/\s+Background$/i, ''),
      icam,
      fovDeg: safeFov,
      hither: safeHither,
      yon: safeYon,
      apos,
      stageOrigin,
      aposes,
      camMatrix,
      camPosition,
      camQuaternion,
      camForwardXZ,
      camRightXZ,
      backdropDataUrl,
      zbmpDepthTexture,
      lights,
    };
  })();

  const tracked = p.catch((err) => {
    bgViewCache.delete(key);
    throw err;
  });
  bgViewCache.set(key, tracked);
  return tracked;
}

let preloadPromise: Promise<void> | null = null;

/**
 * Preloads shared 3DMM archives, all scene camera views (MBMP/ZBMP/CAM), and actor/prop templates.
 * Upgrades .3CN archives to single full-buffer downloads before preloading all views/templates so static
 * CDNs like GitHub Pages never hit Range rate limits or HTTP/2 partial-response drops.
 */
export function preloadThreeDmmAssets(catalog: ThreeDmmCatalog): Promise<void> {
  if (preloadPromise) return preloadPromise;

  preloadPromise = (async () => {
    // 1. Warm the opening scene's first view right away
    const firstScene = catalog.scenes[0];
    if (firstScene?.views[0]) {
      await loadBackgroundView(firstScene.bkgdCno, firstScene.views[0].icam).catch(() => {});
    }

    // 2. Download each shared .3CN archive once cleanly instead of spamming thousands of Range requests
    await Promise.allSettled([
      getArchive(assetUrl('3dmm/3dmovie/BKGDS.3CN'), false).then((a) => a.ensureFullBuffer()),
      getArchive(assetUrl('3dmm/3dmovie/TMPLS.3CN'), false).then((a) => a.ensureFullBuffer()),
      getArchive(assetUrl('3dmm/3dmovie/MTRLS.3CN'), false).then((a) => a.ensureFullBuffer()),
      getArchive(assetUrl('3dmm/3dmovie/TDFS.3CN'), false).then((a) => a.ensureFullBuffer()),
      getArchive(assetUrl('3dmm/3dmovie/SNDS.3CN'), false).then((a) => a.ensureFullBuffer()),
      getArchive(assetUrl('3dmm/3dmovie/SOUND.3TH'), true),
    ]);

    // 3. Hydrate all camera views and actor/prop templates directly from RAM buffers
    const tasks: (() => Promise<unknown>)[] = [];
    for (const sc of catalog.scenes) {
      for (const v of sc.views) {
        tasks.push(() => loadBackgroundView(sc.bkgdCno, v.icam));
      }
    }
    for (const actor of catalog.actors) {
      tasks.push(() => loadTemplate(actor.tmplCno));
    }
    for (const prop of catalog.props) {
      tasks.push(() => loadTemplate(prop.tmplCno));
    }

    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const job = tasks[cursor++];
        try {
          await job();
        } catch {
          // Ignore individual asset preload failures
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  })().catch((err) => {
    preloadPromise = null;
    throw err;
  });

  return preloadPromise;
}


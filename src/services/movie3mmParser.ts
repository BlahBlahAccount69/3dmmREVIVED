import {
  ActionKeyframe,
  ActorEntity,
  CameraCutEvent,
  CostumeMtrlOverride,
  ImportedAudioCue,
  KeyframePosition,
  Movie,
  PropActionKeyframe,
  PropEntity,
  Scene,
  SceneTransition,
  ScreenTextBox,
  ScreenTextRun,
  TdtTextEntity,
} from '../types/movie';
import { ChunkyFile } from './chunkyParser';
import { parseGG, parseGL, readBmat34ToMatrix4, readFixed16, readTagReversed } from './kauaiCodec';
import {
  anidToTdtAction,
  CatalogSceneItem,
  isCyclic3dmmAction,
  loadAction,
  loadTemplate,
  loadThreeDmmCatalog,
  normalizeTdtActionName,
  ParsedAction,
  resolveMtrlHex,
} from './threeDmmEngine';
import { sound3DMM } from './soundLibrary';
import { loadBasePalette } from './mbmpDecoder';
import * as THREE from 'three';

export const OFFICIAL_SAMPLE_MOVIES = [
  { file: 'BONGO.3MM', label: 'Bongo' },
  { file: 'BOOOOOO.3MM', label: 'Boooooo' },
  { file: 'BRIDGE.3MM', label: 'Bridge' },
  { file: 'CITYTOUR.3MM', label: 'City Tour' },
  { file: 'DIALOGUE.3MM', label: 'Dialogue' },
  { file: 'GRAVEYRD.3MM', label: 'Graveyard' },
  { file: 'HAUNTED.3MM', label: 'Haunted' },
  { file: 'HOSPITAL.3MM', label: 'Hospital' },
  { file: 'JOG.3MM', label: 'Jog' },
  { file: 'JUNGLE.3MM', label: 'Jungle' },
  { file: 'MESSAGE.3MM', label: 'Message' },
  { file: 'MUMMY.3MM', label: 'Mummy' },
  { file: 'SPACE.3MM', label: 'Space' },
  { file: 'SPROG.3MM', label: 'Sprog' },
  { file: 'SURPRISE.3MM', label: 'Surprise' },
  { file: 'TERROR.3MM', label: 'Terror' },
  { file: 'THEBOOK.3MM', label: 'The Book' },
  { file: 'THELODGE.3MM', label: 'The Lodge' },
  { file: 'THETHIEF.3MM', label: 'The Thief' },
  { file: 'VENUS31.3MM', label: 'Venus 31' },
  { file: 'WHERE.3MM', label: 'Where' },
];

function findMatchingBackground(sceneName: string, catalogScenes: CatalogSceneItem[]): CatalogSceneItem {
  const clean = sceneName.replace(/\s+Background$/i, '').trim().toLowerCase();
  const exact = catalogScenes.find((s) => s.name.toLowerCase() === clean);
  if (exact) return exact;
  const prefix = catalogScenes.find(
    (s) => clean.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(clean)
  );
  return prefix || catalogScenes[0];
}

interface PathNode {
  x: number;
  y: number;
  z: number;
  dwr: number;
}

function evalPathPos(nodes: PathNode[], irpt: number, dwrOffset: number): { x: number; y: number; z: number } {
  if (nodes.length === 0) return { x: 0, y: 0, z: 0 };
  const idx = Math.max(0, Math.min(nodes.length - 1, irpt));
  if (dwrOffset <= 0 || idx + 1 >= nodes.length || nodes[idx].dwr <= 0) {
    return { x: nodes[idx].x, y: nodes[idx].y, z: nodes[idx].z };
  }
  const frac = Math.min(1, dwrOffset / nodes[idx].dwr);
  const a = nodes[idx];
  const b = nodes[idx + 1];
  return {
    x: a.x + (b.x - a.x) * frac,
    y: a.y + (b.y - a.y) * frac,
    z: a.z + (b.z - a.z) * frac,
  };
}

function evalPathTangentYaw(nodes: PathNode[], irpt: number): number | null {
  if (nodes.length < 2) return null;
  const idx = Math.max(0, Math.min(nodes.length - 2, irpt));
  const dx = nodes[idx + 1].x - nodes[idx].x;
  const dz = nodes[idx + 1].z - nodes[idx].z;
  if (Math.hypot(dx, dz) < 1e-4) return null;
  return Math.atan2(dx, dz);
}

const _tmpMat = new THREE.Matrix4();
const _bmatPos = new THREE.Vector3();
const _bmatQuat = new THREE.Quaternion();
const _bmatScale = new THREE.Vector3();
const _bmatEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function rotScaleFromBmat34(dv: DataView, byteOffset: number) {
  readBmat34ToMatrix4(dv, byteOffset, _tmpMat).decompose(_bmatPos, _bmatQuat, _bmatScale);
  _bmatEuler.setFromQuaternion(_bmatQuat, 'YXZ');
  return {
    rotX: _bmatEuler.x,
    rotY: _bmatEuler.y,
    rotZ: _bmatEuler.z,
    scaleX: _bmatScale.x,
    scaleY: _bmatScale.y,
    scaleZ: _bmatScale.z,
  };
}

/**
 * Parses any authentic Microsoft 3D Movie Maker .3MM file (from /3dmm/samples/*.3MM or user upload)
 * into our playable & editable studio Movie format, including PATH trajectories, GGFR camera cuts,
 * multi-frame action switches, aetSnd, and MIDS/WAVE sounds.
 */
export async function loadOfficial3mmMovie(
  source: string | ArrayBuffer,
  fallbackTitle = '3DMM Movie'
): Promise<Movie> {
  const [catalog, basePalette, chunky] = await Promise.all([
    loadThreeDmmCatalog(),
    loadBasePalette(),
    typeof source === 'string'
      ? ChunkyFile.fromUrl(source, true)
      : Promise.resolve(ChunkyFile.fromBuffer(source)),
  ]);

  const socpalHex = (idx: number): string => {
    const c = Math.max(0, Math.min(255, idx | 0));
    const r = basePalette[c * 3 + 0] ?? 249;
    const g = basePalette[c * 3 + 1] ?? 249;
    const b = basePalette[c * 3 + 2] ?? 249;
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  };

  const mvieMeta = chunky.getChunksByType('MVIE')[0];
  const scenKids = mvieMeta
    ? chunky
        .findKids(mvieMeta, 'SCEN')
        .sort((a, b) => a.kid.chid - b.kid.chid)
        .map((k) => k.meta)
    : chunky.getChunksByType('SCEN');

  const scenes: Scene[] = [];

  for (let sIdx = 0; sIdx < scenKids.length; sIdx++) {
    const scenMeta = scenKids[sIdx];
    const scenBytes = await chunky.readChunk('SCEN', scenMeta.cno);
    const sDv = new DataView(scenBytes.buffer, scenBytes.byteOffset, scenBytes.byteLength);
    const nfrmLast = sDv.getInt32(4, true);
    const nfrmFirst = sDv.getInt32(8, true);
    const rawTransition = scenBytes.length >= 16 ? sDv.getInt32(12, true) : 3;
    const transition: SceneTransition =
      rawTransition === 0
        ? 'cut'
        : rawTransition === 1
          ? 'fadeToBlack'
          : rawTransition === 2
            ? 'fadeToWhite'
            : 'dissolve';
    const totalFrames = Math.max(1, Math.min(1800, nfrmLast - nfrmFirst + 1));

    const matchedBg = findMatchingBackground(scenMeta.name || '', catalog.scenes);
    let icam = 0;
    const cameraCuts: CameraCutEvent[] = [];
    const audios: ImportedAudioCue[] = [];

    // Check Background Default Sound (BDS) chunk if attached to SCEN
    const bdsKid = chunky.findKid(scenMeta, 'BDS ');
    if (bdsKid) {
      const bdsBytes = await chunky.readChunk('BDS ', bdsKid.cno);
      if (bdsBytes.length >= 28) {
        const bdsDv = new DataView(bdsBytes.buffer, bdsBytes.byteOffset, bdsBytes.byteLength);
        const fLoop = bdsDv.getInt32(8, true) !== 0;
        const ctg = readTagReversed(bdsBytes, 20);
        const msndCno = bdsDv.getUint32(24, true);
        if (ctg === 'MSND' && msndCno > 0) {
          audios.push({
            id: `bds_${sIdx}`,
            frame: 0,
            filename: `Scene Music #${msndCno}`,
            audioData: '',
            loop: fLoop,
            msndCno,
          });
        }
      }
    }

    // Parse GGFR (Scene events: camera cuts, sound & MIDI music cues)
    const ggfrMeta = chunky.findKid(scenMeta, 'GGFR');
    if (ggfrMeta) {
      const ggfrBytes = await chunky.readChunk('GGFR', ggfrMeta.cno);
      const gg = parseGG(ggfrBytes);
      let firstCamSet = false;

      for (let i = 0; i < gg.count; i++) {
        const entry = gg.getEntry(i);
        const nfrm = gg.dv.getInt32(entry.fixedOffset + 0, true);
        const sevt = gg.dv.getInt32(entry.fixedOffset + 4, true);
        const relFrame = Math.max(0, Math.min(totalFrames, nfrm - nfrmFirst));

        if (sevt === 3 && entry.varLength >= 4) {
          const cutCam = Math.max(
            0,
            Math.min(Math.max(0, matchedBg.views.length - 1), gg.dv.getInt32(entry.varOffset, true))
          );
          if (!firstCamSet && relFrame === 0) {
            icam = cutCam;
            firstCamSet = true;
          }
          cameraCuts.push({ frame: relFrame, icam: cutCam });
        } else if (sevt === 1 && entry.varLength >= 36) {
          // SSE: vlm(4), sty(4), fLoop(4), ctagc(4), followed by TAGC[ctagc] (chid(4) + TAG(16))
          const sty = gg.dv.getInt32(entry.varOffset + 4, true);
          const fLoop = gg.dv.getInt32(entry.varOffset + 8, true) !== 0 || sty === 4;
          const ctagc = Math.max(1, gg.dv.getInt32(entry.varOffset + 12, true));

          const cnoList: number[] = [];
          for (let t = 0; t < ctagc; t++) {
            const base = entry.varOffset + 16 + t * 20;
            if (base + 20 > entry.varOffset + entry.varLength) break;
            const tagCtg = readTagReversed(gg.data, base + 12);
            const msndCno = gg.dv.getUint32(base + 16, true);
            if (tagCtg === 'MSND') {
              cnoList.push(msndCno);
            }
          }

          if (cnoList.length === 1) {
            const msndCno = cnoList[0];
            const isStopper = msndCno === 20479 || msndCno === 12707;
            audios.push({
              id: `snd_${sIdx}_${i}_0`,
              frame: relFrame,
              filename: isStopper
                ? msndCno === 20479
                  ? 'Stop Music'
                  : 'Stop Sound'
                : `${sty === 4 ? 'Music' : 'Sound'} #${msndCno}`,
              audioData: '',
              isMidi: sty === 4 || msndCno === 20479,
              loop: fLoop && !isStopper,
              msndCno,
              isStopper,
            });
          } else if (cnoList.length > 1) {
            // Multiple TAGC entries on a single SSE represent an ordered sequence/playlist
            audios.push({
              id: `snd_${sIdx}_${i}_seq`,
              frame: relFrame,
              filename: `${sty === 4 ? 'Music Sequence' : 'Sound Sequence'} (${cnoList.length})`,
              audioData: '',
              isMidi: sty === 4,
              loop: fLoop,
              msndCno: cnoList[0],
              playlist: cnoList.map((cno) => ({ name: `${cno}`, msndCno: cno } as { audioData?: string; midiData?: string; isMidi?: boolean; name?: string; msndCno?: number })),
            });
          }
        }
      }
    }

    cameraCuts.sort((a, b) => a.frame - b.frame);

    const actors: ActorEntity[] = [];
    const props: PropEntity[] = [];
    const tdtTexts: TdtTextEntity[] = [];
    const textBoxes: ScreenTextBox[] = [];

    const acrToHex = (acr: number): string | undefined => {
      if (acr === 0xffffffff || acr === 0) return undefined;
      const hi = acr >>> 24;
      if (hi === 0xfe || hi === 0xfd) {
        return socpalHex(acr & 0xff);
      }
      // Low 16-bit palette index fallback for legacy writers
      if (hi === 0 && (acr & 0xffff00) === 0 && (acr & 0xff) > 0) {
        return socpalHex(acr & 0xff);
      }
      const r = acr & 0xff;
      const g = (acr >>> 8) & 0xff;
      const b = (acr >>> 16) & 0xff;
      return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    };

    // Parse 2D Text Boxes (SCEN -> TBOX -> RTXT -> TEXT) for credits & captions
    const tboxKids = chunky.findKids(scenMeta, 'TBOX');
    for (let tIdx = 0; tIdx < tboxKids.length; tIdx++) {
      const tbMeta = tboxKids[tIdx].meta;
      const tbBytes = await chunky.readChunk('TBOX', tbMeta.cno);
      if (tbBytes.length < 36) continue;
      const tbDv = new DataView(tbBytes.buffer, tbBytes.byteOffset, tbBytes.byteLength);
      const tbFirst = tbDv.getInt32(4, true);
      const tbLast = tbDv.getInt32(8, true);
      const left = tbDv.getInt32(12, true);
      const right = tbDv.getInt32(16, true);
      const top = tbDv.getInt32(20, true);
      const bottom = tbDv.getInt32(24, true);
      const explicitScrollFlag = tbDv.getInt32(28, true);
      const fStory = tbDv.getInt32(32, true);
      const startFrame = Math.max(0, Math.min(totalFrames, tbFirst - nfrmFirst));
      const endFrame =
        tbLast >= 2147483640
          ? totalFrames
          : Math.max(startFrame, Math.min(totalFrames, tbLast - nfrmFirst));

      for (const rtxKid of chunky.findKids(tbMeta, 'RTXT')) {
        const rtxBytes = await chunky.readChunk('RTXT', rtxKid.meta.cno);
        const rtxDv = new DataView(rtxBytes.buffer, rtxBytes.byteOffset, rtxBytes.byteLength);
        let defaultFontName = 'Comic Sans MS';
        let baseFontSize = rtxBytes.length >= 12 ? rtxDv.getInt32(8, true) || 14 : 14;
        if (baseFontSize < 8 || baseFontSize > 72) baseFontSize = 14;

        let bgColor: string | undefined;
        if (rtxBytes.length >= 16) {
          bgColor = acrToHex(rtxDv.getUint32(12, true));
        }

        if (rtxBytes.length >= 20) {
          const strLen = rtxBytes[18];
          if (strLen > 0 && 19 + strLen <= rtxBytes.length) {
            const parsedFont = Array.from(rtxBytes.subarray(19, 19 + strLen), (b) =>
              String.fromCharCode(b)
            )
              .join('')
              .replace(/\0/g, '')
              .trim();
            if (parsedFont) defaultFontName = parsedFont;
          }
        }

        // Parse child AGPA font table
        const agpaFonts = new Map<number, string>();
        for (const agKid of chunky.findKids(rtxKid.meta, 'AGPA')) {
          const agBytes = await chunky.readChunk('AGPA', agKid.meta.cno);
          if (agBytes.length >= 34) {
            const len = agBytes[32];
            if (len > 0 && 33 + len <= agBytes.length) {
              const nm = Array.from(agBytes.subarray(33, 33 + len), (b) =>
                String.fromCharCode(b)
              )
                .join('')
                .replace(/\0/g, '')
                .trim();
              if (nm) agpaFonts.set(agKid.kid.chid + 1, nm);
            }
          }
        }

        // Collect raw TEXT string keeping exact char offsets for GLMP runs
        const rawTextChunks: string[] = [];
        for (const txtKid of chunky.findKids(rtxKid.meta, 'TEXT')) {
          const txtBytes = await chunky.readChunk('TEXT', txtKid.meta.cno);
          const startOff = txtBytes.length >= 2 && txtBytes[0] === 3 && txtBytes[1] === 3 ? 2 : 0;
          const decodedRaw = Array.from(txtBytes.subarray(startOff), (b) => {
            if (b === 0x95) return '•';
            if (b === 0x93 || b === 0x94) return '"';
            if (b === 0x91 || b === 0x92) return "'";
            if (b === 0x96 || b === 0x97) return '-';
            return String.fromCharCode(b);
          }).join('');
          if (decodedRaw.length > 0) rawTextChunks.push(decodedRaw);
        }

        const rawCombined = rawTextChunks.join('\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (rawCombined.trim().length === 0) continue;

        interface GlmpEvent {
          cp: number;
          order: number;
          tag: number;
          a: number;
          b: number;
          u32: number;
        }
        const glmpEvents: GlmpEvent[] = [];
        const glmpKid = chunky.findKid(rtxKid.meta, 'GLMP');
        if (glmpKid) {
          const glmp = parseGL(await chunky.readChunk('GLMP', glmpKid.cno));
          for (let gi = 0; gi < glmp.count; gi++) {
            const go = glmp.entryOffset(gi);
            const cp =
              glmp.data[go] | (glmp.data[go + 1] << 8) | (glmp.data[go + 2] << 16);
            const tag = glmp.data[go + 3];
            const a = glmp.dv.getInt16(go + 4, true);
            const b = glmp.dv.getInt16(go + 6, true);
            const u32 = glmp.dv.getUint32(go + 4, true);
            glmpEvents.push({ cp, order: gi, tag, a, b, u32 });
          }
          glmpEvents.sort((x, y) => x.cp - y.cp || x.order - y.order);
        }

        // Build exact character-range runs from GLMP events
        let curFont = defaultFontName;
        let curSize = baseFontSize;
        let curBold = false;
        let curItalic = false;
        let curColor: string | undefined;

        const applyGlmpEv = (ev: GlmpEvent) => {
          if (ev.tag === 1) {
            curBold = (ev.a & 1) !== 0;
            curItalic = (ev.a & 2) !== 0;
            curSize = Math.max(8, Math.min(72, baseFontSize + ev.b));
          } else if (ev.tag === 2) {
            const agName = ev.a > 0 ? agpaFonts.get(ev.a) : agpaFonts.get(1);
            if (agName) curFont = agName;
          } else if (ev.tag === 3) {
            curColor = acrToHex(ev.u32);
          }
        };

        const runs: ScreenTextRun[] = [];
        if (glmpEvents.length > 0) {
          let cursor = 0;
          let idx = 0;
          while (idx < glmpEvents.length && glmpEvents[idx].cp <= 0) {
            applyGlmpEv(glmpEvents[idx]);
            idx++;
          }
          while (idx < glmpEvents.length) {
            const nextCp = Math.min(rawCombined.length, glmpEvents[idx].cp);
            if (nextCp > cursor) {
              runs.push({
                text: rawCombined.slice(cursor, nextCp),
                fontName: curFont,
                fontSize: curSize,
                color: curColor,
                bold: curBold,
                italic: curItalic,
              });
              cursor = nextCp;
            }
            while (idx < glmpEvents.length && glmpEvents[idx].cp <= nextCp) {
              applyGlmpEv(glmpEvents[idx]);
              idx++;
            }
          }
          if (cursor < rawCombined.length) {
            runs.push({
              text: rawCombined.slice(cursor),
              fontName: curFont,
              fontSize: curSize,
              color: curColor,
              bold: curBold,
              italic: curItalic,
            });
          }
        }

        const primaryRun =
          runs.find((r) => r.text.trim().length > 0) ||
          runs[0] || {
            text: rawCombined,
            fontName: curFont,
            fontSize: curSize,
            color: curColor,
            bold: curBold,
            italic: curItalic,
          };

        const hasMultiStyleRuns =
          runs.length > 1 &&
          runs.some(
            (r) =>
              r.fontName !== primaryRun.fontName ||
              r.fontSize !== primaryRun.fontSize ||
              r.color !== primaryRun.color ||
              r.bold !== primaryRun.bold ||
              r.italic !== primaryRun.italic
          );

        const isCreditsScroll =
          explicitScrollFlag === 1 ||
          (fStory === 0 &&
            ((tbLast >= 2147483640 &&
              (rawCombined.includes('\n') || startFrame >= Math.max(0, totalFrames - 2))) ||
              (rawCombined.includes('\n') && bottom - top >= 48)));

        textBoxes.push({
          id: `tbox_${sIdx}_${tIdx}_${tbMeta.cno}`,
          text: rawCombined,
          ...(hasMultiStyleRuns ? { runs } : {}),
          fontName: primaryRun.fontName || defaultFontName,
          fontSize: primaryRun.fontSize ?? baseFontSize,
          color: primaryRun.color,
          bgColor,
          bold: Boolean(primaryRun.bold),
          italic: Boolean(primaryRun.italic),
          startFrame,
          endFrame,
          left,
          top,
          right,
          bottom,
          isScrolling: isCreditsScroll,
        });
      }
    }

    const actrKids = chunky.findKids(scenMeta, 'ACTR');
    for (let aIdx = 0; aIdx < actrKids.length; aIdx++) {
      const actrMeta = actrKids[aIdx].meta;
      const actrBytes = await chunky.readChunk('ACTR', actrMeta.cno);
      const aDv = new DataView(actrBytes.buffer, actrBytes.byteOffset, actrBytes.byteLength);

      const actrBaseX = readFixed16(aDv, 4);
      const actrBaseY = readFixed16(aDv, 8);
      const actrBaseZ = readFixed16(aDv, 12);
      const tmplTagCtg = actrBytes.length >= 44 ? readTagReversed(actrBytes, 36) : '';
      const tmplCno = actrBytes.length >= 44 ? aDv.getUint32(40, true) : 0;

      const tdtTmplMeta = tmplTagCtg === 'TMPL' ? chunky.getChunkMeta('TMPL', tmplCno) : null;
      const tdtKid = tdtTmplMeta ? chunky.findKid(tdtTmplMeta, 'TDT ') : null;

      let tdtSpec: { text: string; tdts: number; tdfCno: number } | null = null;
      if (tdtKid && tdtTmplMeta) {
        const tdtBytes = await chunky.readChunk('TDT ', tdtKid.cno);
        if (tdtBytes.length >= 24) {
          const tdv = new DataView(tdtBytes.buffer, tdtBytes.byteOffset, tdtBytes.byteLength);
          tdtSpec = {
            text: tdtTmplMeta.name || '',
            tdts: tdv.getInt32(4, true),
            tdfCno: tdv.getInt32(20, true),
          };
        }
      }

      const inActorCat = catalog.actors.find((a) => a.tmplCno === tmplCno);
      const inPropCat = catalog.props.find((p) => p.tmplCno === tmplCno);
      if (tmplTagCtg !== 'TMPL' || (!inActorCat && !inPropCat && !tdtSpec)) {
        continue;
      }

      // Parse PATH chunk (GL of RPT { dxr, dyr, dzr, dwr })
      const pathNodes: PathNode[] = [];
      const pathKid = chunky.findKid(actrMeta, 'PATH');
      if (pathKid) {
        const pathBytes = await chunky.readChunk('PATH', pathKid.cno);
        const gl = parseGL(pathBytes);
        for (let p = 0; p < gl.count; p++) {
          const o = gl.entryOffset(p);
          pathNodes.push({
            x: readFixed16(gl.dv, o + 0),
            y: readFixed16(gl.dv, o + 4),
            z: readFixed16(gl.dv, o + 8),
            dwr: readFixed16(gl.dv, o + 12),
          });
        }
      }

      // Preload template actions so we know cel dwr step lengths and names
      let tmplObj = null;
      const loadedActions = new Map<number, ParsedAction>();
      if (!tdtSpec) {
        try {
          tmplObj = await loadTemplate(tmplCno);
        } catch {
          tmplObj = null;
        }
      }

      let firstAnid = 0;
      let firstActionName = 'At Rest';
      const actionKeyframes: Record<number, ActionKeyframe> = {};
      const costumeCmids: number[] = [];
      const costumeMtrls: CostumeMtrlOverride[] = [];
      const keyframes: Record<number, KeyframePosition> = {};

      const ggaeMeta = chunky.findKid(actrMeta, 'GGAE');

      interface ParsedAev {
        aet: number;
        frame: number;
        irpt: number;
        dwrOffset: number;
        varOffset: number;
        varLength: number;
      }
      const eventsByFrame = new Map<number, ParsedAev[]>();

      if (ggaeMeta) {
        const ggaeBytes = await chunky.readChunk('GGAE', ggaeMeta.cno);
        const gg = parseGG(ggaeBytes);
        for (let i = 0; i < gg.count; i++) {
          const e = gg.getEntry(i);
          const aet = gg.dv.getInt32(e.fixedOffset + 0, true);
          const nfrm = gg.dv.getInt32(e.fixedOffset + 4, true);
          // RTEL: dnFrm(4), irpt(4), dwrOffset(4)
          const irpt = gg.dv.getInt32(e.fixedOffset + 12, true);
          const dwrOffset = readFixed16(gg.dv, e.fixedOffset + 16);
          const f = Math.max(0, Math.min(totalFrames, nfrm - nfrmFirst));

          // Extract aetSnd (aet === 6) into audio cues
          if (aet === 6 && e.varLength >= 44) {
            const fLoop = gg.dv.getInt32(e.varOffset + 0, true) !== 0;
            const sty = gg.dv.getInt32(e.varOffset + 16, true);
            const fNoSound = gg.dv.getInt32(e.varOffset + 20, true) !== 0;
            const ctg = readTagReversed(gg.data, e.varOffset + 36);
            const msndCno = gg.dv.getUint32(e.varOffset + 40, true);
            if (!fNoSound && ctg === 'MSND') {
              const isStopper = msndCno === 20479 || msndCno === 12707;
              audios.push({
                id: `asnd_${sIdx}_${aIdx}_${i}`,
                frame: f,
                filename: isStopper
                  ? msndCno === 20479
                    ? 'Stop Music'
                    : 'Stop Sound'
                  : `${inActorCat?.name || inPropCat?.name || 'Actor'} Sound #${msndCno}`,
                audioData: '',
                isMidi: sty === 4 || msndCno === 20479,
                loop: (fLoop || sty === 4) && !isStopper,
                msndCno,
                isStopper,
              });
            }
          }

          // Collect aetActn upfront so actions preload before path simulation
          if (aet === 1 && e.varLength >= 4 && tmplObj) {
            const nextAnid = gg.dv.getInt32(e.varOffset, true);
            if (!loadedActions.has(nextAnid)) {
              const act = await loadAction(tmplObj, nextAnid);
              if (act) loadedActions.set(nextAnid, act);
            }
          }

          const arr = eventsByFrame.get(f) || [];
          arr.push({ aet, frame: f, irpt, dwrOffset, varOffset: e.varOffset, varLength: e.varLength });
          eventsByFrame.set(f, arr);
        }

        // Simulate frame-by-frame route & events (matching ACTOR.CPP: subroute is relative to ACTR _dxs/_dys/_dzs)
        let subX = 0;
        let subY = 0;
        let subZ = 0;
        let activeAnid = 0;
        let celIdx = 0;
        let curIrpt = 0;
        let curDwrOff = 0;
        let forcedStep: number | null = null;
        let isFrozen = false;
        let staticRotX = 0;
        let staticRotY = 0;
        let staticRotZ = 0;
        let useStaticRot = true;
        let onStage = false;
        let sizeScale = 1;
        let pullX = 1;
        let pullY = 1;
        let pullZ = 1;
        let matScaleX = 1;
        let matScaleY = 1;
        let matScaleZ = 1;
        let tweakedPos: { x: number; y: number; z: number } | null = null;

        const getActionName = (anid: number) =>
          tmplObj?.actions.find((a) => a.anid === anid)?.name ||
          (anid === 0 ? 'At Rest' : `Action ${anid}`);

        for (let f = 0; f <= totalFrames; f++) {
          let explicitRotThisFrame = false;
          const evs = eventsByFrame.get(f);
          if (evs) {
            for (const ev of evs) {
              switch (ev.aet) {
                case 0: {
                  // aetAdd: subroute world origin + initial ya orientation
                  if (ev.varLength >= 12) {
                    subX = readFixed16(gg.dv, ev.varOffset + 0);
                    subY = readFixed16(gg.dv, ev.varOffset + 4);
                    subZ = readFixed16(gg.dv, ev.varOffset + 8);
                    staticRotX = 0;
                    staticRotZ = 0;
                    if (ev.varLength >= 16) {
                      staticRotY = (gg.dv.getInt16(ev.varOffset + 14, true) * Math.PI * 2) / 65536;
                    }
                    curIrpt = Math.max(0, ev.irpt);
                    curDwrOff = Math.max(0, ev.dwrOffset);
                    useStaticRot = true;
                    explicitRotThisFrame = true;
                    onStage = true;
                  }
                  break;
                }
                case 1: {
                  // aetActn
                  if (ev.varLength >= 4) {
                    activeAnid = gg.dv.getInt32(ev.varOffset, true);
                    celIdx = ev.varLength >= 8 ? Math.max(0, gg.dv.getInt32(ev.varOffset + 4, true)) : 0;
                    // Only jump irpt on explicit non-zero path anchor (0 means RTEL no-op during continuation)
                    if (ev.irpt > 0 || ev.dwrOffset > 0) {
                      curIrpt = Math.max(0, ev.irpt);
                      curDwrOff = Math.max(0, ev.dwrOffset);
                    }
                    const foundName = getActionName(activeAnid);
                    actionKeyframes[f] = {
                      anid: activeAnid,
                      actionName: foundName,
                      celOffset: celIdx,
                      freeze: isFrozen,
                    };
                    if (Object.keys(actionKeyframes).length === 1 || f === 0) {
                      firstAnid = activeAnid;
                      firstActionName = foundName;
                    }
                  }
                  break;
                }
                case 2: {
                  // aetCost (supports both CMTL cmids and direct MTRL mtrlCno overrides, including per-frame switches)
                  if (ev.varLength >= 8) {
                    const ibset = gg.dv.getInt32(ev.varOffset, true);
                    const cmidOrDummy = gg.dv.getInt32(ev.varOffset + 4, true);
                    const fCmtl = ev.varLength >= 12 ? gg.dv.getInt32(ev.varOffset + 8, true) !== 0 : true;
                    if (fCmtl) {
                      if (cmidOrDummy >= 0 && !costumeCmids.includes(cmidOrDummy)) {
                        costumeCmids.push(cmidOrDummy);
                      }
                    } else if (ev.varLength >= 28) {
                      const mCtg = readTagReversed(gg.data, ev.varOffset + 20);
                      const mtrlCno = gg.dv.getUint32(ev.varOffset + 24, true);
                      if (mCtg === 'MTRL') {
                        costumeMtrls.push({ ibset, mtrlCno });
                      }
                    }
                  }
                  break;
                }
                case 3: {
                  // aetRotF (full 3D frame orientation)
                  if (ev.varLength >= 48) {
                    const dec = rotScaleFromBmat34(gg.dv, ev.varOffset);
                    staticRotX = dec.rotX;
                    staticRotY = dec.rotY;
                    staticRotZ = dec.rotZ;
                    if (
                      Math.abs(dec.scaleX - 1) > 0.03 ||
                      Math.abs(dec.scaleY - 1) > 0.03 ||
                      Math.abs(dec.scaleZ - 1) > 0.03
                    ) {
                      matScaleX = Math.max(0.05, dec.scaleX);
                      matScaleY = Math.max(0.05, dec.scaleY);
                      matScaleZ = Math.max(0.05, dec.scaleZ);
                    }
                    useStaticRot = false;
                    explicitRotThisFrame = true;
                  }
                  break;
                }
                case 4: {
                  // aetPull: stretch / squash along X, Y, Z
                  if (ev.varLength >= 12) {
                    pullX = Math.max(0.05, readFixed16(gg.dv, ev.varOffset + 0));
                    pullY = Math.max(0.05, readFixed16(gg.dv, ev.varOffset + 4));
                    pullZ = Math.max(0.05, readFixed16(gg.dv, ev.varOffset + 8));
                  }
                  break;
                }
                case 5: {
                  // aetSize: uniform size multiplier
                  if (ev.varLength >= 4) {
                    sizeScale = Math.max(0.05, readFixed16(gg.dv, ev.varOffset));
                  }
                  break;
                }
                case 12: {
                  // aetRotH (full 3D held orientation)
                  if (ev.varLength >= 48) {
                    const dec = rotScaleFromBmat34(gg.dv, ev.varOffset);
                    staticRotX = dec.rotX;
                    staticRotY = dec.rotY;
                    staticRotZ = dec.rotZ;
                    if (
                      Math.abs(dec.scaleX - 1) > 0.03 ||
                      Math.abs(dec.scaleY - 1) > 0.03 ||
                      Math.abs(dec.scaleZ - 1) > 0.03
                    ) {
                      matScaleX = Math.max(0.05, dec.scaleX);
                      matScaleY = Math.max(0.05, dec.scaleY);
                      matScaleZ = Math.max(0.05, dec.scaleZ);
                    }
                    useStaticRot = true;
                    explicitRotThisFrame = true;
                  }
                  break;
                }
                case 7: {
                  // aetMove (cumulative offset onto subroute)
                  if (ev.varLength >= 12) {
                    subX += readFixed16(gg.dv, ev.varOffset + 0);
                    subY += readFixed16(gg.dv, ev.varOffset + 4);
                    subZ += readFixed16(gg.dv, ev.varOffset + 8);
                  }
                  break;
                }
                case 8: {
                  // aetFreeze
                  if (ev.varLength >= 4) {
                    const nextFrozen = gg.dv.getInt32(ev.varOffset, true) !== 0;
                    if (nextFrozen !== isFrozen) {
                      isFrozen = nextFrozen;
                      actionKeyframes[f] = {
                        anid: activeAnid,
                        actionName: getActionName(activeAnid),
                        celOffset: celIdx,
                        freeze: isFrozen,
                      };
                    }
                  }
                  break;
                }
                case 9: {
                  // aetTweak
                  if (ev.varLength >= 12) {
                    tweakedPos = {
                      x: readFixed16(gg.dv, ev.varOffset + 0),
                      y: readFixed16(gg.dv, ev.varOffset + 4),
                      z: readFixed16(gg.dv, ev.varOffset + 8),
                    };
                  }
                  break;
                }
                case 10: {
                  // aetStep: < 0 (-1.0) means use action's automatic cel dwr; >= 0 overrides step
                  if (ev.varLength >= 4) {
                    const rawStep = readFixed16(gg.dv, ev.varOffset);
                    forcedStep = rawStep < 0 ? null : rawStep;
                    if (rawStep === 0 && (ev.irpt > 0 || ev.dwrOffset > 0)) {
                      curIrpt = Math.max(0, ev.irpt);
                      curDwrOff = Math.max(0, ev.dwrOffset);
                    }
                  }
                  break;
                }
                case 11: {
                  // aetRem
                  onStage = false;
                  break;
                }
              }
            }
          }

          const pPos = tweakedPos || evalPathPos(pathNodes, curIrpt, curDwrOff);
          tweakedPos = null;
          const tangYaw =
            !useStaticRot && !explicitRotThisFrame
              ? evalPathTangentYaw(pathNodes, curIrpt)
              : null;
          const rotY = tangYaw !== null ? tangYaw : staticRotY;

          const sx = sizeScale * pullX * matScaleX;
          const sy = sizeScale * pullY * matScaleY;
          const sz = sizeScale * pullZ * matScaleZ;
          const hasNonUnitScale =
            Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01 || Math.abs(sz - 1) > 0.01;

          const kfEntry: KeyframePosition = {
            x: actrBaseX + subX + pPos.x,
            y: actrBaseY + subY + pPos.y,
            z: actrBaseZ + subZ + pPos.z,
            rotY,
          };
          if (Math.abs(staticRotX) > 0.005) kfEntry.rotX = staticRotX;
          if (Math.abs(staticRotZ) > 0.005) kfEntry.rotZ = staticRotZ;
          if (hasNonUnitScale) {
            kfEntry.scaleX = sx;
            kfEntry.scaleY = sy;
            kfEntry.scaleZ = sz;
          }
          if (!onStage) {
            kfEntry.visible = false;
          }
          keyframes[f] = kfEntry;

          // Advance path and action cel for next frame
          if (onStage && !isFrozen) {
            const act = loadedActions.get(activeAnid) || tmplObj?.actionCache.get(0);
            const celDwr =
              act && act.cels.length > 0
                ? act.cels[
                    isCyclic3dmmAction(act.name)
                      ? ((celIdx % act.cels.length) + act.cels.length) % act.cels.length
                      : Math.min(act.cels.length - 1, Math.max(0, celIdx))
                  ].dwr
                : 0;
            const step = forcedStep !== null ? forcedStep : celDwr;
            celIdx++;

            if (pathNodes.length > 1 && step > 0 && curIrpt + 1 < pathNodes.length) {
              useStaticRot = false;
              let rem = step + curDwrOff;
              while (
                curIrpt + 1 < pathNodes.length &&
                pathNodes[curIrpt].dwr > 0 &&
                rem >= pathNodes[curIrpt].dwr
              ) {
                rem -= pathNodes[curIrpt].dwr;
                curIrpt++;
              }
              curDwrOff = curIrpt + 1 < pathNodes.length ? rem : 0;
            }
          }
        }
      }

      if (Object.keys(keyframes).length === 0) {
        keyframes[0] = { x: actrBaseX, y: actrBaseY, z: actrBaseZ, rotY: 0 };
      }

      // Apply optional per-keyframe COLR chunk OR multi-frame TDT aetCost color changes
      const colrKid = chunky.findKid(actrMeta, 'COLR');
      const colorByFrame = new Map<number, string>();
      if (colrKid) {
        try {
          const colrBytes = await chunky.readChunk('COLR', colrKid.cno);
          const jsonStr = new TextDecoder().decode(colrBytes);
          const parsedColrs = JSON.parse(jsonStr) as Record<string, string>;
          Object.entries(parsedColrs).forEach(([fk, hex]) => {
            if (typeof hex === 'string' && hex.startsWith('#')) {
              colorByFrame.set(Number(fk), hex);
            }
          });
        } catch {
          // ignore malformed COLR
        }
      }
      if (tdtSpec && ggaeMeta) {
        const gg = parseGG(await chunky.readChunk('GGAE', ggaeMeta.cno));
        let initialTdtMtrl: number | undefined;
        let lastTdtMtrl: number | undefined;
        const sortedAevFrames = Array.from(eventsByFrame.keys()).sort((a, b) => a - b);
        for (const f of sortedAevFrames) {
          for (const ev of eventsByFrame.get(f) || []) {
            if (ev.aet !== 2 || ev.varLength < 28) continue;
            const fCmtl = gg.dv.getInt32(ev.varOffset + 8, true) !== 0;
            if (fCmtl) continue;
            const mCtg = readTagReversed(gg.data, ev.varOffset + 20);
            const mtrlCno = gg.dv.getUint32(ev.varOffset + 24, true);
            if (mCtg !== 'MTRL') continue;
            if (initialTdtMtrl === undefined) {
              initialTdtMtrl = mtrlCno;
            }
            if (mtrlCno !== lastTdtMtrl) {
              lastTdtMtrl = mtrlCno;
              const hex = await resolveMtrlHex(mtrlCno, basePalette, chunky);
              if (hex && (!colorByFrame.has(f))) {
                colorByFrame.set(f, hex);
              }
            }
          }
        }
        if (initialTdtMtrl !== undefined) {
          // Ensure frame 0 uses initialTdtMtrl cleanly
          costumeMtrls.splice(0, costumeMtrls.length, { ibset: 0, mtrlCno: initialTdtMtrl });
        }
      }

      // Compress identical consecutive stationary keyframes while keeping all motion, scale, color & visibility frames intact
      const sparseKeyframes: Record<number, KeyframePosition> = {};
      const allFrameNums = Array.from(
        new Set([
          ...Object.keys(keyframes).map(Number),
          ...Array.from(colorByFrame.keys()),
        ])
      ).sort((a, b) => a - b);

      let lastSaved: KeyframePosition | null = null;
      for (const f of allFrameNums) {
        const baseKf = keyframes[f] || (lastSaved ? { ...lastSaved } : { x: actrBaseX, y: actrBaseY, z: actrBaseZ, rotY: 0 });
        const explicitColor = colorByFrame.get(f);
        const cur: KeyframePosition = explicitColor ? { ...baseKf, color: explicitColor } : baseKf;
        if (
          !lastSaved ||
          explicitColor !== undefined ||
          (cur.visible !== false) !== (lastSaved.visible !== false) ||
          Math.abs(cur.x - lastSaved.x) > 0.005 ||
          Math.abs(cur.y - lastSaved.y) > 0.005 ||
          Math.abs(cur.z - lastSaved.z) > 0.005 ||
          Math.abs((cur.rotX ?? 0) - (lastSaved.rotX ?? 0)) > 0.005 ||
          Math.abs(cur.rotY - lastSaved.rotY) > 0.005 ||
          Math.abs((cur.rotZ ?? 0) - (lastSaved.rotZ ?? 0)) > 0.005 ||
          Math.abs((cur.scaleX ?? 1) - (lastSaved.scaleX ?? 1)) > 0.005 ||
          Math.abs((cur.scaleY ?? 1) - (lastSaved.scaleY ?? 1)) > 0.005 ||
          Math.abs((cur.scaleZ ?? 1) - (lastSaved.scaleZ ?? 1)) > 0.005
        ) {
          sparseKeyframes[f] = cur;
          lastSaved = cur;
        }
      }

      if (tdtSpec) {
        if (tdtSpec.text.length > 0) {
          let tdtAction: string | undefined;
          let tdtActionKeyframes: TdtTextEntity['actionKeyframes'];

          const akEntries = Object.entries(actionKeyframes).sort(([a], [b]) => Number(a) - Number(b));
          if (akEntries.length > 0) {
            tdtActionKeyframes = {};
            for (const [fk, av] of akEntries) {
              tdtActionKeyframes[Number(fk)] = {
                action: anidToTdtAction(av.anid),
                ...(av.freeze ? { freeze: true } : {}),
              };
            }
            tdtAction = tdtActionKeyframes[Number(akEntries[0][0])].action;
          }

          const tdtaKid = chunky.findKid(actrMeta, 'TDTA');
          if (tdtaKid) {
            try {
              const tdtaBytes = await chunky.readChunk('TDTA', tdtaKid.cno);
              const parsedTdta = JSON.parse(new TextDecoder().decode(tdtaBytes)) as {
                action?: string;
                actionKeyframes?: TdtTextEntity['actionKeyframes'];
              };
              if (parsedTdta.action) {
                tdtAction = normalizeTdtActionName(parsedTdta.action);
              }
              if (parsedTdta.actionKeyframes) {
                const normKfs: TdtTextEntity['actionKeyframes'] = {};
                for (const [fk, av] of Object.entries(parsedTdta.actionKeyframes)) {
                  normKfs[Number(fk)] = {
                    action: normalizeTdtActionName(av.action),
                    ...(av.freeze ? { freeze: true } : {}),
                  };
                }
                tdtActionKeyframes = normKfs;
              }
            } catch {
              // ignore malformed TDTA
            }
          }
          tdtTexts.push({
            id: `tdt_${sIdx}_${aIdx}_${tmplCno}`,
            text: tdtSpec.text,
            tdfCno: tdtSpec.tdfCno,
            tdts: tdtSpec.tdts,
            mtrlCno: costumeMtrls[0]?.mtrlCno,
            ...(tdtAction ? { action: tdtAction } : {}),
            ...(tdtActionKeyframes ? { actionKeyframes: tdtActionKeyframes } : {}),
            keyframes: sparseKeyframes,
          });
        }
      } else if (inPropCat) {
        const propAkfs: Record<number, PropActionKeyframe> = {};
        Object.entries(actionKeyframes).forEach(([fk, av]) => {
          propAkfs[Number(fk)] = {
            action: av.actionName,
            anid: av.anid,
            celOffset: av.celOffset,
            freeze: av.freeze,
          };
        });
        const defPropActName =
          Object.keys(actionKeyframes).length > 0
            ? firstActionName
            : tmplObj?.actions[0]?.name || 'At Rest';
        const defPropAnid =
          Object.keys(actionKeyframes).length > 0
            ? firstAnid
            : (tmplObj?.actions[0]?.anid ?? 0);

        props.push({
          id: `prop_${sIdx}_${aIdx}_${tmplCno}`,
          tmplCno,
          name: inPropCat.name,
          action: defPropActName,
          anid: defPropAnid,
          actionKeyframes: Object.keys(propAkfs).length > 0 ? propAkfs : undefined,
          costumeCmids: costumeCmids.length > 0 ? costumeCmids : undefined,
          costumeMtrls: costumeMtrls.length > 0 ? costumeMtrls : undefined,
          keyframes: sparseKeyframes,
        });
      } else if (inActorCat) {
        actors.push({
          id: `actor_${sIdx}_${aIdx}_${tmplCno}`,
          tmplCno,
          name: inActorCat.name,
          anid: firstAnid,
          actionName: firstActionName,
          actionKeyframes: Object.keys(actionKeyframes).length > 0 ? actionKeyframes : undefined,
          costumeCmids: costumeCmids.length > 0 ? costumeCmids : undefined,
          costumeMtrls: costumeMtrls.length > 0 ? costumeMtrls : undefined,
          keyframes: sparseKeyframes,
        });
      }
    }

    // Hydrate audioData (WAV) OR midiData (MIDS) for all extracted MSND cues (including custom MSND:0, playlists & stoppers)
    const dedupedAudios: ImportedAudioCue[] = [];
    const seenAudioKeys = new Set<string>();
    for (const cue of audios) {
      const k = `${cue.frame}:${cue.msndCno}:${cue.playlist ? cue.playlist.length : 1}`;
      if (seenAudioKeys.has(k)) continue;
      seenAudioKeys.add(k);

      if (cue.isStopper) {
        dedupedAudios.push(cue);
        continue;
      }

      if (cue.playlist && cue.playlist.length > 0) {
        const hydratedList: NonNullable<ImportedAudioCue['playlist']> = [];
        for (const item of cue.playlist) {
          const subCno = (item as { msndCno?: number }).msndCno;
          if (subCno !== undefined) {
            const ex = await sound3DMM.extractMsndCueData(subCno, chunky);
            if (ex) hydratedList.push(ex);
          }
        }
        if (hydratedList.length > 0) {
          cue.playlist = hydratedList;
          cue.isMidi = Boolean(hydratedList[0].isMidi);
          cue.midiData = hydratedList[0].midiData;
          cue.audioData = hydratedList[0].audioData || '';
          cue.filename = hydratedList.map((h) => h.name || '').filter(Boolean).join(' -> ') || cue.filename;
          dedupedAudios.push(cue);
        }
        continue;
      }

      if (cue.msndCno !== undefined && cue.msndCno >= 0) {
        const extracted = await sound3DMM.extractMsndCueData(cue.msndCno, chunky);
        if (extracted) {
          if (extracted.audioData) cue.audioData = extracted.audioData;
          if (extracted.midiData) {
            cue.midiData = extracted.midiData;
            cue.isMidi = true;
          }
          if (extracted.name) cue.filename = extracted.name;
          dedupedAudios.push(cue);
        }
      }
    }

    scenes.push({
      id: `scene_3mm_${sIdx}`,
      bkgdCno: matchedBg.bkgdCno,
      sceneName: matchedBg.name,
      icam,
      cameraAngle: { yaw: 0, pitch: 0 },
      cameraCuts: cameraCuts.length > 0 ? cameraCuts : undefined,
      transition,
      coordMode: 'world',
      actors,
      props,
      tdtTexts: tdtTexts.length > 0 ? tdtTexts : undefined,
      textBoxes: textBoxes.length > 0 ? textBoxes : undefined,
      audios: dedupedAudios,
      totalFrames,
    });
  }

  return {
    title: fallbackTitle.replace(/\.3mm$/i, ''),
    scenes:
      scenes.length > 0
        ? scenes
        : [
            {
              id: 'scene_fallback',
              bkgdCno: 0,
              sceneName: 'MY-Street',
              icam: 0,
              cameraAngle: { yaw: 0, pitch: 0 },
              coordMode: 'stage',
              actors: [],
              props: [],
              audios: [],
              totalFrames: 60,
            },
          ],
  };
}

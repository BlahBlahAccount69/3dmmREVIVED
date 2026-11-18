import {
  ActionKeyframe,
  ActorEntity,
  CameraCutEvent,
  CostumeMtrlOverride,
  ImportedAudioCue,
  KeyframePosition,
  Movie,
  PropEntity,
  Scene,
  ScreenTextBox,
  TdtTextEntity,
} from '../types/movie';
import { ChunkyFile } from './chunkyParser';
import { parseGG, parseGL, readBmat34ToMatrix4, readFixed16, readTagReversed } from './kauaiCodec';
import {
  CatalogSceneItem,
  loadAction,
  loadTemplate,
  loadThreeDmmCatalog,
  ParsedAction,
} from './threeDmmEngine';
import { sound3DMM } from './soundLibrary';
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
const _tmpForward = new THREE.Vector3();

function yawFromBmat34(dv: DataView, byteOffset: number): number {
  readBmat34ToMatrix4(dv, byteOffset, _tmpMat);
  _tmpForward.set(0, 0, 1).applyMatrix4(_tmpMat).sub(
    new THREE.Vector3().setFromMatrixPosition(_tmpMat)
  );
  if (Math.hypot(_tmpForward.x, _tmpForward.z) < 1e-4) return 0;
  return Math.atan2(_tmpForward.x, _tmpForward.z);
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
  const [catalog, chunky] = await Promise.all([
    loadThreeDmmCatalog(),
    typeof source === 'string'
      ? ChunkyFile.fromUrl(source, true)
      : Promise.resolve(ChunkyFile.fromBuffer(source)),
  ]);

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
    const totalFrames = Math.max(15, Math.min(1800, nfrmLast - nfrmFirst + 1));

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
          } else if (!firstCamSet && cameraCuts.length === 0) {
            icam = cutCam;
            firstCamSet = true;
          }
          cameraCuts.push({ frame: relFrame, icam: cutCam });
        } else if (sevt === 1 && entry.varLength >= 36) {
          // SSE: vlm(4), sty(4), fLoop(4), ctagc(4), followed by TAGC[ctagc] (chid(4) + TAG(16))
          const sty = gg.dv.getInt32(entry.varOffset + 4, true);
          const fLoop = gg.dv.getInt32(entry.varOffset + 8, true) !== 0 || sty === 4;
          const ctagc = Math.max(1, gg.dv.getInt32(entry.varOffset + 12, true));

          for (let t = 0; t < ctagc; t++) {
            const base = entry.varOffset + 16 + t * 20;
            if (base + 20 > entry.varOffset + entry.varLength) break;
            const tagCtg = readTagReversed(gg.data, base + 12);
            const msndCno = gg.dv.getUint32(base + 16, true);
            if (tagCtg === 'MSND' && msndCno > 0) {
              audios.push({
                id: `snd_${sIdx}_${i}_${t}`,
                frame: relFrame,
                filename: `${sty === 4 ? 'Music' : 'Sound'} #${msndCno}`,
                audioData: '',
                loop: fLoop,
                msndCno,
              });
            }
          }
        }
      }
    }

    cameraCuts.sort((a, b) => a.frame - b.frame);

    const actors: ActorEntity[] = [];
    const props: PropEntity[] = [];
    const tdtTexts: TdtTextEntity[] = [];
    const textBoxes: ScreenTextBox[] = [];

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
      const fStory = tbDv.getInt32(32, true);
      const startFrame = Math.max(0, Math.min(totalFrames, tbFirst - nfrmFirst));
      const endFrame =
        tbLast >= 2147483640
          ? totalFrames
          : Math.max(startFrame, Math.min(totalFrames, tbLast - nfrmFirst));

      for (const rtxKid of chunky.findKids(tbMeta, 'RTXT')) {
        const rtxBytes = await chunky.readChunk('RTXT', rtxKid.meta.cno);
        let fontName = 'Comic Sans MS';
        if (rtxBytes.length >= 20) {
          const strLen = rtxBytes[18];
          if (strLen > 0 && 19 + strLen <= rtxBytes.length) {
            const parsedFont = Array.from(rtxBytes.subarray(19, 19 + strLen), (b) =>
              String.fromCharCode(b)
            )
              .join('')
              .replace(/\0/g, '')
              .trim();
            if (parsedFont) fontName = parsedFont;
          }
        }

        const textParts: string[] = [];
        for (const txtKid of chunky.findKids(rtxKid.meta, 'TEXT')) {
          const txtBytes = await chunky.readChunk('TEXT', txtKid.meta.cno);
          const startOff = txtBytes.length >= 2 && txtBytes[0] === 3 && txtBytes[1] === 3 ? 2 : 0;
          const decoded = Array.from(txtBytes.subarray(startOff), (b) => {
            if (b === 0x95) return '•';
            if (b === 0x93 || b === 0x94) return '"';
            if (b === 0x91 || b === 0x92) return "'";
            if (b === 0x96 || b === 0x97) return '-';
            return String.fromCharCode(b);
          })
            .join('')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');
          if (decoded.trim().length > 0) textParts.push(decoded);
        }

        if (textParts.length > 0) {
          textBoxes.push({
            id: `tbox_${sIdx}_${tIdx}_${tbMeta.cno}`,
            text: textParts.join('\n'),
            fontName,
            startFrame,
            endFrame,
            left,
            top,
            right,
            bottom,
            isScrolling: fStory === 0,
          });
        }
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
            if (!fNoSound && ctg === 'MSND' && msndCno > 0) {
              audios.push({
                id: `asnd_${sIdx}_${aIdx}_${i}`,
                frame: f,
                filename: `${inActorCat?.name || inPropCat?.name || 'Actor'} Sound #${msndCno}`,
                audioData: '',
                loop: fLoop || sty === 4,
                msndCno,
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

        // Simulate frame-by-frame route & events (matching ACTOR.CPP)
        let subX = actrBaseX;
        let subY = actrBaseY;
        let subZ = actrBaseZ;
        let activeAnid = 0;
        let celIdx = 0;
        let curIrpt = 0;
        let curDwrOff = 0;
        let forcedStep: number | null = null;
        let isFrozen = false;
        let staticRotY = 0;
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
        const _bmatDecPos = new THREE.Vector3();
        const _bmatDecQuat = new THREE.Quaternion();
        const _bmatDecScale = new THREE.Vector3();

        const getActionName = (anid: number) =>
          tmplObj?.actions.find((a) => a.anid === anid)?.name ||
          (anid === 0 ? 'At Rest' : `Action ${anid}`);

        for (let f = 0; f <= totalFrames; f++) {
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
                    if (ev.varLength >= 16) {
                      staticRotY = (gg.dv.getInt16(ev.varOffset + 14, true) * Math.PI * 2) / 65536;
                    }
                    curIrpt = Math.max(0, ev.irpt);
                    curDwrOff = Math.max(0, ev.dwrOffset);
                    useStaticRot = true;
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
                  // aetCost (supports both CMTL cmids and direct MTRLS.3CN mtrlCno overrides!)
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
                        const ex = costumeMtrls.findIndex((m) => m.ibset === ibset);
                        if (ex >= 0) costumeMtrls[ex] = { ibset, mtrlCno };
                        else costumeMtrls.push({ ibset, mtrlCno });
                      }
                    }
                  }
                  break;
                }
                case 3: {
                  // aetRotF
                  if (ev.varLength >= 48) {
                    staticRotY = yawFromBmat34(gg.dv, ev.varOffset);
                    readBmat34ToMatrix4(gg.dv, ev.varOffset, _tmpMat).decompose(
                      _bmatDecPos,
                      _bmatDecQuat,
                      _bmatDecScale
                    );
                    if (
                      Math.abs(_bmatDecScale.x - 1) > 0.03 ||
                      Math.abs(_bmatDecScale.y - 1) > 0.03 ||
                      Math.abs(_bmatDecScale.z - 1) > 0.03
                    ) {
                      matScaleX = Math.max(0.05, _bmatDecScale.x);
                      matScaleY = Math.max(0.05, _bmatDecScale.y);
                      matScaleZ = Math.max(0.05, _bmatDecScale.z);
                    }
                    useStaticRot = false;
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
                  // aetRotH
                  if (ev.varLength >= 48) {
                    staticRotY = yawFromBmat34(gg.dv, ev.varOffset);
                    readBmat34ToMatrix4(gg.dv, ev.varOffset, _tmpMat).decompose(
                      _bmatDecPos,
                      _bmatDecQuat,
                      _bmatDecScale
                    );
                    if (
                      Math.abs(_bmatDecScale.x - 1) > 0.03 ||
                      Math.abs(_bmatDecScale.y - 1) > 0.03 ||
                      Math.abs(_bmatDecScale.z - 1) > 0.03
                    ) {
                      matScaleX = Math.max(0.05, _bmatDecScale.x);
                      matScaleY = Math.max(0.05, _bmatDecScale.y);
                      matScaleZ = Math.max(0.05, _bmatDecScale.z);
                    }
                    useStaticRot = true;
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
          const tangYaw = !useStaticRot ? evalPathTangentYaw(pathNodes, curIrpt) : null;
          const rotY = tangYaw !== null ? tangYaw : staticRotY;

          const sx = sizeScale * pullX * matScaleX;
          const sy = sizeScale * pullY * matScaleY;
          const sz = sizeScale * pullZ * matScaleZ;
          const hasNonUnitScale =
            Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01 || Math.abs(sz - 1) > 0.01;

          const kfEntry: KeyframePosition = {
            x: subX + pPos.x,
            y: subY + pPos.y,
            z: subZ + pPos.z,
            rotY,
          };
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
              act && act.cels.length > 0 ? act.cels[celIdx % act.cels.length].dwr : 0;
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

      // Compress identical consecutive stationary keyframes while keeping all motion, scale, & visibility frames intact
      const sparseKeyframes: Record<number, KeyframePosition> = {};
      const sortedF = Object.keys(keyframes).map(Number).sort((a, b) => a - b);
      let lastSaved: KeyframePosition | null = null;
      for (const f of sortedF) {
        const cur = keyframes[f];
        if (
          !lastSaved ||
          (cur.visible !== false) !== (lastSaved.visible !== false) ||
          Math.abs(cur.x - lastSaved.x) > 0.005 ||
          Math.abs(cur.y - lastSaved.y) > 0.005 ||
          Math.abs(cur.z - lastSaved.z) > 0.005 ||
          Math.abs(cur.rotY - lastSaved.rotY) > 0.005 ||
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
          tdtTexts.push({
            id: `tdt_${sIdx}_${aIdx}_${tmplCno}`,
            text: tdtSpec.text,
            tdfCno: tdtSpec.tdfCno,
            tdts: tdtSpec.tdts,
            mtrlCno: costumeMtrls[0]?.mtrlCno,
            keyframes: sparseKeyframes,
          });
        }
      } else if (inPropCat) {
        props.push({
          id: `prop_${sIdx}_${aIdx}_${tmplCno}`,
          tmplCno,
          name: inPropCat.name,
          action: 'at rest',
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

    // Hydrate audioData (WAV) OR midiData (MIDS) for all extracted MSND cues so audio & MIDI play seamlessly
    const dedupedAudios: ImportedAudioCue[] = [];
    const seenAudioKeys = new Set<string>();
    for (const cue of audios) {
      const k = `${cue.frame}:${cue.msndCno}`;
      if (seenAudioKeys.has(k)) continue;
      seenAudioKeys.add(k);

      if (cue.msndCno) {
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

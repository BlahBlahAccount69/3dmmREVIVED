import React, { useEffect, useState } from 'react';
import {
  ActorEntity,
  KeyframePosition,
  PropAction,
  PropEntity,
  ScreenTextBox,
  TdtAction,
  TdtTextEntity,
} from '../types/movie';
import {
  CatalogActorItem,
  CatalogPropItem,
  loadTdtMaterialSwatches,
  loadTemplate,
  ParsedTemplate,
  TDF_FONT_OPTIONS,
  TDT_ACTIONS,
  TDT_SHAPE_OPTIONS,
  TdtMaterialSwatch,
} from '../services/threeDmmEngine';
import {
  resolveActorActionAtFrame,
  resolveInterpolatedKeyframe,
  resolvePropActionAtFrame,
  resolveTdtActionAtFrame,
} from './Viewport3D';
import { sound3DMM } from '../services/soundLibrary';
import { assetUrl } from '../utils/assetUrl';
import { RotateCcw, Trash2 } from 'lucide-react';

interface ActorPropPanelProps {
  currentFrame: number;
  totalFrames: number;
  onSeekFrame: (frame: number) => void;
  enableInterpolation?: boolean;
  catalogActors: CatalogActorItem[];
  catalogProps: CatalogPropItem[];
  actors: ActorEntity[];
  props: PropEntity[];
  tdtTexts: TdtTextEntity[];
  textBoxes: ScreenTextBox[];
  selectedEntityId: string | null;
  selectedEntityType: 'actor' | 'prop' | 'tdt' | 'tbox' | null;
  onSelectEntity: (id: string | null, type: 'actor' | 'prop' | 'tdt' | 'tbox' | null) => void;
  onAddActor: (item: CatalogActorItem) => void;
  onAddProp: (item: CatalogPropItem) => void;
  onUpdateActorAction: (id: string, anid: number, actionName: string) => void;
  onUpdateActorCostume: (id: string, costumeCmids: number[]) => void;
  onUpdatePropAction: (id: string, action: PropAction, anid?: number) => void;
  onUpdatePropCostume: (id: string, costumeCmids: number[]) => void;
  onUpdateTdtAction: (id: string, action: TdtAction | string) => void;
  onUpdateEntityColor: (id: string, type: 'actor' | 'prop' | 'tdt', color?: string) => void;
  onUpdateEntityRotation: (
    id: string,
    type: 'actor' | 'prop' | 'tdt',
    rotX: number,
    rotY: number,
    rotZ: number
  ) => void;
  onUpdateEntityScale: (
    id: string,
    type: 'actor' | 'prop' | 'tdt',
    scaleX: number,
    scaleY: number,
    scaleZ: number
  ) => void;
  onSetEntityFrame: (
    id: string,
    type: 'actor' | 'prop' | 'tdt',
    targetFrame: number,
    mode: 'pin' | 'showFrom' | 'hideFrom'
  ) => void;
  onRemoveEntityKeyframe?: (
    id: string,
    type: 'actor' | 'prop' | 'tdt',
    frame: number
  ) => void;
  onToggleEntityVisibility: (
    id: string,
    type: 'actor' | 'prop' | 'tdt',
    visible: boolean
  ) => void;
  onUpdateEntityPoseCel: (
    id: string,
    type: 'actor' | 'prop',
    celOffset: number,
    freeze: boolean
  ) => void;
  onAddTdtText: (spec: {
    text: string;
    tdfCno: number;
    tdts: number;
    mtrlCno?: number;
    color?: string;
    action?: TdtAction | string;
  }) => void;
  onUpdateTdtText: (
    id: string,
    patch: Partial<Pick<TdtTextEntity, 'text' | 'tdfCno' | 'tdts' | 'mtrlCno'>>
  ) => void;
  onAddTextBox: (spec: Omit<ScreenTextBox, 'id'>) => void;
  onUpdateTextBox: (id: string, patch: Partial<ScreenTextBox>) => void;
  isRecordingMovement: boolean;
  onToggleRecordingMovement: () => void;
  onClearKeyframes: (id: string, type: 'actor' | 'prop' | 'tdt') => void;
  onDeleteEntity: (id: string, type: 'actor' | 'prop' | 'tdt' | 'tbox') => void;
}

const PROP_ACTIONS: PropAction[] = [
  'at rest',
  'grow',
  'grow fast',
  'shrink',
  'shrink fast',
  'spin',
  'spin fast',
];

const FONT_2D_OPTIONS = [
  'Comic Sans MS',
  'Arial',
  'Futura',
  'Times New Roman',
  'Courier New',
  'Impact',
  'Verdana',
  'Georgia',
  'Trebuchet MS',
  'Tahoma',
];

function wrapDeg(rad: number): number {
  let d = Math.round((rad * 180) / Math.PI) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export const ActorPropPanel: React.FC<ActorPropPanelProps> = ({
  currentFrame,
  totalFrames,
  onSeekFrame,
  enableInterpolation = false,
  catalogActors,
  catalogProps,
  actors,
  props,
  tdtTexts,
  textBoxes,
  selectedEntityId,
  onSelectEntity,
  onAddActor,
  onAddProp,
  onUpdateActorAction,
  onUpdateActorCostume,
  onUpdatePropAction,
  onUpdatePropCostume,
  onUpdateTdtAction,
  onUpdateEntityColor,
  onUpdateEntityRotation,
  onUpdateEntityScale,
  onSetEntityFrame,
  onRemoveEntityKeyframe,
  onToggleEntityVisibility,
  onUpdateEntityPoseCel,
  onAddTdtText,
  onUpdateTdtText,
  onAddTextBox,
  onUpdateTextBox,
  isRecordingMovement,
  onToggleRecordingMovement,
  onClearKeyframes,
  onDeleteEntity,
}) => {
  const [catalogTab, setCatalogTab] = useState<'actors' | 'props' | 'words'>('actors');
  const [wordSubTab, setWordSubTab] = useState<'3d' | '2d'>('3d');
  const [search, setSearch] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<ParsedTemplate | null>(null);
  const [targetFrameInput, setTargetFrameInput] = useState<string>('0');
  const [tdtSwatches, setTdtSwatches] = useState<TdtMaterialSwatch[]>([]);

  // 3D Text creator state
  const [new3dText, setNew3dText] = useState('HELLO!');
  const [new3dFont, setNew3dFont] = useState(2); // Comic
  const [new3dShape, setNew3dShape] = useState(0); // Straight
  const [new3dMtrlCno, setNew3dMtrlCno] = useState<number>(25348);
  const [new3dAction, setNew3dAction] = useState<string>('At Rest');

  // 2D Onscreen Words creator state
  const [new2dText, setNew2dText] = useState('Type words here...');
  const [new2dFont, setNew2dFont] = useState('Comic Sans MS');
  const [new2dSize, setNew2dSize] = useState(20);
  const [new2dColor, setNew2dColor] = useState('#fde047');
  const [new2dUseBg, setNew2dUseBg] = useState(false);
  const [new2dBgColor, setNew2dBgColor] = useState('#1b0e36');
  const [new2dBold, setNew2dBold] = useState(true);
  const [new2dItalic, setNew2dItalic] = useState(false);
  const [new2dScroll, setNew2dScroll] = useState(false);
  const [new2dPreset, setNew2dPreset] = useState<'bottom' | 'top' | 'center' | 'full'>('bottom');

  const selectedActor = actors.find((a) => a.id === selectedEntityId);
  const selectedProp = props.find((p) => p.id === selectedEntityId);
  const selectedTdt = tdtTexts.find((t) => t.id === selectedEntityId);
  const selectedTextBox = textBoxes.find((tb) => tb.id === selectedEntityId);

  useEffect(() => {
    setTargetFrameInput(String(currentFrame));
  }, [currentFrame, selectedEntityId]);

  useEffect(() => {
    void loadTdtMaterialSwatches().then((sw) => {
      if (sw.length > 0) setTdtSwatches(sw);
    });
  }, []);

  const inspectedTmplCno = selectedActor?.tmplCno ?? selectedProp?.tmplCno ?? null;
  useEffect(() => {
    if (inspectedTmplCno === null) {
      setSelectedTemplate(null);
      return;
    }
    let cancelled = false;
    loadTemplate(inspectedTmplCno)
      .then((t) => {
        if (!cancelled) setSelectedTemplate(t);
      })
      .catch(() => {
        if (!cancelled) setSelectedTemplate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectedTmplCno]);

  const query = search.trim().toLowerCase();
  const filteredActors = catalogActors.filter((a) => a.name.toLowerCase().includes(query));
  const filteredProps = catalogProps.filter((p) => p.name.toLowerCase().includes(query));

  const activeActorAction = selectedActor
    ? resolveActorActionAtFrame(selectedActor, currentFrame)
    : null;
  const activePropAction = selectedProp
    ? resolvePropActionAtFrame(selectedProp, currentFrame)
    : null;
  const activeTdtAction = selectedTdt
    ? resolveTdtActionAtFrame(selectedTdt, currentFrame)
    : null;
  const selected3DEntity = selectedActor || selectedProp || selectedTdt;
  const activeTransform = selected3DEntity
    ? resolveInterpolatedKeyframe(
        selected3DEntity.keyframes,
        currentFrame,
        undefined,
        enableInterpolation
      )
    : null;
  const curRotX = activeTransform?.rotX ?? 0;
  const curRotY = activeTransform?.rotY ?? 0;
  const curRotZ = activeTransform?.rotZ ?? 0;
  const curScaleX = Number((activeTransform?.scaleX ?? 1).toFixed(2));
  const curScaleY = Number((activeTransform?.scaleY ?? 1).toFixed(2));
  const curScaleZ = Number((activeTransform?.scaleZ ?? 1).toFixed(2));
  const curVisible = activeTransform?.visible !== false;

  const parseTargetFrame = () => {
    const parsed = Math.max(0, Math.min(3600, Math.round(Number(targetFrameInput) || 0)));
    setTargetFrameInput(String(parsed));
    return parsed;
  };

  const renderRotationControls = (id: string, kind: 'actor' | 'prop' | 'tdt') => {
    const degX = wrapDeg(curRotX);
    const degY = wrapDeg(curRotY);
    const degZ = wrapDeg(curRotZ);

    return (
      <div className="studio-well p-1.5 flex flex-col gap-1.5 text-[10px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 font-bold text-emerald-200">
            <img
              src={assetUrl('3dmm/bmp/2ROT.BMP')}
              alt=""
              className="h-3.5 w-auto object-contain image-rendering-pixelated"
            />
            <span>Rotate 3D @ f{currentFrame}:</span>
          </div>
          <button
            type="button"
            onClick={() => onUpdateEntityRotation(id, kind, 0, 0, 0)}
            className="studio-btn px-1.5 py-0.5 flex items-center gap-0.5 text-amber-200"
            title="Reset all X/Y/Z angles to 0°"
          >
            <RotateCcw size={9} />
            <span>0°</span>
          </button>
        </div>

        {/* Y Axis (Turn Left / Right) */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onUpdateEntityRotation(id, kind, curRotX, curRotY - degToRad(45), curRotZ)}
            className="studio-btn px-1.5 py-0.5 font-bold shrink-0"
            title="Turn Left -45° (Y)"
          >
            ↺ -45°
          </button>
          <label className="flex-1 flex flex-col gap-0.5 min-w-0">
            <span className="text-purple-200 flex justify-between">
              <span>Turn L/R (Y)</span>
              <span className="font-mono text-amber-200">{degY}°</span>
            </span>
            <input
              type="range"
              min={-180}
              max={180}
              step={5}
              value={degY}
              onChange={(e) =>
                onUpdateEntityRotation(id, kind, curRotX, degToRad(Number(e.target.value)), curRotZ)
              }
              className="accent-emerald-400 h-1.5 cursor-pointer w-full min-w-0"
            />
          </label>
          <button
            type="button"
            onClick={() => onUpdateEntityRotation(id, kind, curRotX, curRotY + degToRad(45), curRotZ)}
            className="studio-btn px-1.5 py-0.5 font-bold shrink-0"
            title="Turn Right +45° (Y)"
          >
            ↻ +45°
          </button>
        </div>

        {/* X & Z Axes (Pitch forward/back & Roll sideways) */}
        <div className="grid grid-cols-2 gap-1.5">
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-purple-200 flex justify-between">
              <span>Tilt (X)</span>
              <span className="font-mono text-cyan-200">{degX}°</span>
            </span>
            <input
              type="range"
              min={-180}
              max={180}
              step={5}
              value={degX}
              onChange={(e) =>
                onUpdateEntityRotation(id, kind, degToRad(Number(e.target.value)), curRotY, curRotZ)
              }
              className="accent-amber-400 h-1.5 cursor-pointer w-full min-w-0"
            />
          </label>
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-purple-200 flex justify-between">
              <span>Roll (Z)</span>
              <span className="font-mono text-cyan-200">{degZ}°</span>
            </span>
            <input
              type="range"
              min={-180}
              max={180}
              step={5}
              value={degZ}
              onChange={(e) =>
                onUpdateEntityRotation(id, kind, curRotX, curRotY, degToRad(Number(e.target.value)))
              }
              className="accent-cyan-400 h-1.5 cursor-pointer w-full min-w-0"
            />
          </label>
        </div>
      </div>
    );
  };

  const renderColorControls = (id: string, kind: 'actor' | 'prop' | 'tdt') => (
    <div className="studio-well p-1.5 flex items-center justify-between gap-2 text-[10px]">
      <span className="font-bold text-amber-200 shrink-0">Color @ f{currentFrame}:</span>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={activeTransform?.color || '#ffffff'}
          onChange={(e) => onUpdateEntityColor(id, kind, e.target.value)}
          className="w-6 h-5 cursor-pointer bg-transparent border border-purple-400"
          title="Set interpolated keyframe color"
        />
        {activeTransform?.color && (
          <button
            type="button"
            onClick={() => onUpdateEntityColor(id, kind, undefined)}
            className="studio-btn px-1.5 py-0.5 text-[10px] text-rose-200"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );

  const renderStretchAndFrameControls = (
    id: string,
    kind: 'actor' | 'prop' | 'tdt',
    celsCount: number,
    curCel: number,
    isFreeze: boolean
  ) => (
    <>
      {/* Stretch / Squash (Width X/Z & Height Y) */}
      <div className="studio-well p-1.5 flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="font-bold text-amber-200">Stretch &amp; Squash @ f{currentFrame}:</span>
          <span className="font-mono text-cyan-200">
            {curScaleX.toFixed(2)}×{curScaleY.toFixed(2)}
          </span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1 text-[10px]">
          <button
            type="button"
            onClick={() => {
              void sound3DMM.playUiWav('GROW.WAV');
              onUpdateEntityScale(
                id,
                kind,
                Number((curScaleX * 0.78).toFixed(2)),
                Number((curScaleY * 1.28).toFixed(2)),
                Number((curScaleZ * 0.78).toFixed(2))
              );
            }}
            className="studio-btn py-0.5 font-bold"
            title="Stretch taller & thinner"
          >
            ↕ Stretch
          </button>
          <button
            type="button"
            onClick={() => {
              void sound3DMM.playUiWav('SQUASH.WAV');
              onUpdateEntityScale(
                id,
                kind,
                Number((curScaleX * 1.28).toFixed(2)),
                Number((curScaleY * 0.75).toFixed(2)),
                Number((curScaleZ * 1.28).toFixed(2))
              );
            }}
            className="studio-btn py-0.5 font-bold"
            title="Squash flatter & wider"
          >
            ↔ Squash
          </button>
          <button
            type="button"
            onClick={() => {
              void sound3DMM.playUiWav('GROW.WAV');
              onUpdateEntityScale(
                id,
                kind,
                Number((curScaleX * 1.18).toFixed(2)),
                Number((curScaleY * 1.18).toFixed(2)),
                Number((curScaleZ * 1.18).toFixed(2))
              );
            }}
            className="studio-btn py-0.5 font-bold"
            title="Grow bigger"
          >
            + Big
          </button>
          <button
            type="button"
            onClick={() => {
              void sound3DMM.playUiWav('SHRINK.WAV');
              onUpdateEntityScale(
                id,
                kind,
                Number((curScaleX * 0.84).toFixed(2)),
                Number((curScaleY * 0.84).toFixed(2)),
                Number((curScaleZ * 0.84).toFixed(2))
              );
            }}
            className="studio-btn py-0.5 font-bold"
            title="Shrink smaller"
          >
            - Small
          </button>
          <button
            type="button"
            onClick={() => onUpdateEntityScale(id, kind, 1, 1, 1)}
            className="studio-btn py-0.5 font-bold text-amber-200"
            title="Reset scale to 1.0x"
          >
            1×
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-[10px]">
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-purple-200">Width: {curScaleX.toFixed(2)}×</span>
            <input
              type="range"
              min={0.2}
              max={3.5}
              step={0.05}
              value={Math.min(3.5, Math.max(0.2, curScaleX))}
              onChange={(e) => {
                const w = Number(e.target.value);
                onUpdateEntityScale(id, kind, w, curScaleY, w);
              }}
              className="accent-amber-400 h-1.5 cursor-pointer w-full min-w-0"
            />
          </label>
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-purple-200">Height: {curScaleY.toFixed(2)}×</span>
            <input
              type="range"
              min={0.2}
              max={3.5}
              step={0.05}
              value={Math.min(3.5, Math.max(0.2, curScaleY))}
              onChange={(e) => {
                const h = Number(e.target.value);
                onUpdateEntityScale(id, kind, curScaleX, h, curScaleZ);
              }}
              className="accent-cyan-400 h-1.5 cursor-pointer w-full min-w-0"
            />
          </label>
        </div>
      </div>

      {/* Specific Frame Placement, Active Frame & Pose Cel Controls */}
      {renderFrameTimingControls(
        id,
        kind,
        selected3DEntity?.keyframes || {},
        celsCount,
        curCel,
        isFreeze
      )}
    </>
  );

  const renderFrameTimingControls = (
    id: string,
    kind: 'actor' | 'prop' | 'tdt',
    keyframesMap: Record<number, KeyframePosition>,
    celsCount = 0,
    curCel = 0,
    isFreeze = false
  ) => {
    const sortedKfFrames = Object.keys(keyframesMap)
      .map(Number)
      .sort((a, b) => a - b);

    return (
      <div className="studio-well p-1.5 flex flex-col gap-1.5 text-[10px]">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="font-bold text-cyan-200">Frame Timing:</span>
          <button
            type="button"
            onClick={() => onToggleEntityVisibility(id, kind, !curVisible)}
            className={`px-1.5 py-0.5 font-bold border ${
              curVisible
                ? 'bg-emerald-700 border-emerald-400 text-white'
                : 'bg-rose-800 border-rose-400 text-white'
            }`}
          >
            {curVisible ? 'Visible @ f' + currentFrame : 'Hidden @ f' + currentFrame}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="text-purple-200 shrink-0">Frame:</span>
          <input
            type="number"
            min={0}
            max={Math.max(1800, totalFrames + 300)}
            value={targetFrameInput}
            onChange={(e) => setTargetFrameInput(e.target.value)}
            className="studio-well px-1.5 py-0.5 w-14 text-[11px] font-mono text-amber-200 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => onSeekFrame(parseTargetFrame())}
            className="studio-btn px-1.5 py-0.5 font-bold"
            title="Jump playhead to this frame"
          >
            Go
          </button>
          <button
            type="button"
            onClick={() => onSetEntityFrame(id, kind, parseTargetFrame(), 'pin')}
            className="studio-btn px-1.5 py-0.5 font-bold text-amber-200"
            title="Pin current pose & position at this frame"
          >
            Pin @ f
          </button>
          <button
            type="button"
            onClick={() => onSetEntityFrame(id, kind, parseTargetFrame(), 'showFrom')}
            className="studio-btn px-1.5 py-0.5 font-bold text-cyan-200"
            title="Start appearing at this specific frame"
          >
            Enter @ f
          </button>
          <button
            type="button"
            onClick={() => onSetEntityFrame(id, kind, parseTargetFrame(), 'hideFrom')}
            className="studio-btn px-1.5 py-0.5 font-bold text-rose-200"
            title="Hide / exit stage starting at this specific frame"
          >
            Exit @ f
          </button>
        </div>

        {sortedKfFrames.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-purple-200 shrink-0">Keys:</span>
            {sortedKfFrames.map((fn) => {
              const kf = keyframesMap[fn];
              const isHiddenKey = kf?.visible === false;
              const isCurrent = fn === currentFrame;
              return (
                <div
                  key={fn}
                  className={`inline-flex items-center border ${
                    isCurrent
                      ? 'bg-amber-400 text-black font-bold border-white'
                      : isHiddenKey
                        ? 'bg-rose-950/80 text-rose-200 border-rose-700'
                        : 'studio-well text-cyan-200 border-purple-700'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSeekFrame(fn)}
                    className="px-1.5 py-0.5 font-mono"
                    title={
                      isHiddenKey
                        ? `Hidden at Frame ${fn} (click to jump)`
                        : `Visible keyframe at Frame ${fn} (click to jump)`
                    }
                  >
                    f{fn}
                    {isHiddenKey ? '🚫' : ''}
                  </button>
                  {sortedKfFrames.length > 1 && onRemoveEntityKeyframe && (
                    <button
                      type="button"
                      onClick={() => onRemoveEntityKeyframe(id, kind, fn)}
                      className={`px-1 py-0.5 font-bold hover:text-rose-400 ${
                        isCurrent ? 'text-black/75' : 'text-purple-300'
                      }`}
                      title={`Remove keyframe @ f${fn}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {kind !== 'tdt' && (
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="text-purple-200 shrink-0">
              Pose Cel ({celsCount > 0 ? celsCount : 'auto'}):
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  onUpdateEntityPoseCel(id, kind, Math.max(0, curCel - 1), true)
                }
                className="studio-btn px-1.5 py-0.5 font-bold"
              >
                -
              </button>
              <input
                type="number"
                min={0}
                max={999}
                value={curCel}
                onChange={(e) =>
                  onUpdateEntityPoseCel(
                    id,
                    kind,
                    Math.max(0, Number(e.target.value) || 0),
                    true
                  )
                }
                className="studio-well px-1 py-0.5 w-11 text-center font-mono text-white"
              />
              <button
                type="button"
                onClick={() => onUpdateEntityPoseCel(id, kind, curCel + 1, true)}
                className="studio-btn px-1.5 py-0.5 font-bold"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => onUpdateEntityPoseCel(id, kind, curCel, !isFreeze)}
                className={`px-1.5 py-0.5 font-bold border ${
                  isFreeze
                    ? 'bg-amber-400 text-black border-white'
                    : 'studio-btn text-cyan-200'
                }`}
                title="Lock pose at this exact cel or let animation advance"
              >
                {isFreeze ? 'Pinned' : 'Play'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const handleSubmit2dBox = () => {
    const clean = new2dText.trim();
    if (!clean) return;
    void sound3DMM.playUiWav('PSELECT.WAV');
    const bounds =
      new2dPreset === 'top'
        ? { left: 24, top: 18, right: 520, bottom: 96 }
        : new2dPreset === 'center'
          ? { left: 36, top: 90, right: 508, bottom: 216 }
          : new2dPreset === 'full'
            ? { left: 24, top: 20, right: 520, bottom: 286 }
            : { left: 24, top: 212, right: 520, bottom: 292 };

    onAddTextBox({
      text: clean,
      fontName: new2dFont,
      fontSize: new2dSize,
      color: new2dColor,
      bgColor: new2dUseBg ? new2dBgColor : undefined,
      bold: new2dBold,
      italic: new2dItalic,
      startFrame: currentFrame,
      endFrame: Math.max(currentFrame + 12, totalFrames),
      ...bounds,
      isScrolling: new2dScroll,
    });
  };

  return (
    <div className="bg-[#210f44] md:border-l-2 border-t-2 md:border-t-0 border-[#120624] p-2.5 w-full md:w-72 lg:w-80 flex-1 md:flex-none min-h-0 min-w-0 flex flex-col gap-2.5 text-xs text-slate-100 overflow-y-auto select-none">
      {/* Real 3DMM Talent Book, Props Cabinet & Words Maker */}
      <div className="studio-panel p-2 flex flex-col gap-2 shrink-0">
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => {
              void sound3DMM.playUiWav('DROPDN.WAV');
              setCatalogTab('actors');
            }}
            className={`flex-1 py-1 px-1.5 font-bold flex items-center justify-center gap-1 ${
              catalogTab === 'actors'
                ? 'bg-[#6b36c4] border-2 border-amber-300 text-white'
                : 'studio-btn text-purple-100'
            }`}
          >
            <img
              src={assetUrl('3dmm/bmp/2ACTR.BMP')}
              alt=""
              className="h-4 w-auto object-contain image-rendering-pixelated"
            />
            <span>Actors ({catalogActors.length})</span>
          </button>
          <button
            onClick={() => {
              void sound3DMM.playUiWav('DROPDN.WAV');
              setCatalogTab('props');
            }}
            className={`flex-1 py-1 px-1.5 font-bold flex items-center justify-center gap-1 ${
              catalogTab === 'props'
                ? 'bg-[#b45309] border-2 border-amber-300 text-white'
                : 'studio-btn text-amber-100'
            }`}
          >
            <img
              src={assetUrl('3dmm/bmp/2PROP.BMP')}
              alt=""
              className="h-4 w-auto object-contain image-rendering-pixelated"
            />
            <span>Props ({catalogProps.length})</span>
          </button>
          <button
            onClick={() => {
              void sound3DMM.playUiWav('DROPDN.WAV');
              setCatalogTab('words');
            }}
            className={`flex-1 py-1 px-1.5 font-bold flex items-center justify-center gap-1 ${
              catalogTab === 'words'
                ? 'bg-emerald-700 border-2 border-amber-300 text-white'
                : 'studio-btn text-emerald-100'
            }`}
          >
            <img
              src={assetUrl('3dmm/bmp/4FONT.BMP')}
              alt=""
              className="h-4 w-auto object-contain image-rendering-pixelated"
            />
            <span>Words</span>
          </button>
        </div>

        {catalogTab !== 'words' ? (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                catalogTab === 'actors'
                  ? 'Search all 45 3DMM actors...'
                  : 'Search all 21 3DMM props...'
              }
              className="studio-well px-2 py-1 text-[11px] text-white focus:outline-none"
            />

            <div className="grid grid-cols-3 gap-1.5 max-h-48 overflow-y-auto pr-1">
              {catalogTab === 'actors'
                ? filteredActors.map((actor) => (
                    <button
                      key={actor.tmplCno}
                      onClick={() => {
                        void sound3DMM.playUiWav('PSELECT.WAV');
                        onAddActor(actor);
                      }}
                      title={`Place ${actor.name} (At Rest)`}
                      className="studio-btn p-1 flex flex-col items-center gap-1"
                    >
                      {actor.thumbDataUrl ? (
                        <img
                          src={actor.thumbDataUrl}
                          alt={actor.name}
                          className="w-12 h-12 object-contain image-rendering-pixelated"
                        />
                      ) : (
                        <div className="w-12 h-12 bg-black/40" />
                      )}
                      <span className="text-[10px] font-bold text-purple-100 truncate w-full text-center">
                        {actor.name}
                      </span>
                    </button>
                  ))
                : filteredProps.map((prop) => (
                    <button
                      key={prop.tmplCno}
                      onClick={() => {
                        void sound3DMM.playUiWav('PSELECT.WAV');
                        onAddProp(prop);
                      }}
                      title={`Place ${prop.name}`}
                      className="studio-btn p-1 flex flex-col items-center gap-1"
                    >
                      {prop.thumbDataUrl ? (
                        <img
                          src={prop.thumbDataUrl}
                          alt={prop.name}
                          className="w-12 h-12 object-contain image-rendering-pixelated"
                        />
                      ) : (
                        <div className="w-12 h-12 bg-black/40" />
                      )}
                      <span className="text-[10px] font-bold text-amber-200 truncate w-full text-center">
                        {prop.name}
                      </span>
                    </button>
                  ))}
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {/* Sub-tabs: 3D Words vs 2D Onscreen Words */}
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setWordSubTab('3d')}
                className={`flex-1 py-1 font-bold text-[11px] ${
                  wordSubTab === '3d'
                    ? 'bg-[#6b36c4] border border-amber-300 text-white'
                    : 'studio-btn text-purple-200'
                }`}
              >
                🔤 3D Text (TDT)
              </button>
              <button
                type="button"
                onClick={() => setWordSubTab('2d')}
                className={`flex-1 py-1 font-bold text-[11px] flex items-center justify-center gap-1 ${
                  wordSubTab === '2d'
                    ? 'bg-emerald-700 border border-amber-300 text-white'
                    : 'studio-btn text-emerald-200'
                }`}
              >
                <img
                  src={assetUrl('3dmm/bmp/4SCRL.BMP')}
                  alt=""
                  className="h-3.5 w-auto object-contain image-rendering-pixelated"
                />
                <span>2D Onscreen Words</span>
              </button>
            </div>

            {wordSubTab === '3d' ? (
              <div className="flex flex-col gap-1.5 text-[11px]">
                <input
                  type="text"
                  value={new3dText}
                  onChange={(e) => setNew3dText(e.target.value)}
                  placeholder="Enter 3D text..."
                  className="studio-well px-2 py-1 text-white focus:outline-none font-bold"
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="flex flex-col gap-0.5 text-[10px]">
                    <span className="text-purple-200">3D Font:</span>
                    <select
                      value={new3dFont}
                      onChange={(e) => setNew3dFont(Number(e.target.value))}
                      className="studio-well px-1.5 py-1 text-white focus:outline-none"
                    >
                      {TDF_FONT_OPTIONS.map((f) => (
                        <option key={f.tdfCno} value={f.tdfCno}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5 text-[10px]">
                    <span className="text-purple-200">3D Shape:</span>
                    <select
                      value={new3dShape}
                      onChange={(e) => setNew3dShape(Number(e.target.value))}
                      className="studio-well px-1.5 py-1 text-white focus:outline-none"
                    >
                      {TDT_SHAPE_OPTIONS.map((s) => (
                        <option key={s.tdts} value={s.tdts}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {tdtSwatches.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[10px] text-purple-200 mr-1">Color:</span>
                    {tdtSwatches.map((sw) => (
                      <button
                        key={sw.mtrlCno}
                        type="button"
                        onClick={() => setNew3dMtrlCno(sw.mtrlCno)}
                        style={{ backgroundColor: sw.hex }}
                        className={`w-4 h-4 border ${
                          new3dMtrlCno === sw.mtrlCno
                            ? 'border-2 border-white scale-110'
                            : 'border-black/70'
                        }`}
                        title={`Material ${sw.mtrlCno}`}
                      />
                    ))}
                  </div>
                )}

                <label className="flex flex-col gap-0.5 text-[10px]">
                  <span className="text-purple-200">3D Word Animation:</span>
                  <select
                    value={new3dAction}
                    onChange={(e) => setNew3dAction(e.target.value)}
                    className="studio-well px-1.5 py-1 text-white focus:outline-none"
                  >
                    {TDT_ACTIONS.map((act) => (
                      <option key={act} value={act}>
                        {act}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  onClick={() => {
                    if (!new3dText.trim()) return;
                    void sound3DMM.playUiWav('PSELECT.WAV');
                    onAddTdtText({
                      text: new3dText.trim(),
                      tdfCno: new3dFont,
                      tdts: new3dShape,
                      mtrlCno: new3dMtrlCno,
                      action: new3dAction,
                    });
                  }}
                  className="bg-amber-600 hover:bg-amber-500 border-t-2 border-l-2 border-amber-300 border-r-2 border-b-2 border-r-amber-950 border-b-amber-950 py-1 font-bold text-white"
                >
                  + Add 3D Text @ f{currentFrame}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 text-[11px]">
                <textarea
                  rows={2}
                  value={new2dText}
                  onChange={(e) => setNew2dText(e.target.value)}
                  placeholder="Enter 2D onscreen words / credits..."
                  className="studio-well px-2 py-1 text-white focus:outline-none resize-y"
                />
                <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-purple-200">Font:</span>
                    <select
                      value={new2dFont}
                      onChange={(e) => setNew2dFont(e.target.value)}
                      className="studio-well px-1.5 py-1 text-white focus:outline-none"
                    >
                      {FONT_2D_OPTIONS.map((fn) => (
                        <option key={fn} value={fn}>
                          {fn}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-purple-200">Placement:</span>
                    <select
                      value={new2dPreset}
                      onChange={(e) =>
                        setNew2dPreset(e.target.value as 'bottom' | 'top' | 'center' | 'full')
                      }
                      className="studio-well px-1.5 py-1 text-white focus:outline-none"
                    >
                      <option value="bottom">Bottom Caption</option>
                      <option value="top">Top Title</option>
                      <option value="center">Center Card</option>
                      <option value="full">Full Screen Credits</option>
                    </select>
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-1 text-[10px]">
                  <label className="flex items-center gap-1">
                    <span className="text-purple-200">Size: {new2dSize}</span>
                    <input
                      type="range"
                      min={10}
                      max={48}
                      value={new2dSize}
                      onChange={(e) => setNew2dSize(Number(e.target.value))}
                      className="w-16 accent-amber-400 h-1.5"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-purple-200">Color:</span>
                    <input
                      type="color"
                      value={new2dColor}
                      onChange={(e) => setNew2dColor(e.target.value)}
                      className="w-5 h-4 cursor-pointer bg-transparent"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={new2dUseBg}
                      onChange={(e) => setNew2dUseBg(e.target.checked)}
                    />
                    <span className="text-purple-200">Box</span>
                    {new2dUseBg && (
                      <input
                        type="color"
                        value={new2dBgColor}
                        onChange={(e) => setNew2dBgColor(e.target.value)}
                        className="w-5 h-4 cursor-pointer bg-transparent"
                      />
                    )}
                  </label>
                </div>

                <div className="flex items-center gap-1.5 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setNew2dBold((v) => !v)}
                    className={`px-2 py-0.5 font-bold border ${
                      new2dBold ? 'bg-amber-400 text-black border-white' : 'studio-btn text-purple-100'
                    }`}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    onClick={() => setNew2dItalic((v) => !v)}
                    className={`px-2 py-0.5 italic border ${
                      new2dItalic ? 'bg-amber-400 text-black border-white' : 'studio-btn text-purple-100'
                    }`}
                  >
                    I
                  </button>
                  <label className="flex items-center gap-1 ml-auto text-cyan-200">
                    <input
                      type="checkbox"
                      checked={new2dScroll}
                      onChange={(e) => setNew2dScroll(e.target.checked)}
                    />
                    <span>Scrolling Credits</span>
                  </label>
                </div>

                <button
                  type="button"
                  onClick={handleSubmit2dBox}
                  className="bg-emerald-700 hover:bg-emerald-600 border-t-2 border-l-2 border-emerald-400 border-r-2 border-b-2 border-r-emerald-950 border-b-emerald-950 py-1 font-bold text-white"
                >
                  + Add 2D Words (f{currentFrame}–f{Math.max(currentFrame + 12, totalFrames)})
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selected Actor / Prop / 3D Word / 2D Words Inspector */}
      {selectedActor && activeActorAction ? (
        <div className="studio-panel p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between pb-1 border-b border-purple-700/70">
            <div className="flex items-center gap-1.5 font-bold text-amber-300">
              <img
                src={assetUrl('3dmm/bmp/2COST.BMP')}
                alt=""
                className="h-4 w-auto object-contain image-rendering-pixelated"
              />
              <span>Actor: {selectedActor.name}</span>
            </div>
            <span className="text-[10px] studio-well px-1.5 py-0.5 font-mono text-cyan-200">
              {Object.keys(selectedActor.keyframes).length}f
            </span>
          </div>

          {/* Per-frame ACTN Animation Switcher */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold text-purple-200">
              Action @ Frame {currentFrame} ({selectedTemplate?.actions.length || 1} real ACTNs):
            </label>
            <select
              value={activeActorAction.anid}
              onChange={(e) => {
                const anid = Number(e.target.value);
                const found = selectedTemplate?.actions.find((a) => a.anid === anid);
                void sound3DMM.playUiWav('SACT.WAV');
                onUpdateActorAction(
                  selectedActor.id,
                  anid,
                  found?.name || (anid === 0 ? 'At Rest' : `Action ${anid}`)
                );
              }}
              className="studio-well px-2 py-1 text-xs text-white focus:outline-none cursor-pointer w-full min-w-0"
            >
              {selectedTemplate && selectedTemplate.actions.length > 0 ? (
                selectedTemplate.actions.map((act) => (
                  <option key={act.anid} value={act.anid}>
                    {act.name} {act.anid === 0 ? '(Default)' : ''}
                  </option>
                ))
              ) : (
                <option value={activeActorAction.anid}>{activeActorAction.actionName}</option>
              )}
            </select>

            {selectedActor.actionKeyframes &&
              Object.keys(selectedActor.actionKeyframes).length > 1 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {Object.entries(selectedActor.actionKeyframes)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([fStr, val]) => {
                      const fn = Number(fStr);
                      return (
                        <button
                          key={fStr}
                          onClick={() => onSeekFrame(fn)}
                          className={`px-1.5 py-0.5 text-[10px] border ${
                            fn === activeActorAction.startFrame
                              ? 'bg-amber-400 text-black font-bold border-white'
                              : 'studio-well text-cyan-200 border-purple-700'
                          }`}
                        >
                          f{fn}: {val.actionName}
                        </button>
                      );
                    })}
                </div>
              )}
          </div>

          {/* Authentic Costume Set Cycle (GGCM) */}
          {selectedTemplate && selectedTemplate.costumeSets.some((s) => s.length > 1) && (
            <div className="flex flex-wrap gap-1">
              {selectedTemplate.costumeSets.map((cmids, ibset) =>
                cmids.length > 1 ? (
                  <button
                    key={ibset}
                    onClick={() => {
                      void sound3DMM.playUiWav('COSTUME.WAV');
                      const curList =
                        selectedActor.costumeCmids ||
                        selectedTemplate.costumeSets.map((s) => s[0] ?? 0);
                      const curVal = curList[ibset] ?? cmids[0];
                      const nextIdx = (cmids.indexOf(curVal) + 1) % cmids.length;
                      const updated = [...curList];
                      updated[ibset] = cmids[nextIdx];
                      onUpdateActorCostume(selectedActor.id, updated);
                    }}
                    className="studio-btn px-2 py-0.5 text-[10px] text-amber-200"
                  >
                    🎨 Costume {ibset + 1} ({cmids.length})
                  </button>
                ) : null
              )}
            </div>
          )}

          {renderRotationControls(selectedActor.id, 'actor')}
          {renderColorControls(selectedActor.id, 'actor')}

          {(() => {
            const actObj = selectedTemplate?.actionCache.get(activeActorAction.anid);
            const celsLen = actObj?.cels.length ?? 0;
            const curCel = activeActorAction.freeze
              ? activeActorAction.celOffset
              : activeActorAction.celOffset +
                Math.max(0, currentFrame - activeActorAction.startFrame);
            const dispCel =
              celsLen > 0 ? Math.max(0, Math.min(celsLen - 1, curCel)) : curCel;
            return renderStretchAndFrameControls(
              selectedActor.id,
              'actor',
              celsLen,
              dispCel,
              activeActorAction.freeze
            );
          })()}

          <button
            onClick={onToggleRecordingMovement}
            className={`py-1.5 px-2.5 font-bold text-xs flex items-center justify-center gap-2 ${
              isRecordingMovement
                ? 'bg-red-600 border-2 border-red-200 text-white'
                : 'studio-btn text-amber-300'
            }`}
          >
            <img
              src={assetUrl('3dmm/bmp/2RECD.BMP')}
              alt=""
              className="h-4 w-auto object-contain image-rendering-pixelated"
            />
            <span>{isRecordingMovement ? '● Recording (6 FPS)...' : 'Resume Last Movement'}</span>
          </button>

          <div className="flex items-center justify-between pt-1 border-t border-purple-800/70 text-[11px]">
            <button
              onClick={() => {
                void sound3DMM.playUiWav('SQUASH.WAV');
                onClearKeyframes(selectedActor.id, 'actor');
              }}
              className="text-purple-200 hover:text-white underline text-[10px]"
            >
              Reset Path
            </button>
            <button
              onClick={() => {
                void sound3DMM.playUiWav('REMACTR.WAV');
                onDeleteEntity(selectedActor.id, 'actor');
              }}
              className="text-rose-400 hover:text-rose-300 font-bold flex items-center gap-1"
            >
              <Trash2 size={12} />
              <span>Remove</span>
            </button>
          </div>
        </div>
      ) : selectedProp && activePropAction ? (
        <div className="studio-panel p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between pb-1 border-b border-amber-700/70">
            <div className="flex items-center gap-1.5 font-bold text-amber-300">
              <img
                src={assetUrl('3dmm/bmp/2PROP.BMP')}
                alt=""
                className="h-4 w-auto object-contain image-rendering-pixelated"
              />
              <span>Prop: {selectedProp.name}</span>
            </div>
            <span className="text-[10px] studio-well px-1.5 py-0.5 font-mono text-amber-200">
              {Object.keys(selectedProp.keyframes).length}f
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold text-amber-100">
              Prop Action @ Frame {currentFrame}:
            </label>
            {selectedTemplate && selectedTemplate.actions.length > 0 ? (
              <select
                value={
                  activePropAction.anid ??
                  selectedTemplate.actions.find(
                    (a) =>
                      a.name.trim().toLowerCase() ===
                      activePropAction.action.trim().toLowerCase()
                  )?.anid ??
                  selectedTemplate.actions[0].anid
                }
                onChange={(e) => {
                  const anid = Number(e.target.value);
                  const found = selectedTemplate.actions.find((a) => a.anid === anid);
                  const name = found?.name || (anid === 0 ? 'At Rest' : `Action ${anid}`);
                  const lower = name.toLowerCase();
                  if (lower.includes('grow')) void sound3DMM.playUiWav('GROW.WAV');
                  else if (lower.includes('shrink')) void sound3DMM.playUiWav('SHRINK.WAV');
                  else if (lower.includes('spin')) void sound3DMM.playUiWav('SPIN.WAV');
                  else void sound3DMM.playUiWav('SACT.WAV');
                  onUpdatePropAction(selectedProp.id, name, anid);
                }}
                className="studio-well px-2 py-1 text-xs text-white focus:outline-none cursor-pointer w-full min-w-0"
              >
                {selectedTemplate.actions.map((act) => (
                  <option key={act.anid} value={act.anid}>
                    {act.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={activePropAction.action}
                onChange={(e) => {
                  const act = e.target.value as PropAction;
                  if (act.includes('grow')) void sound3DMM.playUiWav('GROW.WAV');
                  else if (act.includes('shrink')) void sound3DMM.playUiWav('SHRINK.WAV');
                  else if (act.includes('spin')) void sound3DMM.playUiWav('SPIN.WAV');
                  else void sound3DMM.playUiWav('ACESORY.WAV');
                  onUpdatePropAction(selectedProp.id, act);
                }}
                className="studio-well px-2 py-1 text-xs text-white focus:outline-none cursor-pointer w-full min-w-0"
              >
                {PROP_ACTIONS.map((pAct) => (
                  <option key={pAct} value={pAct}>
                    {pAct}
                  </option>
                ))}
              </select>
            )}

            {selectedProp.actionKeyframes &&
              Object.keys(selectedProp.actionKeyframes).length > 1 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {Object.entries(selectedProp.actionKeyframes)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([fStr, val]) => {
                      const fn = Number(fStr);
                      return (
                        <button
                          key={fStr}
                          onClick={() => onSeekFrame(fn)}
                          className={`px-1.5 py-0.5 text-[10px] border ${
                            fn === activePropAction.startFrame
                              ? 'bg-amber-400 text-black font-bold border-white'
                              : 'studio-well text-amber-200 border-amber-700'
                          }`}
                        >
                          f{fn}: {val.action}
                        </button>
                      );
                    })}
                </div>
              )}
          </div>

          {/* Authentic Prop / Shape CMTL Costume Swatches (e.g. Cube, Sphere, Cylinder, Torus 17 colors) */}
          {selectedTemplate && selectedTemplate.costumeSets.some((s) => s.length > 1) && (
            <div className="studio-well p-1.5 flex flex-col gap-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="font-bold text-amber-200">Costume / Colors:</span>
              </div>
              {selectedTemplate.costumeSets.map((cmids, ibset) =>
                cmids.length > 1 ? (
                  <div key={ibset} className="flex flex-wrap gap-1 items-center">
                    {cmids.map((cmid) => {
                      const cmtl = selectedTemplate.cmtls.get(cmid);
                      const swatchHex = cmtl?.colors[0] || '#cccccc';
                      const curList =
                        selectedProp.costumeCmids ||
                        selectedTemplate.costumeSets.map((s) => s[0] ?? 0);
                      const isActive = (curList[ibset] ?? cmids[0]) === cmid;
                      return (
                        <button
                          key={cmid}
                          type="button"
                          onClick={() => {
                            void sound3DMM.playUiWav('COSTUME.WAV');
                            const updated = [...curList];
                            updated[ibset] = cmid;
                            onUpdatePropCostume(selectedProp.id, updated);
                            onUpdateEntityColor(selectedProp.id, 'prop', swatchHex);
                          }}
                          style={{ backgroundColor: swatchHex }}
                          className={`w-4 h-4 border ${
                            isActive ? 'border-2 border-white scale-110' : 'border-black/70'
                          }`}
                          title={`Costume #${cmid} (${swatchHex}) — interpolates cleanly!`}
                        />
                      );
                    })}
                  </div>
                ) : null
              )}
            </div>
          )}

          {renderRotationControls(selectedProp.id, 'prop')}
          {renderColorControls(selectedProp.id, 'prop')}

          {(() => {
            const targetAnid =
              activePropAction.anid ??
              selectedTemplate?.actions.find(
                (a) =>
                  a.name.trim().toLowerCase() === activePropAction.action.trim().toLowerCase()
              )?.anid ??
              0;
            const actObj = selectedTemplate?.actionCache.get(targetAnid);
            const celsLen = actObj?.cels.length ?? 0;
            const curCel = activePropAction.freeze
              ? activePropAction.celOffset
              : activePropAction.celOffset +
                Math.max(0, currentFrame - activePropAction.startFrame);
            const dispCel =
              celsLen > 0 ? Math.max(0, Math.min(celsLen - 1, curCel)) : curCel;
            return renderStretchAndFrameControls(
              selectedProp.id,
              'prop',
              celsLen,
              dispCel,
              activePropAction.freeze
            );
          })()}

          <button
            onClick={onToggleRecordingMovement}
            className={`py-1.5 px-2.5 font-bold text-xs flex items-center justify-center gap-2 ${
              isRecordingMovement
                ? 'bg-red-600 border-2 border-red-200 text-white'
                : 'studio-btn text-amber-300'
            }`}
          >
            <img
              src={assetUrl('3dmm/bmp/2RECD.BMP')}
              alt=""
              className="h-4 w-auto object-contain image-rendering-pixelated"
            />
            <span>{isRecordingMovement ? '● Recording (6 FPS)...' : 'Resume Last Movement'}</span>
          </button>

          <div className="flex items-center justify-between pt-1 border-t border-amber-800/70 text-[11px]">
            <button
              onClick={() => {
                void sound3DMM.playUiWav('SQUASH.WAV');
                onClearKeyframes(selectedProp.id, 'prop');
              }}
              className="text-amber-200 hover:text-white underline text-[10px]"
            >
              Reset Path
            </button>
            <button
              onClick={() => {
                void sound3DMM.playUiWav('REMACTR.WAV');
                onDeleteEntity(selectedProp.id, 'prop');
              }}
              className="text-rose-400 hover:text-rose-300 font-bold flex items-center gap-1"
            >
              <Trash2 size={12} />
              <span>Remove</span>
            </button>
          </div>
        </div>
      ) : selectedTdt && activeTdtAction ? (
        <div className="studio-panel p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between pb-1 border-b border-emerald-700/70">
            <span className="font-bold text-emerald-300 truncate">
              🔤 3D Word: {selectedTdt.text}
            </span>
            <span className="text-[10px] studio-well px-1.5 py-0.5 font-mono text-amber-200">
              {Object.keys(selectedTdt.keyframes).length}f
            </span>
          </div>

          <input
            type="text"
            value={selectedTdt.text}
            onChange={(e) => onUpdateTdtText(selectedTdt.id, { text: e.target.value })}
            className="studio-well px-2 py-1 text-xs font-bold text-white focus:outline-none"
          />

          {/* 3D Word Animation Switcher */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold text-emerald-200">
              3D Word Animation @ Frame {currentFrame}:
            </label>
            <select
              value={activeTdtAction.action}
              onChange={(e) => {
                const act = e.target.value;
                const low = act.toLowerCase();
                if (low.includes('grow') || low.includes('stretch')) void sound3DMM.playUiWav('GROW.WAV');
                else if (low.includes('hide')) void sound3DMM.playUiWav('SHRINK.WAV');
                else if (low.includes('spin') || low.includes('flip') || low.includes('cartwheel')) void sound3DMM.playUiWav('SPIN.WAV');
                else if (low.includes('walk') || low.includes('hop')) void sound3DMM.playUiWav('ACTSTEPF.WAV');
                else void sound3DMM.playUiWav('SACT.WAV');
                onUpdateTdtAction(selectedTdt.id, act);
              }}
              className="studio-well px-2 py-1 text-xs text-white focus:outline-none cursor-pointer w-full min-w-0"
            >
              {TDT_ACTIONS.map((act) => (
                <option key={act} value={act}>
                  {act}
                </option>
              ))}
            </select>

            {selectedTdt.actionKeyframes &&
              Object.keys(selectedTdt.actionKeyframes).length > 1 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {Object.entries(selectedTdt.actionKeyframes)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([fStr, val]) => {
                      const fn = Number(fStr);
                      return (
                        <button
                          key={fStr}
                          onClick={() => onSeekFrame(fn)}
                          className={`px-1.5 py-0.5 text-[10px] border ${
                            fn === activeTdtAction.startFrame
                              ? 'bg-amber-400 text-black font-bold border-white'
                              : 'studio-well text-emerald-200 border-emerald-700'
                          }`}
                        >
                          f{fn}: {val.action}
                        </button>
                      );
                    })}
                </div>
              )}
          </div>

          {/* Frame Timing directly accessible when selecting a 3D Word */}
          {renderFrameTimingControls(selectedTdt.id, 'tdt', selectedTdt.keyframes)}

          <div className="grid grid-cols-2 gap-1.5 text-[10px]">
            <label className="flex flex-col gap-0.5">
              <span className="text-purple-200">3D Font:</span>
              <select
                value={selectedTdt.tdfCno}
                onChange={(e) => onUpdateTdtText(selectedTdt.id, { tdfCno: Number(e.target.value) })}
                className="studio-well px-1.5 py-1 text-white focus:outline-none"
              >
                {TDF_FONT_OPTIONS.map((f) => (
                  <option key={f.tdfCno} value={f.tdfCno}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-purple-200">3D Shape:</span>
              <select
                value={selectedTdt.tdts}
                onChange={(e) => onUpdateTdtText(selectedTdt.id, { tdts: Number(e.target.value) })}
                className="studio-well px-1.5 py-1 text-white focus:outline-none"
              >
                {TDT_SHAPE_OPTIONS.map((s) => (
                  <option key={s.tdts} value={s.tdts}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {tdtSwatches.length > 0 && (
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-[10px] text-purple-200 mr-1">Material:</span>
              {tdtSwatches.map((sw) => (
                <button
                  key={sw.mtrlCno}
                  type="button"
                  onClick={() => {
                    onUpdateTdtText(selectedTdt.id, { mtrlCno: sw.mtrlCno });
                    onUpdateEntityColor(selectedTdt.id, 'tdt', sw.hex);
                  }}
                  style={{ backgroundColor: sw.hex }}
                  className={`w-4 h-4 border ${
                    selectedTdt.mtrlCno === sw.mtrlCno
                      ? 'border-2 border-white scale-110'
                      : 'border-black/70'
                  }`}
                  title={`Material ${sw.mtrlCno}`}
                />
              ))}
            </div>
          )}

          {renderRotationControls(selectedTdt.id, 'tdt')}
          {renderColorControls(selectedTdt.id, 'tdt')}
          {/* Stretch & Squash only for 3D Word since Frame Timing is shown prominently above */}
          <div className="studio-well p-1.5 flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-bold text-amber-200">
                Stretch &amp; Squash @ f{currentFrame}:
              </span>
              <span className="font-mono text-cyan-200">
                {curScaleX.toFixed(2)}×{curScaleY.toFixed(2)}
              </span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-1 text-[10px]">
              <button
                type="button"
                onClick={() => {
                  void sound3DMM.playUiWav('GROW.WAV');
                  onUpdateEntityScale(
                    selectedTdt.id,
                    'tdt',
                    Number((curScaleX * 0.78).toFixed(2)),
                    Number((curScaleY * 1.28).toFixed(2)),
                    Number((curScaleZ * 0.78).toFixed(2))
                  );
                }}
                className="studio-btn py-0.5 font-bold"
                title="Stretch taller & thinner"
              >
                ↕ Stretch
              </button>
              <button
                type="button"
                onClick={() => {
                  void sound3DMM.playUiWav('SQUASH.WAV');
                  onUpdateEntityScale(
                    selectedTdt.id,
                    'tdt',
                    Number((curScaleX * 1.28).toFixed(2)),
                    Number((curScaleY * 0.75).toFixed(2)),
                    Number((curScaleZ * 1.28).toFixed(2))
                  );
                }}
                className="studio-btn py-0.5 font-bold"
                title="Squash flatter & wider"
              >
                ↔ Squash
              </button>
              <button
                type="button"
                onClick={() => {
                  void sound3DMM.playUiWav('GROW.WAV');
                  onUpdateEntityScale(
                    selectedTdt.id,
                    'tdt',
                    Number((curScaleX * 1.18).toFixed(2)),
                    Number((curScaleY * 1.18).toFixed(2)),
                    Number((curScaleZ * 1.18).toFixed(2))
                  );
                }}
                className="studio-btn py-0.5 font-bold"
                title="Grow bigger"
              >
                + Big
              </button>
              <button
                type="button"
                onClick={() => {
                  void sound3DMM.playUiWav('SHRINK.WAV');
                  onUpdateEntityScale(
                    selectedTdt.id,
                    'tdt',
                    Number((curScaleX * 0.84).toFixed(2)),
                    Number((curScaleY * 0.84).toFixed(2)),
                    Number((curScaleZ * 0.84).toFixed(2))
                  );
                }}
                className="studio-btn py-0.5 font-bold"
                title="Shrink smaller"
              >
                - Small
              </button>
              <button
                type="button"
                onClick={() => onUpdateEntityScale(selectedTdt.id, 'tdt', 1, 1, 1)}
                className="studio-btn py-0.5 font-bold text-amber-200"
                title="Reset scale to 1.0x"
              >
                1×
              </button>
            </div>
          </div>

          <button
            onClick={onToggleRecordingMovement}
            className={`py-1.5 px-2.5 font-bold text-xs flex items-center justify-center gap-2 ${
              isRecordingMovement
                ? 'bg-red-600 border-2 border-red-200 text-white'
                : 'studio-btn text-amber-300'
            }`}
          >
            <img
              src={assetUrl('3dmm/bmp/2RECD.BMP')}
              alt=""
              className="h-4 w-auto object-contain image-rendering-pixelated"
            />
            <span>{isRecordingMovement ? '● Recording (6 FPS)...' : 'Resume Last Movement'}</span>
          </button>

          <div className="flex items-center justify-between pt-1 border-t border-emerald-800/70 text-[11px]">
            <button
              onClick={() => {
                void sound3DMM.playUiWav('SQUASH.WAV');
                onClearKeyframes(selectedTdt.id, 'tdt');
              }}
              className="text-emerald-200 hover:text-white underline text-[10px]"
            >
              Reset Path
            </button>
            <button
              onClick={() => {
                void sound3DMM.playUiWav('REMACTR.WAV');
                onDeleteEntity(selectedTdt.id, 'tdt');
              }}
              className="text-rose-400 hover:text-rose-300 font-bold flex items-center gap-1"
            >
              <Trash2 size={12} />
              <span>Remove</span>
            </button>
          </div>
        </div>
      ) : selectedTextBox ? (
        <div className="studio-panel p-2.5 flex flex-col gap-2 text-[11px]">
          <div className="flex items-center justify-between pb-1 border-b border-emerald-700/70">
            <span className="font-bold text-emerald-300 truncate">
              💬 2D Words Box
            </span>
            <span className="text-[10px] font-mono text-cyan-200">
              f{selectedTextBox.startFrame}–f{selectedTextBox.endFrame}
            </span>
          </div>

          <textarea
            rows={2}
            value={selectedTextBox.text}
            onChange={(e) =>
              onUpdateTextBox(selectedTextBox.id, { text: e.target.value, runs: undefined })
            }
            className="studio-well px-2 py-1 text-white focus:outline-none resize-y"
          />

          <div className="grid grid-cols-2 gap-1.5 text-[10px]">
            <label className="flex flex-col gap-0.5">
              <span className="text-purple-200">Font:</span>
              <select
                value={selectedTextBox.fontName}
                onChange={(e) =>
                  onUpdateTextBox(selectedTextBox.id, {
                    fontName: e.target.value,
                    runs: undefined,
                  })
                }
                className="studio-well px-1.5 py-1 text-white focus:outline-none"
              >
                {Array.from(
                  new Set([
                    ...FONT_2D_OPTIONS,
                    ...(selectedTextBox.fontName ? [selectedTextBox.fontName] : []),
                  ])
                ).map((fn) => (
                  <option key={fn} value={fn}>
                    {fn}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-purple-200">Size: {selectedTextBox.fontSize ?? 14}</span>
              <input
                type="range"
                min={8}
                max={64}
                value={selectedTextBox.fontSize ?? 14}
                onChange={(e) =>
                  onUpdateTextBox(selectedTextBox.id, {
                    fontSize: Number(e.target.value),
                    runs: undefined,
                  })
                }
                className="accent-amber-400 h-1.5 mt-1"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1 text-[10px]">
            <label className="flex items-center gap-1">
              <span className="text-purple-200">Color:</span>
              <input
                type="color"
                value={selectedTextBox.color || '#0b0b0b'}
                onChange={(e) =>
                  onUpdateTextBox(selectedTextBox.id, { color: e.target.value, runs: undefined })
                }
                className="w-5 h-4 cursor-pointer bg-transparent"
              />
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={Boolean(selectedTextBox.bgColor)}
                onChange={(e) =>
                  onUpdateTextBox(selectedTextBox.id, {
                    bgColor: e.target.checked ? '#1b0e36' : undefined,
                  })
                }
              />
              <span className="text-purple-200">Box</span>
              {selectedTextBox.bgColor && (
                <input
                  type="color"
                  value={selectedTextBox.bgColor}
                  onChange={(e) =>
                    onUpdateTextBox(selectedTextBox.id, { bgColor: e.target.value })
                  }
                  className="w-5 h-4 cursor-pointer bg-transparent"
                />
              )}
            </label>
            <button
              type="button"
              onClick={() =>
                onUpdateTextBox(selectedTextBox.id, {
                  bold: !selectedTextBox.bold,
                  runs: undefined,
                })
              }
              className={`px-1.5 py-0.5 font-bold border ${
                selectedTextBox.bold
                  ? 'bg-amber-400 text-black border-white'
                  : 'studio-btn text-purple-100'
              }`}
            >
              B
            </button>
            <button
              type="button"
              onClick={() =>
                onUpdateTextBox(selectedTextBox.id, {
                  italic: !selectedTextBox.italic,
                  runs: undefined,
                })
              }
              className={`px-1.5 py-0.5 italic border ${
                selectedTextBox.italic
                  ? 'bg-amber-400 text-black border-white'
                  : 'studio-btn text-purple-100'
              }`}
            >
              I
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5 text-[10px]">
            <label className="flex flex-col gap-0.5">
              <span className="text-purple-200">Start Frame:</span>
              <input
                type="number"
                min={0}
                max={totalFrames}
                value={selectedTextBox.startFrame}
                onChange={(e) =>
                  onUpdateTextBox(selectedTextBox.id, {
                    startFrame: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="studio-well px-1.5 py-0.5 text-white font-mono"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-purple-200">End Frame:</span>
              <input
                type="number"
                min={0}
                max={Math.max(1800, totalFrames + 300)}
                value={selectedTextBox.endFrame}
                onChange={(e) =>
                  onUpdateTextBox(selectedTextBox.id, {
                    endFrame: Math.max(selectedTextBox.startFrame, Number(e.target.value) || 0),
                  })
                }
                className="studio-well px-1.5 py-0.5 text-white font-mono"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-1.5 text-[10px]">
            <label className="flex flex-col gap-0.5 min-w-0">
              <span className="text-purple-200">X Position: {selectedTextBox.left}</span>
              <input
                type="range"
                min={0}
                max={460}
                value={selectedTextBox.left}
                onChange={(e) => {
                  const left = Number(e.target.value);
                  const w = Math.max(80, selectedTextBox.right - selectedTextBox.left);
                  onUpdateTextBox(selectedTextBox.id, {
                    left,
                    right: Math.min(544, left + w),
                  });
                }}
                className="accent-cyan-400 h-1.5 w-full min-w-0"
              />
            </label>
            <label className="flex flex-col gap-0.5 min-w-0">
              <span className="text-purple-200">Y Position: {selectedTextBox.top}</span>
              <input
                type="range"
                min={0}
                max={270}
                value={selectedTextBox.top}
                onChange={(e) => {
                  const top = Number(e.target.value);
                  const h = Math.max(36, selectedTextBox.bottom - selectedTextBox.top);
                  onUpdateTextBox(selectedTextBox.id, {
                    top,
                    bottom: Math.min(306, top + h),
                  });
                }}
                className="accent-amber-400 h-1.5 w-full min-w-0"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-emerald-800/70">
            <div className="flex items-center gap-1 text-[10px]">
              <button
                type="button"
                onClick={() =>
                  onUpdateTextBox(selectedTextBox.id, { isScrolling: false })
                }
                className={`px-2 py-0.5 font-bold border ${
                  !selectedTextBox.isScrolling
                    ? 'bg-cyan-400 text-slate-950 border-white'
                    : 'studio-btn text-purple-100'
                }`}
              >
                Stationary
              </button>
              <button
                type="button"
                onClick={() =>
                  onUpdateTextBox(selectedTextBox.id, { isScrolling: true })
                }
                className={`px-2 py-0.5 font-bold border ${
                  selectedTextBox.isScrolling
                    ? 'bg-cyan-400 text-slate-950 border-white'
                    : 'studio-btn text-purple-100'
                }`}
              >
                Credits
              </button>
            </div>
            <button
              onClick={() => {
                void sound3DMM.playUiWav('REMACTR.WAV');
                onDeleteEntity(selectedTextBox.id, 'tbox');
              }}
              className="text-rose-400 hover:text-rose-300 font-bold flex items-center gap-1"
            >
              <Trash2 size={12} />
              <span>Remove</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="studio-panel p-2.5 text-center text-purple-200 text-[11px]">
          Tap any actor, prop, or 3D/2D word to rotate (X/Y/Z), color, animate, or drag.
        </div>
      )}

      {/* Scene Cast, Props & Words List */}
      <div className="studio-panel p-2 flex flex-col gap-1 flex-1 min-h-[100px]">
        <div className="flex items-center justify-between pb-1 border-b border-purple-700/60">
          <span className="font-bold text-[11px] text-amber-200">On Stage:</span>
          <span className="text-[10px] text-amber-300 font-mono">
            {actors.length + props.length + tdtTexts.length + textBoxes.length} items
          </span>
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto max-h-40 pr-1">
          {actors.map((actor) => {
            const actNow = resolveActorActionAtFrame(actor, currentFrame);
            return (
              <button
                key={actor.id}
                onClick={() => onSelectEntity(actor.id, 'actor')}
                className={`flex items-center justify-between px-2 py-1 text-left text-xs ${
                  selectedEntityId === actor.id
                    ? 'bg-[#6b36c4] border border-amber-300 text-white font-bold'
                    : 'studio-well text-purple-100 hover:brightness-110'
                }`}
              >
                <span className="truncate">
                  🎭 {actor.name} ({actNow.actionName})
                </span>
                <span className="text-[10px] font-mono opacity-80 ml-1">
                  {Object.keys(actor.keyframes).length}f
                </span>
              </button>
            );
          })}
          {props.map((prop) => {
            const actNow = resolvePropActionAtFrame(prop, currentFrame);
            return (
              <button
                key={prop.id}
                onClick={() => onSelectEntity(prop.id, 'prop')}
                className={`flex items-center justify-between px-2 py-1 text-left text-xs ${
                  selectedEntityId === prop.id
                    ? 'bg-amber-700 border border-amber-200 text-white font-bold'
                    : 'studio-well text-amber-100 hover:brightness-110'
                }`}
              >
                <span className="truncate">
                  📦 {prop.name} ({actNow.action})
                </span>
                <span className="text-[10px] font-mono opacity-80 ml-1">
                  {Object.keys(prop.keyframes).length}f
                </span>
              </button>
            );
          })}
          {tdtTexts.map((tdt) => {
            const actNow = resolveTdtActionAtFrame(tdt, currentFrame);
            return (
              <button
                key={tdt.id}
                onClick={() => onSelectEntity(tdt.id, 'tdt')}
                className={`flex items-center justify-between px-2 py-1 text-left text-xs ${
                  selectedEntityId === tdt.id
                    ? 'bg-emerald-700 border border-amber-200 text-white font-bold'
                    : 'studio-well text-emerald-100 hover:brightness-110'
                }`}
              >
                <span className="truncate">
                  🔤 3D: {tdt.text} ({actNow.action})
                </span>
                <span className="text-[10px] font-mono opacity-80 ml-1">
                  {Object.keys(tdt.keyframes).length}f
                </span>
              </button>
            );
          })}
          {textBoxes.map((tb) => (
            <button
              key={tb.id}
              onClick={() => onSelectEntity(tb.id, 'tbox')}
              className={`flex items-center justify-between px-2 py-1 text-left text-xs ${
                selectedEntityId === tb.id
                  ? 'bg-cyan-700 border border-amber-200 text-white font-bold'
                  : 'studio-well text-cyan-100 hover:brightness-110'
              }`}
            >
              <span className="truncate">💬 2D: {tb.text}</span>
              <span className="text-[10px] font-mono opacity-80 ml-1">
                f{tb.startFrame}–{tb.endFrame}
              </span>
            </button>
          ))}
          {actors.length === 0 &&
            props.length === 0 &&
            tdtTexts.length === 0 &&
            textBoxes.length === 0 && (
              <div className="text-[11px] text-purple-300 italic text-center py-2">
                Empty stage — pick an actor, prop, or word above!
              </div>
            )}
        </div>
      </div>
    </div>
  );
};

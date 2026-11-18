import React, { useEffect, useState } from 'react';
import { ActorEntity, PropAction, PropEntity } from '../types/movie';
import {
  CatalogActorItem,
  CatalogPropItem,
  loadTemplate,
  ParsedTemplate,
} from '../services/threeDmmEngine';
import {
  resolveActorActionAtFrame,
  resolveInterpolatedKeyframe,
  resolvePropActionAtFrame,
} from './Viewport3D';
import { sound3DMM } from '../services/soundLibrary';
import { Trash2 } from 'lucide-react';

interface ActorPropPanelProps {
  currentFrame: number;
  totalFrames: number;
  onSeekFrame: (frame: number) => void;
  catalogActors: CatalogActorItem[];
  catalogProps: CatalogPropItem[];
  actors: ActorEntity[];
  props: PropEntity[];
  selectedEntityId: string | null;
  selectedEntityType: 'actor' | 'prop' | null;
  onSelectEntity: (id: string | null, type: 'actor' | 'prop' | null) => void;
  onAddActor: (item: CatalogActorItem) => void;
  onAddProp: (item: CatalogPropItem) => void;
  onUpdateActorAction: (id: string, anid: number, actionName: string) => void;
  onUpdateActorCostume: (id: string, costumeCmids: number[]) => void;
  onUpdatePropAction: (id: string, action: PropAction) => void;
  onUpdateEntityScale: (
    id: string,
    type: 'actor' | 'prop',
    scaleX: number,
    scaleY: number,
    scaleZ: number
  ) => void;
  onSetEntityFrame: (
    id: string,
    type: 'actor' | 'prop',
    targetFrame: number,
    mode: 'pin' | 'showFrom'
  ) => void;
  onToggleEntityVisibility: (id: string, type: 'actor' | 'prop', visible: boolean) => void;
  onUpdateEntityPoseCel: (
    id: string,
    type: 'actor' | 'prop',
    celOffset: number,
    freeze: boolean
  ) => void;
  isRecordingMovement: boolean;
  onToggleRecordingMovement: () => void;
  onClearKeyframes: (id: string, type: 'actor' | 'prop') => void;
  onDeleteEntity: (id: string, type: 'actor' | 'prop') => void;
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

export const ActorPropPanel: React.FC<ActorPropPanelProps> = ({
  currentFrame,
  totalFrames,
  onSeekFrame,
  catalogActors,
  catalogProps,
  actors,
  props,
  selectedEntityId,
  onSelectEntity,
  onAddActor,
  onAddProp,
  onUpdateActorAction,
  onUpdateActorCostume,
  onUpdatePropAction,
  onUpdateEntityScale,
  onSetEntityFrame,
  onToggleEntityVisibility,
  onUpdateEntityPoseCel,
  isRecordingMovement,
  onToggleRecordingMovement,
  onClearKeyframes,
  onDeleteEntity,
}) => {
  const [catalogTab, setCatalogTab] = useState<'actors' | 'props'>('actors');
  const [search, setSearch] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<ParsedTemplate | null>(null);
  const [targetFrameInput, setTargetFrameInput] = useState<string>('0');

  const selectedActor = actors.find((a) => a.id === selectedEntityId);
  const selectedProp = props.find((p) => p.id === selectedEntityId);

  useEffect(() => {
    setTargetFrameInput(String(currentFrame));
  }, [currentFrame, selectedEntityId]);

  useEffect(() => {
    if (!selectedActor) {
      setSelectedTemplate(null);
      return;
    }
    let cancelled = false;
    loadTemplate(selectedActor.tmplCno)
      .then((t) => {
        if (!cancelled) setSelectedTemplate(t);
      })
      .catch(() => {
        if (!cancelled) setSelectedTemplate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedActor?.tmplCno]);

  const query = search.trim().toLowerCase();
  const filteredActors = catalogActors.filter((a) => a.name.toLowerCase().includes(query));
  const filteredProps = catalogProps.filter((p) => p.name.toLowerCase().includes(query));

  const activeActorAction = selectedActor
    ? resolveActorActionAtFrame(selectedActor, currentFrame)
    : null;
  const activePropAction = selectedProp
    ? resolvePropActionAtFrame(selectedProp, currentFrame)
    : null;
  const selectedEntity = selectedActor || selectedProp;
  const activeTransform = selectedEntity
    ? resolveInterpolatedKeyframe(selectedEntity.keyframes, currentFrame)
    : null;
  const curScaleX = Number((activeTransform?.scaleX ?? 1).toFixed(2));
  const curScaleY = Number((activeTransform?.scaleY ?? 1).toFixed(2));
  const curScaleZ = Number((activeTransform?.scaleZ ?? 1).toFixed(2));
  const curVisible = activeTransform?.visible !== false;

  const parseTargetFrame = () => {
    const parsed = Math.max(0, Math.min(3600, Math.round(Number(targetFrameInput) || 0)));
    setTargetFrameInput(String(parsed));
    return parsed;
  };

  const renderStretchAndFrameControls = (id: string, kind: 'actor' | 'prop', celsCount: number, curCel: number, isFreeze: boolean) => (
    <>
      {/* Stretch / Squash (Width X/Z & Height Y) */}
      <div className="studio-well p-1.5 flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="font-bold text-amber-200">Stretch &amp; Squash @ f{currentFrame}:</span>
          <span className="font-mono text-cyan-200">
            {curScaleX.toFixed(2)}×{curScaleY.toFixed(2)}
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1 text-[10px]">
          <button
            type="button"
            onClick={() => {
              void sound3DMM.playUiWav('GROW.WAV');
              onUpdateEntityScale(id, kind, Number((curScaleX * 0.78).toFixed(2)), Number((curScaleY * 1.28).toFixed(2)), Number((curScaleZ * 0.78).toFixed(2)));
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
              onUpdateEntityScale(id, kind, Number((curScaleX * 1.28).toFixed(2)), Number((curScaleY * 0.75).toFixed(2)), Number((curScaleZ * 1.28).toFixed(2)));
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
              onUpdateEntityScale(id, kind, Number((curScaleX * 1.18).toFixed(2)), Number((curScaleY * 1.18).toFixed(2)), Number((curScaleZ * 1.18).toFixed(2)));
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
              onUpdateEntityScale(id, kind, Number((curScaleX * 0.84).toFixed(2)), Number((curScaleY * 0.84).toFixed(2)), Number((curScaleZ * 0.84).toFixed(2)));
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
          <label className="flex flex-col gap-0.5">
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
              className="accent-amber-400 h-1.5 cursor-pointer"
            />
          </label>
          <label className="flex flex-col gap-0.5">
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
              className="accent-cyan-400 h-1.5 cursor-pointer"
            />
          </label>
        </div>
      </div>

      {/* Specific Frame Placement, Active Frame & Pose Cel Controls */}
      <div className="studio-well p-1.5 flex flex-col gap-1.5 text-[10px]">
        <div className="flex items-center justify-between gap-1">
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

        <div className="flex items-center gap-1">
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
        </div>

        <div className="flex items-center justify-between gap-1">
          <span className="text-purple-200 shrink-0">Pose Cel ({celsCount > 0 ? celsCount : 'auto'}):</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onUpdateEntityPoseCel(id, kind, Math.max(0, curCel - 1), true)}
              className="studio-btn px-1.5 py-0.5 font-bold"
            >
              -
            </button>
            <input
              type="number"
              min={0}
              max={999}
              value={curCel}
              onChange={(e) => onUpdateEntityPoseCel(id, kind, Math.max(0, Number(e.target.value) || 0), true)}
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
      </div>
    </>
  );

  return (
    <div className="bg-[#210f44] border-l-2 border-[#120624] p-2.5 w-full md:w-80 shrink-0 flex flex-col gap-2.5 text-xs text-slate-100 overflow-y-auto select-none">
      {/* Real 3DMM Talent Book & Props Cabinet */}
      <div className="studio-panel p-2 flex flex-col gap-2">
        <div className="flex gap-1">
          <button
            onClick={() => {
              void sound3DMM.playUiWav('DROPDN.WAV');
              setCatalogTab('actors');
            }}
            className={`flex-1 py-1 px-2 font-bold flex items-center justify-center gap-1.5 ${
              catalogTab === 'actors'
                ? 'bg-[#6b36c4] border-2 border-amber-300 text-white'
                : 'studio-btn text-purple-100'
            }`}
          >
            <img
              src="/3dmm/bmp/2ACTR.BMP"
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
            className={`flex-1 py-1 px-2 font-bold flex items-center justify-center gap-1.5 ${
              catalogTab === 'props'
                ? 'bg-[#b45309] border-2 border-amber-300 text-white'
                : 'studio-btn text-amber-100'
            }`}
          >
            <img
              src="/3dmm/bmp/2PROP.BMP"
              alt=""
              className="h-4 w-auto object-contain image-rendering-pixelated"
            />
            <span>Props ({catalogProps.length})</span>
          </button>
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            catalogTab === 'actors' ? 'Search all 45 3DMM actors...' : 'Search all 21 3DMM props...'
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
      </div>

      {/* Selected Actor or Prop Inspector */}
      {selectedActor && activeActorAction ? (
        <div className="studio-panel p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between pb-1 border-b border-purple-700/70">
            <div className="flex items-center gap-1.5 font-bold text-amber-300">
              <img
                src="/3dmm/bmp/2COST.BMP"
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
              className="studio-well px-2 py-1 text-xs text-white focus:outline-none cursor-pointer"
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

          {(() => {
            const actObj = selectedTemplate?.actionCache.get(activeActorAction.anid);
            const celsLen = actObj?.cels.length ?? 0;
            const curCel = activeActorAction.freeze
              ? activeActorAction.celOffset
              : activeActorAction.celOffset + Math.max(0, currentFrame - activeActorAction.startFrame);
            const dispCel = celsLen > 0 ? curCel % celsLen : curCel;
            return renderStretchAndFrameControls(
              selectedActor.id,
              'actor',
              celsLen,
              dispCel,
              activeActorAction.freeze
            );
          })()}

          {/* Resume Last Movement */}
          <button
            onClick={onToggleRecordingMovement}
            className={`py-1.5 px-2.5 font-bold text-xs flex items-center justify-center gap-2 ${
              isRecordingMovement
                ? 'bg-red-600 border-2 border-red-200 text-white'
                : 'studio-btn text-amber-300'
            }`}
          >
            <img
              src="/3dmm/bmp/2RECD.BMP"
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
                src="/3dmm/bmp/2ROT.BMP"
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
              className="studio-well px-2 py-1 text-xs text-white focus:outline-none cursor-pointer"
            >
              {PROP_ACTIONS.map((pAct) => (
                <option key={pAct} value={pAct}>
                  {pAct}
                </option>
              ))}
            </select>

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

          {(() => {
            const curCel = activePropAction.freeze
              ? activePropAction.celOffset
              : activePropAction.celOffset + Math.max(0, currentFrame - activePropAction.startFrame);
            return renderStretchAndFrameControls(
              selectedProp.id,
              'prop',
              0,
              curCel,
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
              src="/3dmm/bmp/2RECD.BMP"
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
      ) : (
        <div className="studio-panel p-2.5 text-center text-purple-200 text-[11px]">
          Tap any actor or prop on stage or in Cast below to animate or drag.
        </div>
      )}

      {/* Scene Cast & Props List */}
      <div className="studio-panel p-2 flex flex-col gap-1 flex-1 min-h-[100px]">
        <div className="flex items-center justify-between pb-1 border-b border-purple-700/60">
          <span className="font-bold text-[11px] text-amber-200">On Stage:</span>
          <span className="text-[10px] text-amber-300 font-mono">
            {actors.length + props.length} items
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
          {actors.length === 0 && props.length === 0 && (
            <div className="text-[11px] text-purple-300 italic text-center py-2">
              Empty stage — pick an actor or prop above!
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

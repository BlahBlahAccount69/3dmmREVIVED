import React, { useState } from 'react';
import { Scene } from '../types/movie';
import { CatalogSceneItem } from '../services/threeDmmEngine';
import { sound3DMM } from '../services/soundLibrary';
import { Plus } from 'lucide-react';
import { assetUrl } from '../utils/assetUrl';

interface SceneBarProps {
  scenes: Scene[];
  catalogScenes: CatalogSceneItem[];
  currentSceneIndex: number;
  onSelectScene: (index: number) => void;
  onAddOrOverwriteScene: (chosen: CatalogSceneItem) => void;
  onUpdateCurrentScene: (chosen: CatalogSceneItem) => void;
}

export const SceneBar: React.FC<SceneBarProps> = ({
  scenes,
  catalogScenes,
  currentSceneIndex,
  onSelectScene,
  onAddOrOverwriteScene,
  onUpdateCurrentScene,
}) => {
  const [showAddModal, setShowAddModal] = useState(false);

  const currentScene = scenes[currentSceneIndex];
  const hasEntities =
    currentScene && (currentScene.actors.length > 0 || currentScene.props.length > 0);

  return (
    <div className="bg-[#2a1453] border-b-2 border-[#120624] px-2.5 py-1 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-100 select-none">
      {/* Scenes Sequence Strip */}
      <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 max-w-full">
        <div className="flex items-center gap-1.5 px-2 py-0.5 studio-well text-amber-300 font-bold text-[11px] shrink-0">
          <img
            src={assetUrl('3dmm/bmp/1SCEN.BMP')}
            alt="3DMM Scenes"
            className="h-5 w-auto object-contain inline-block image-rendering-pixelated"
          />
          <span>Scenes:</span>
        </div>

        {scenes.map((scene, idx) => {
          const isActive = idx === currentSceneIndex;
          const count = scene.actors.length + scene.props.length;

          return (
            <button
              key={scene.id}
              onClick={() => {
                void sound3DMM.playUiWav('DROPDN.WAV');
                onSelectScene(idx);
              }}
              className={`px-2.5 py-0.5 text-xs flex items-center gap-1.5 shrink-0 ${
                isActive
                  ? 'bg-[#6535b8] text-amber-200 font-bold border-2 border-amber-300 shadow'
                  : 'studio-btn text-purple-100'
              }`}
            >
              <span>
                {idx + 1}. {scene.sceneName}
              </span>
              <span className="px-1 bg-black/50 text-[10px] text-amber-300 font-mono">
                {count}
              </span>
            </button>
          );
        })}

        <button
          onClick={() => {
            void sound3DMM.playUiWav('ADDFRAME.WAV');
            setShowAddModal(true);
          }}
          className="px-2.5 py-0.5 bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs flex items-center gap-1 border-t-2 border-l-2 border-emerald-400 border-r-2 border-b-2 border-r-emerald-950 border-b-emerald-950 shadow shrink-0"
          title="Add a new scene (Overwrites current scene if empty)"
        >
          <Plus size={13} />
          <span>{scenes.length === 0 ? 'Add Scene' : 'Add Scene Next'}</span>
        </button>
      </div>

      {/* Quick Scene Setting Switcher (All 12 real BKGDS.3CN stages) */}
      {scenes.length > 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-amber-200 shrink-0">
          <span className="font-bold">Setting:</span>
          <select
            value={currentScene?.bkgdCno ?? 0}
            onChange={(e) => {
              const cno = Number(e.target.value);
              const found = catalogScenes.find((s) => s.bkgdCno === cno);
              if (found) {
                void sound3DMM.playUiWav('DROPDN.WAV');
                onUpdateCurrentScene(found);
              }
            }}
            className="studio-well px-2 py-0.5 text-xs text-white focus:outline-none cursor-pointer"
          >
            {catalogScenes.length > 0 ? (
              catalogScenes.map((st) => (
                <option key={st.bkgdCno} value={st.bkgdCno}>
                  {st.name} ({st.views.length} views)
                </option>
              ))
            ) : (
              <option value={currentScene?.bkgdCno ?? 0}>{currentScene?.sceneName || 'MY-Street'}</option>
            )}
          </select>
        </div>
      ) : (
        <div className="text-[11px] font-bold text-amber-300 px-2 py-0.5 studio-well shrink-0">
          Blank Movie — Click &quot;Add Scene&quot; to start
        </div>
      )}

      {/* Add Scene Next Modal (All 12 real 3DMM backgrounds with MBMP thumbnails) */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="studio-panel p-4 max-w-2xl w-full text-xs text-white max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between pb-2.5 border-b border-purple-700/80 shrink-0">
              <div className="flex items-center gap-2">
                <img
                  src={assetUrl('3dmm/bmp/1SCEN.BMP')}
                  alt=""
                  className="h-6 w-auto object-contain image-rendering-pixelated"
                />
                <span className="font-bold text-sm text-amber-300">
                  Choose 3DMM Background Setting ({catalogScenes.length} Sets)
                </span>
              </div>
              <button
                onClick={() => {
                  void sound3DMM.playUiWav('CANCEL.WAV');
                  setShowAddModal(false);
                }}
                className="studio-btn px-2 py-0.5 font-bold"
              >
                ✕
              </button>
            </div>

            <div
              className={`my-2.5 p-2 text-xs shrink-0 border ${
                scenes.length === 0 || hasEntities
                  ? 'bg-emerald-950/70 border-emerald-500/60 text-emerald-200'
                  : 'bg-amber-950/70 border-amber-500/60 text-amber-200'
              }`}
            >
              {scenes.length === 0 ? (
                <span>
                  Blank movie — adding your first scene will unlock <strong>Cast, Props, Text &amp; Sounds</strong>.
                </span>
              ) : hasEntities ? (
                <span>
                  Current scene has cast/props — the chosen setting will be{' '}
                  <strong>added immediately next to it</strong>.
                </span>
              ) : (
                <span>
                  Current scene is empty — it will be <strong>overwritten</strong> with your chosen
                  setting.
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 overflow-y-auto pr-1 py-1">
              {catalogScenes.map((st) => (
                <button
                  key={st.bkgdCno}
                  onClick={() => {
                    void sound3DMM.playUiWav('ADDFRAME.WAV');
                    onAddOrOverwriteScene(st);
                    setShowAddModal(false);
                  }}
                  className="studio-btn p-2 flex flex-col gap-1.5 text-left"
                >
                  <div className="w-full aspect-video bg-black overflow-hidden flex items-center justify-center border border-[#120624]">
                    {st.thumbDataUrl ? (
                      <img
                        src={st.thumbDataUrl}
                        alt={st.name}
                        className="w-full h-full object-cover image-rendering-pixelated"
                      />
                    ) : (
                      <span className="text-purple-400">Loading...</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-bold text-amber-200 truncate">{st.name}</span>
                    <span className="text-[10px] text-purple-200 shrink-0">
                      {st.views.length} cams
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

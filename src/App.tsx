import React, { useEffect, useRef, useState } from 'react';
import {
  ActorEntity,
  CameraCutEvent,
  ImportedAudioCue,
  KeyframePosition,
  Movie,
  PropAction,
  PropEntity,
  Scene,
  ScreenTextBox,
  TdtAction,
  TdtTextEntity,
} from './types/movie';
import { createDefaultMovie, createEmptyScene } from './services/defaultMovie';
import {
  CatalogActorItem,
  CatalogPropItem,
  CatalogSceneItem,
  LoadedBackgroundView,
  loadTemplate,
  loadThreeDmmCatalog,
  preloadThreeDmmAssets,
  ThreeDmmCatalog,
} from './services/threeDmmEngine';
import { loadOfficial3mmMovie, OFFICIAL_SAMPLE_MOVIES } from './services/movie3mmParser';
import { exportMovieTo3mmBytes } from './services/movie3mmWriter';
import { CatalogSoundItem, sound3DMM } from './services/soundLibrary';
import { generateAiMovie } from './services/aiMovieGenerator';
import {
  LivePlayheadState,
  resolveActiveCameraAtFrame,
  resolveInterpolatedKeyframe,
  StageEntityType,
  Viewport3D,
} from './components/Viewport3D';
import { SceneBar } from './components/SceneBar';
import { CameraAngleBar } from './components/CameraAngleBar';
import { ActorPropPanel } from './components/ActorPropPanel';
import { TimelineBar } from './components/TimelineBar';
import { AudioImportModal } from './components/AudioImportModal';
import { assetUrl } from './utils/assetUrl';
import { BookOpen, FilePlus, Film, FolderOpen, Save, Settings, Sparkles, X } from 'lucide-react';

export default function App() {
  const [movie, setMovie] = useState<Movie>(createDefaultMovie);
  const [catalog, setCatalog] = useState<ThreeDmmCatalog>({
    actors: [],
    props: [],
    scenes: [],
  });
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [renderFrame, setRenderFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [selectedEntityId, setSelectedEntityId] = useState<string | null>('actor_bongo_1');
  const [selectedEntityType, setSelectedEntityType] = useState<
    'actor' | 'prop' | 'tdt' | 'tbox' | null
  >('actor');

  const [moveUpDownMode, setMoveUpDownMode] = useState(false);
  const [rotateMode, setRotateMode] = useState(false);
  const [isRecordingMovement, setIsRecordingMovement] = useState(false);
  const [enableInterpolation, setEnableInterpolation] = useState(false);
  const [enableShading, setEnableShading] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [mobileTab, setMobileTab] = useState<'stage' | 'cast'>('stage');
  const [isAudioModalOpen, setIsAudioModalOpen] = useState(false);
  const [showSamplesModal, setShowSamplesModal] = useState(false);
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showPlotBanner, setShowPlotBanner] = useState(true);
  const [soundCatalog, setSoundCatalog] = useState<CatalogSoundItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Loading real Microsoft 3DMM assets...');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const stageViewRef = useRef<LoadedBackgroundView | null>(null);

  const currentScene: Scene | undefined = movie.scenes[currentSceneIndex] || movie.scenes[0];
  const hasScene = Boolean(currentScene);
  const activeCatalogScene = hasScene
    ? catalog.scenes.find((s) => s.bkgdCno === currentScene!.bkgdCno) || catalog.scenes[0]
    : undefined;
  const activeCamAtFrame = hasScene
    ? resolveActiveCameraAtFrame(currentScene!, currentFrame)
    : { icam: 0, yaw: 0, pitch: 0 };

  const movieRef = useRef(movie);
  movieRef.current = movie;
  const playheadRef = useRef<LivePlayheadState>({
    sceneIndex: currentSceneIndex,
    frame: currentFrame,
    renderFrame,
    scrollHoldActive: false,
    scrollElapsedSec: 0,
    completedScrollIds: {},
  });
  if (!isPlaying) {
    playheadRef.current.sceneIndex = currentSceneIndex;
    playheadRef.current.frame = currentFrame;
    playheadRef.current.renderFrame = renderFrame;
    playheadRef.current.scrollHoldActive = false;
    playheadRef.current.scrollElapsedSec = 0;
  }

  // Load real 3DMM Catalog & preload scenes, views, templates, sound catalog, UI WAVs, and MS GS Wavetable SoundFont
  useEffect(() => {
    void sound3DMM
      .loadSoundCatalog()
      .then((list) => setSoundCatalog(list))
      .catch(() => {});
    sound3DMM.preloadUiWavs([
      'CANCEL.WAV', 'GOFRSTF.WAV', 'GOPREVF.WAV', 'GONEXTF.WAV', 'PLAY.WAV', 'STOP.WAV',
      'REMACTR.WAV', 'TBKOPEN.WAV', 'MOVE.WAV', 'GROW.WAV', 'SQUASH.WAV', 'SHRINK.WAV',
      'DROPDN.WAV', 'PSELECT.WAV', 'SACT.WAV', 'COSTUME.WAV', 'SPIN.WAV', 'ACESORY.WAV',
      'ADDFRAME.WAV', 'CBACKS.WAV', 'RECFRAME.WAV', 'FSAVE.WAV', 'FNEW.WAV', 'ALERT2.WAV',
      'MAPOPEN.WAV',
    ]);
    void fetch(assetUrl('3dmm/soundfont/MS_GS_Wavetable.sf2')).catch(() => {});

    loadThreeDmmCatalog()
      .then((cat) => {
        setCatalog(cat);
        setStatusMessage(
          `Loaded ${cat.actors.length} Actors, ${cat.props.length} Props, ${cat.scenes.length} Scenes (${cat.scenes.reduce((n, s) => n + s.views.length, 0)} Views) — Preloading assets...`
        );
        void preloadThreeDmmAssets(cat).then(() => {
          setStatusMessage(
            `Ready — Preloaded ${cat.scenes.length} Scenes (${cat.scenes.reduce((n, s) => n + s.views.length, 0)} Views), ${cat.actors.length} Actors & ${cat.props.length} Props.`
          );
        });
      })
      .catch((err) => {
        console.error('Failed loading 3DMM catalog:', err);
        setStatusMessage('Error loading 3DMM assets from 3dmm/3dmovie/.');
      });
  }, []);

  const triggerAudiosForFrame = (scene: Scene | undefined, frame: number) => {
    if (!scene) return;
    const cues = scene.audios.filter((a) => a.frame === frame);
    for (const cue of cues) {
      void sound3DMM.playCue(cue);
    }
  };

  // Silky display-synced playback (60-120+ FPS continuous subframes over 6 FPS 3DMM keyframes)
  useEffect(() => {
    if (!isPlaying) return;

    let rafId = 0;
    let lastNow = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.08, Math.max(0, (now - lastNow) / 1000));
      lastNow = now;

      const scenes = movieRef.current.scenes;
      if (scenes && scenes.length > 0) {
        let { sceneIndex, frame: intFrame, renderFrame: subFrame } = playheadRef.current;
        if (sceneIndex < 0 || sceneIndex >= scenes.length) sceneIndex = 0;

        const activeScene = scenes[sceneIndex];
        const completedMap =
          playheadRef.current.completedScrollIds ||
          (playheadRef.current.completedScrollIds = {});
        const activeScrollingAtFrame = (sc: Scene, f: number) =>
          (sc.textBoxes || []).filter(
            (tb) => tb.isScrolling && f >= tb.startFrame && f <= tb.endFrame && !completedMap[tb.id]
          );

        const holdingBoxes = activeScrollingAtFrame(activeScene, intFrame);
        if (holdingBoxes.length > 0) {
          const nextElapsed = (playheadRef.current.scrollElapsedSec || 0) + dt;
          if (nextElapsed >= 45) {
            for (const tb of holdingBoxes) completedMap[tb.id] = true;
            playheadRef.current.scrollHoldActive = false;
            playheadRef.current.scrollElapsedSec = 0;
          } else {
            playheadRef.current.scrollHoldActive = true;
            playheadRef.current.scrollElapsedSec = nextElapsed;
            playheadRef.current.frame = intFrame;
            playheadRef.current.renderFrame = intFrame;
            rafId = window.requestAnimationFrame(step);
            return;
          }
        }

        playheadRef.current.scrollHoldActive = false;
        playheadRef.current.scrollElapsedSec = 0;

        let nextRender = subFrame + dt * 6.0;
        let nextIntFrame = Math.floor(nextRender + 1e-6);
        let nextSceneIndex = sceneIndex;

        // If crossing into a frame that introduces an uncompleted scrolling credits box,
        // land cleanly on that frame so scrolling credits render and freeze that frame until finished.
        if (nextIntFrame > intFrame) {
          const maxCheck = Math.min(nextIntFrame, activeScene.totalFrames);
          for (let fCheck = intFrame + 1; fCheck <= maxCheck; fCheck++) {
            const incoming = activeScrollingAtFrame(activeScene, fCheck);
            if (incoming.length > 0) {
              nextIntFrame = fCheck;
              nextRender = fCheck;
              playheadRef.current.scrollHoldActive = true;
              playheadRef.current.scrollElapsedSec = 0;
              break;
            }
          }
        }

        if (nextIntFrame > activeScene.totalFrames) {
          if (sceneIndex + 1 < scenes.length) {
            nextSceneIndex = sceneIndex + 1;
            nextRender = 0;
            nextIntFrame = 0;
            playheadRef.current.completedScrollIds = {};
            playheadRef.current.scrollElapsedSec = 0;
            playheadRef.current.scrollHoldActive =
              activeScrollingAtFrame(scenes[nextSceneIndex], 0).length > 0;
            // Stop looping SFX at scene cuts while preserving background music continuity
            sound3DMM.stopLoopingSfx();
          } else {
            // Reached the end of the final scene: stop playback cleanly without repeating
            const endFrame = activeScene.totalFrames;
            playheadRef.current = {
              sceneIndex,
              frame: endFrame,
              renderFrame: endFrame,
              scrollHoldActive: false,
              scrollElapsedSec: 0,
              completedScrollIds: {},
            };
            sound3DMM.stopAll();
            setCurrentFrame(endFrame);
            setRenderFrame(endFrame);
            setIsPlaying(false);
            return;
          }
        }

        playheadRef.current.sceneIndex = nextSceneIndex;
        playheadRef.current.frame = nextIntFrame;
        playheadRef.current.renderFrame = nextRender;

        if (nextSceneIndex !== sceneIndex) {
          setCurrentSceneIndex(nextSceneIndex);
          setSelectedEntityId(null);
          setSelectedEntityType(null);
          setStatusMessage(
            `Playing Scene ${nextSceneIndex + 1}/${scenes.length}: ${scenes[nextSceneIndex].sceneName}`
          );
        }

        if (nextIntFrame !== intFrame || nextSceneIndex !== sceneIndex) {
          setCurrentFrame(nextIntFrame);
          setRenderFrame(nextIntFrame);
          triggerAudiosForFrame(scenes[nextSceneIndex], nextIntFrame);
        }
      }

      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying]);

  const handleTogglePlay = () => {
    if (!hasScene) return;
    if (isPlaying) {
      sound3DMM.stopAll();
      const activeScene = movieRef.current.scenes[playheadRef.current.sceneIndex];
      const maxF = activeScene ? activeScene.totalFrames : 0;
      const stoppedFrame = Math.max(
        0,
        Math.min(maxF, Math.round(playheadRef.current.renderFrame))
      );
      playheadRef.current = {
        sceneIndex: playheadRef.current.sceneIndex,
        frame: stoppedFrame,
        renderFrame: stoppedFrame,
        scrollHoldActive: false,
        scrollElapsedSec: 0,
        completedScrollIds: {},
      };
      setIsPlaying(false);
      setCurrentFrame(stoppedFrame);
      setRenderFrame(stoppedFrame);
      return;
    }
    setIsRecordingMovement(false);
    const atVeryEnd =
      currentSceneIndex >= movie.scenes.length - 1 &&
      currentFrame >= (currentScene?.totalFrames ?? 0);
    const startSceneIdx = atVeryEnd ? 0 : currentSceneIndex;
    const startFrame = atVeryEnd ? 0 : currentFrame;
    const startScene = movie.scenes[startSceneIdx] || currentScene;
    if (atVeryEnd && currentSceneIndex !== 0) {
      setCurrentSceneIndex(0);
    }
    setCurrentFrame(startFrame);
    setRenderFrame(startFrame);
    const hasScrollAtStart = Boolean(
      startScene?.textBoxes?.some(
        (tb) => tb.isScrolling && startFrame >= tb.startFrame && startFrame <= tb.endFrame
      )
    );
    playheadRef.current = {
      sceneIndex: startSceneIdx,
      frame: startFrame,
      renderFrame: startFrame,
      scrollHoldActive: hasScrollAtStart,
      scrollElapsedSec: 0,
      completedScrollIds: {},
    };
    if (startFrame === 0 && startScene) {
      triggerAudiosForFrame(startScene, 0);
    }
    setIsPlaying(true);
  };

  const handleSeekFrame = (frame: number) => {
    if (!currentScene) return;
    const clamped = Math.max(0, Math.min(currentScene.totalFrames, Math.round(frame)));
    playheadRef.current.frame = clamped;
    playheadRef.current.renderFrame = clamped;
    playheadRef.current.scrollHoldActive = false;
    playheadRef.current.scrollElapsedSec = 0;
    // Allow re-triggering scrolling credits only if user rewound strictly before their startFrame
    const prevCompleted = playheadRef.current.completedScrollIds || {};
    const nextCompleted: Record<string, boolean> = {};
    for (const tb of currentScene.textBoxes || []) {
      if (tb.isScrolling && prevCompleted[tb.id] && clamped > tb.startFrame) {
        nextCompleted[tb.id] = true;
      }
    }
    playheadRef.current.completedScrollIds = nextCompleted;
    setCurrentFrame(clamped);
    setRenderFrame(clamped);
    triggerAudiosForFrame(currentScene, clamped);
  };

  // Start a completely blank movie (black screen, no objects/sounds until Scene 1 is added)
  const handleNewBlankMovie = () => {
    sound3DMM.stopAll();
    setIsPlaying(false);
    setIsRecordingMovement(false);
    setIsAudioModalOpen(false);
    setMoveUpDownMode(false);
    setRotateMode(false);
    setMovie({
      title: 'Untitled Movie',
      scenes: [],
    });
    setCurrentSceneIndex(0);
    setCurrentFrame(0);
    setRenderFrame(0);
    playheadRef.current = {
      sceneIndex: 0,
      frame: 0,
      renderFrame: 0,
      scrollHoldActive: false,
      scrollElapsedSec: 0,
      completedScrollIds: {},
    };
    setSelectedEntityId(null);
    setSelectedEntityType(null);
    setMobileTab('stage');
    void sound3DMM.playUiWav('FNEW.WAV');
    setStatusMessage('Started a blank movie — click "Add Scene" above to unlock actors, props, words & sounds.');
  };

  // Add Scene Next Rule: add first scene if blank, overwrite if empty, or insert next
  const handleAddOrOverwriteScene = (chosen: CatalogSceneItem) => {
    sound3DMM.stopMusic();
    if (movie.scenes.length === 0 || !currentScene) {
      const firstScene = createEmptyScene(chosen.bkgdCno, chosen.name, 0);
      setMovie({ ...movie, scenes: [firstScene] });
      setCurrentSceneIndex(0);
      setCurrentFrame(0);
      setRenderFrame(0);
      playheadRef.current = {
        sceneIndex: 0,
        frame: 0,
        renderFrame: 0,
        scrollHoldActive: false,
        scrollElapsedSec: 0,
        completedScrollIds: {},
      };
      setSelectedEntityId(null);
      setSelectedEntityType(null);
      setIsRecordingMovement(false);
      setStatusMessage(`Added Scene 1: "${chosen.name}". Stage tools and sounds are now enabled!`);
      return;
    }

    const hasEntities =
      currentScene.actors.length > 0 ||
      currentScene.props.length > 0 ||
      (currentScene.tdtTexts?.length || 0) > 0 ||
      (currentScene.textBoxes?.length || 0) > 0;
    if (!hasEntities) {
      const updated = [...movie.scenes];
      updated[currentSceneIndex] = {
        ...currentScene,
        bkgdCno: chosen.bkgdCno,
        sceneName: chosen.name,
        icam: 0,
        cameraCuts: undefined,
      };
      setMovie({ ...movie, scenes: updated });
      setStatusMessage(`Empty scene overwritten with ${chosen.name}.`);
    } else {
      const newScene = createEmptyScene(chosen.bkgdCno, chosen.name, 0);
      const updated = [...movie.scenes];
      updated.splice(currentSceneIndex + 1, 0, newScene);
      setMovie({ ...movie, scenes: updated });
      setCurrentSceneIndex(currentSceneIndex + 1);
      setCurrentFrame(0);
      setRenderFrame(0);
      playheadRef.current = {
        sceneIndex: currentSceneIndex + 1,
        frame: 0,
        renderFrame: 0,
        scrollHoldActive: false,
        scrollElapsedSec: 0,
        completedScrollIds: {},
      };
      setSelectedEntityId(null);
      setSelectedEntityType(null);
      setIsRecordingMovement(false);
      setStatusMessage(`Added scene ${chosen.name} next to Scene ${currentSceneIndex + 1}.`);
    }
  };

  const handleUpdateCurrentScene = (chosen: CatalogSceneItem) => {
    if (!currentScene) return;
    sound3DMM.stopMusic();
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      bkgdCno: chosen.bkgdCno,
      sceneName: chosen.name,
      icam: 0,
      cameraCuts: undefined,
      cameraAngle: { yaw: 0, pitch: 0 },
    };
    setMovie({ ...movie, scenes: updated });
  };

  // Supports BOTH setting View at frame 0 AND adding camera angle cuts at any frame > 0!
  const handleSelectCameraView = (icam: number) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    if (currentFrame === 0 && (!currentScene.cameraCuts || currentScene.cameraCuts.length <= 1)) {
      updated[currentSceneIndex] = {
        ...currentScene,
        icam,
        cameraAngle: { yaw: 0, pitch: 0 },
        cameraCuts: currentScene.cameraCuts
          ? [{ frame: 0, icam, yaw: 0, pitch: 0 }]
          : undefined,
      };
      setStatusMessage(`Switched to 3DMM Camera View #${icam + 1}.`);
    } else {
      const baseCuts: CameraCutEvent[] =
        currentScene.cameraCuts && currentScene.cameraCuts.length > 0
          ? [...currentScene.cameraCuts]
          : [
              {
                frame: 0,
                icam: currentScene.icam,
                yaw: currentScene.cameraAngle.yaw,
                pitch: currentScene.cameraAngle.pitch,
              },
            ];
      const idx = baseCuts.findIndex((c) => c.frame === currentFrame);
      const nextCut: CameraCutEvent = { frame: currentFrame, icam, yaw: 0, pitch: 0 };
      if (idx >= 0) baseCuts[idx] = nextCut;
      else baseCuts.push(nextCut);
      baseCuts.sort((a, b) => a.frame - b.frame);

      updated[currentSceneIndex] = {
        ...currentScene,
        icam: currentFrame === 0 ? icam : currentScene.icam,
        cameraAngle: currentFrame === 0 ? { yaw: 0, pitch: 0 } : currentScene.cameraAngle,
        cameraCuts: baseCuts,
      };
      setStatusMessage(`Camera cut to View #${icam + 1} at Frame ${currentFrame}.`);
    }
    setMovie({ ...movie, scenes: updated });
  };

  const handleDeleteCameraCutAtFrame = (frame: number) => {
    if (!currentScene || !currentScene.cameraCuts) return;
    const filtered = currentScene.cameraCuts.filter((c) => c.frame !== frame);
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      cameraCuts: filtered.length > 0 ? filtered : undefined,
    };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Removed camera cut at Frame ${frame}.`);
  };

  // Place new actor/prop/3D text using Camera-Aligned Stage Space (or world APOS for imported .3MM scenes)
  const computePlacementForCurrentView = (slot: number): KeyframePosition => {
    const offsets = [0, 3.8, -3.8, 7.2, -7.2];
    const lateralStep = offsets[slot % offsets.length];
    const depthStep = -Math.floor(slot / offsets.length) * 3.2;

    if (!currentScene || currentScene.coordMode !== 'world') {
      return { x: lateralStep, y: 0, z: depthStep, rotY: 0 };
    }

    const view = stageViewRef.current;
    if (!view) {
      return { x: lateralStep, y: 0, z: depthStep, rotY: 0 };
    }
    const basePos = view.stageOrigin || view.apos;
    const worldX = basePos.x + view.camRightXZ.x * lateralStep - view.camForwardXZ.x * depthStep;
    const worldY = basePos.y;
    const worldZ = basePos.z + view.camRightXZ.z * lateralStep - view.camForwardXZ.z * depthStep;
    const facingCamRotY = Math.atan2(-view.camForwardXZ.x, -view.camForwardXZ.z);
    return { x: worldX, y: worldY, z: worldZ, rotY: facingCamRotY };
  };

  const handleAddActor = (item: CatalogActorItem) => {
    if (!currentScene) return;
    const slot =
      currentScene.actors.length +
      currentScene.props.length +
      (currentScene.tdtTexts?.length || 0);
    const pos = computePlacementForCurrentView(slot);
    const newActor: ActorEntity = {
      id: 'actor_' + Math.random().toString(36).substring(2, 9),
      tmplCno: item.tmplCno,
      name: item.name,
      anid: 0,
      actionName: 'At Rest',
      keyframes: {
        [currentFrame]: pos,
      },
    };
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      actors: [...currentScene.actors, newActor],
    };
    setMovie({ ...movie, scenes: updated });
    setSelectedEntityId(newActor.id);
    setSelectedEntityType('actor');
    setMobileTab('stage');
    setStatusMessage(`Placed "${item.name}" at Rest facing Camera #${activeCamAtFrame.icam + 1}.`);
  };

  const handleAddProp = async (item: CatalogPropItem) => {
    if (!currentScene) return;
    const slot =
      currentScene.actors.length +
      currentScene.props.length +
      (currentScene.tdtTexts?.length || 0);
    const pos = computePlacementForCurrentView(slot);

    let defaultAction = 'At Rest';
    let defaultAnid: number | undefined;
    try {
      const tmpl = await loadTemplate(item.tmplCno);
      if (tmpl.actions.length > 0) {
        const restAct = tmpl.actions.find((a) => /rest|idle/i.test(a.name)) || tmpl.actions[0];
        defaultAction = restAct.name;
        defaultAnid = restAct.anid;
      }
    } catch {
      // ignore fallback
    }

    const newProp: PropEntity = {
      id: 'prop_' + Math.random().toString(36).substring(2, 9),
      tmplCno: item.tmplCno,
      name: item.name,
      action: defaultAction,
      ...(defaultAnid !== undefined ? { anid: defaultAnid } : {}),
      keyframes: {
        [currentFrame]: { ...pos, rotY: currentScene.coordMode === 'world' ? pos.rotY : 0 },
      },
    };
    setMovie((prev) => {
      const sc = prev.scenes[currentSceneIndex];
      if (!sc) return prev;
      const updated = [...prev.scenes];
      updated[currentSceneIndex] = {
        ...sc,
        props: [...sc.props, newProp],
      };
      return { ...prev, scenes: updated };
    });
    setSelectedEntityId(newProp.id);
    setSelectedEntityType('prop');
    setMobileTab('stage');
    setStatusMessage(
      `Placed prop "${item.name}" (${defaultAction}) in Camera #${activeCamAtFrame.icam + 1}.`
    );
  };

  const handleAddTdtText = (spec: {
    text: string;
    tdfCno: number;
    tdts: number;
    mtrlCno?: number;
    color?: string;
    action?: TdtAction | string;
  }) => {
    if (!currentScene) return;
    const slot =
      currentScene.actors.length +
      currentScene.props.length +
      (currentScene.tdtTexts?.length || 0);
    const pos = computePlacementForCurrentView(slot);
    const chosenAction = spec.action || 'At Rest';
    const newTdt: TdtTextEntity = {
      id: 'tdt_' + Math.random().toString(36).substring(2, 9),
      text: spec.text || 'HELLO',
      tdfCno: spec.tdfCno,
      tdts: spec.tdts,
      mtrlCno: spec.mtrlCno,
      action: chosenAction,
      actionKeyframes: {
        [currentFrame]: { action: chosenAction },
      },
      keyframes: {
        [currentFrame]: {
          ...pos,
          y: pos.y + 1.5,
          ...(spec.color ? { color: spec.color } : {}),
        },
      },
    };
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      tdtTexts: [...(currentScene.tdtTexts || []), newTdt],
    };
    setMovie({ ...movie, scenes: updated });
    setSelectedEntityId(newTdt.id);
    setSelectedEntityType('tdt');
    setMobileTab('stage');
    setStatusMessage(`Added 3D Word "${newTdt.text}" (${chosenAction}) at Frame ${currentFrame}.`);
  };

  const handleUpdateTdtAction = (id: string, action: TdtAction | string) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      tdtTexts: (currentScene.tdtTexts || []).map((t) => {
        if (t.id !== id) return t;
        const nextMap = {
          ...(t.actionKeyframes || { 0: { action: t.action || 'At Rest' } }),
          [currentFrame]: { action },
        };
        return {
          ...t,
          action: currentFrame === 0 ? action : (t.action || 'At Rest'),
          actionKeyframes: nextMap,
        };
      }),
    };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Set 3D Word animation "${action}" at Frame ${currentFrame}.`);
  };

  const handleUpdateTdtText = (
    id: string,
    patch: Partial<Pick<TdtTextEntity, 'text' | 'tdfCno' | 'tdts' | 'mtrlCno'>>
  ) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      tdtTexts: (currentScene.tdtTexts || []).map((t) =>
        t.id === id ? { ...t, ...patch } : t
      ),
    };
    setMovie({ ...movie, scenes: updated });
  };

  const handleAddTextBox = (spec: Omit<ScreenTextBox, 'id'>) => {
    if (!currentScene) return;
    const newBox: ScreenTextBox = {
      ...spec,
      id: 'tbox_' + Math.random().toString(36).substring(2, 9),
    };
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      textBoxes: [...(currentScene.textBoxes || []), newBox],
      totalFrames: Math.max(currentScene.totalFrames, newBox.endFrame),
    };
    setMovie({ ...movie, scenes: updated });
    setSelectedEntityId(newBox.id);
    setSelectedEntityType('tbox');
    setStatusMessage(
      `Added 2D Onscreen Words "${newBox.text.slice(0, 24)}" (f${newBox.startFrame}..f${newBox.endFrame}).`
    );
  };

  const handleUpdateTextBox = (id: string, patch: Partial<ScreenTextBox>) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      textBoxes: (currentScene.textBoxes || []).map((tb) =>
        tb.id === id ? { ...tb, ...patch } : tb
      ),
    };
    setMovie({ ...movie, scenes: updated });
  };

  const handleUpdateActorAction = (id: string, anid: number, actionName: string) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      actors: currentScene.actors.map((a) => {
        if (a.id !== id) return a;
        const nextMap = {
          ...(a.actionKeyframes || { 0: { anid: a.anid, actionName: a.actionName } }),
          [currentFrame]: { anid, actionName },
        };
        return {
          ...a,
          anid: currentFrame === 0 ? anid : a.anid,
          actionName: currentFrame === 0 ? actionName : a.actionName,
          actionKeyframes: nextMap,
        };
      }),
    };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Set "${actionName}" at Frame ${currentFrame}.`);
  };

  const handleUpdateActorCostume = (id: string, costumeCmids: number[]) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      actors: currentScene.actors.map((a) => (a.id === id ? { ...a, costumeCmids } : a)),
    };
    setMovie({ ...movie, scenes: updated });
  };

  const handleUpdatePropAction = (id: string, action: PropAction, anid?: number) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      props: currentScene.props.map((p) => {
        if (p.id !== id) return p;
        const nextMap = {
          ...(p.actionKeyframes || {
            0: { action: p.action, ...(p.anid !== undefined ? { anid: p.anid } : {}) },
          }),
          [currentFrame]: { action, ...(anid !== undefined ? { anid } : {}) },
        };
        return {
          ...p,
          action: currentFrame === 0 ? action : p.action,
          ...(currentFrame === 0 && anid !== undefined ? { anid } : {}),
          actionKeyframes: nextMap,
        };
      }),
    };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Set prop action "${action}" at Frame ${currentFrame}.`);
  };

  const handleUpdatePropCostume = (id: string, costumeCmids: number[]) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      props: currentScene.props.map((p) => (p.id === id ? { ...p, costumeCmids } : p)),
    };
    setMovie({ ...movie, scenes: updated });
  };

  const handleToggleRecordingMovement = () => {
    if (
      !selectedEntityId ||
      (selectedEntityType !== 'actor' &&
        selectedEntityType !== 'prop' &&
        selectedEntityType !== 'tdt')
    ) {
      return;
    }
    const next = !isRecordingMovement;
    void sound3DMM.playUiWav('RECFRAME.WAV');
    if (next) {
      setIsPlaying(false);
      setRenderFrame(currentFrame);
      setMobileTab('stage');
      setStatusMessage(`Recording motion at 6 FPS from Frame ${currentFrame} — drag entity!`);
    } else {
      setStatusMessage('Stopped recording movement.');
    }
    setIsRecordingMovement(next);
  };

  const patchSceneEntityKeyframes = (
    sc: Scene,
    entityId: string,
    type: StageEntityType,
    updater: (kfs: Record<number, KeyframePosition>) => Record<number, KeyframePosition>,
    newTotalFrames?: number
  ): Scene => {
    const nextTotal =
      newTotalFrames !== undefined ? Math.max(sc.totalFrames, newTotalFrames) : sc.totalFrames;
    if (type === 'actor') {
      return {
        ...sc,
        totalFrames: nextTotal,
        actors: sc.actors.map((a) =>
          a.id === entityId ? { ...a, keyframes: updater(a.keyframes) } : a
        ),
      };
    }
    if (type === 'prop') {
      return {
        ...sc,
        totalFrames: nextTotal,
        props: sc.props.map((p) =>
          p.id === entityId ? { ...p, keyframes: updater(p.keyframes) } : p
        ),
      };
    }
    return {
      ...sc,
      totalFrames: nextTotal,
      tdtTexts: (sc.tdtTexts || []).map((t) =>
        t.id === entityId ? { ...t, keyframes: updater(t.keyframes) } : t
      ),
    };
  };

  const handleBeginRecordingAtFrame = (
    entityId: string,
    type: StageEntityType,
    startFrame: number,
    pos: KeyframePosition
  ) => {
    setIsPlaying(false);
    setMovie((prev) => {
      const idx = playheadRef.current.sceneIndex;
      const sc = prev.scenes[idx];
      if (!sc) return prev;
      const truncate = (kfs: Record<number, KeyframePosition>) => {
        const cur = resolveInterpolatedKeyframe(kfs, startFrame, undefined, enableInterpolation);
        const out: Record<number, KeyframePosition> = {};
        Object.entries(kfs).forEach(([k, v]) => {
          if (Number(k) < startFrame) out[Number(k)] = v;
        });
        out[startFrame] = {
          ...cur,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          rotY: pos.rotY,
          ...(pos.rotX !== undefined ? { rotX: pos.rotX } : {}),
          ...(pos.rotZ !== undefined ? { rotZ: pos.rotZ } : {}),
          visible: cur.visible === false ? true : cur.visible,
        };
        return out;
      };
      const updatedScenes = [...prev.scenes];
      updatedScenes[idx] = patchSceneEntityKeyframes(sc, entityId, type, truncate, startFrame);
      return { ...prev, scenes: updatedScenes };
    });
  };

  const handleRecordMovementStep = (
    entityId: string,
    type: StageEntityType,
    frame: number,
    pos: KeyframePosition,
    advancePlayhead: boolean
  ) => {
    setMovie((prev) => {
      const idx = playheadRef.current.sceneIndex;
      const sc = prev.scenes[idx];
      if (!sc) return prev;
      const write = (kfs: Record<number, KeyframePosition>) => {
        const cur = resolveInterpolatedKeyframe(kfs, frame, undefined, enableInterpolation);
        const out: Record<number, KeyframePosition> = {};
        Object.entries(kfs).forEach(([k, v]) => {
          if (Number(k) <= frame) out[Number(k)] = v;
        });
        out[frame] = {
          ...cur,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          rotY: pos.rotY,
          ...(pos.rotX !== undefined ? { rotX: pos.rotX } : {}),
          ...(pos.rotZ !== undefined ? { rotZ: pos.rotZ } : {}),
          visible: cur.visible === false ? true : cur.visible,
        };
        return out;
      };
      const updatedScenes = [...prev.scenes];
      updatedScenes[idx] = patchSceneEntityKeyframes(sc, entityId, type, write, frame);
      return { ...prev, scenes: updatedScenes };
    });

    if (advancePlayhead) {
      playheadRef.current = {
        sceneIndex: playheadRef.current.sceneIndex,
        frame,
        renderFrame: frame,
        scrollHoldActive: false,
        scrollElapsedSec: 0,
        completedScrollIds: {},
      };
      setCurrentFrame(frame);
      setRenderFrame(frame);
      triggerAudiosForFrame(movieRef.current.scenes[playheadRef.current.sceneIndex], frame);
    }
  };

  const handleMoveEntityAtFrame = (
    entityId: string,
    type: StageEntityType,
    frame: number,
    pos: KeyframePosition,
    deltaX: number,
    deltaY: number,
    deltaZ: number
  ) => {
    setMovie((prev) => {
      const idx = playheadRef.current.sceneIndex;
      const sc = prev.scenes[idx];
      if (!sc) return prev;
      const shift = (kfs: Record<number, KeyframePosition>) => {
        const cur = resolveInterpolatedKeyframe(kfs, frame, undefined, enableInterpolation);
        const out: Record<number, KeyframePosition> = {};
        Object.entries(kfs).forEach(([k, v]) => {
          const fn = Number(k);
          if (fn < frame) out[fn] = v;
          else if (fn > frame) {
            out[fn] = {
              ...v,
              x: v.x + deltaX,
              y: v.y + deltaY,
              z: v.z + deltaZ,
            };
          }
        });
        out[frame] = {
          ...cur,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          rotY: pos.rotY,
          ...(pos.rotX !== undefined ? { rotX: pos.rotX } : {}),
          ...(pos.rotZ !== undefined ? { rotZ: pos.rotZ } : {}),
        };
        return out;
      };
      const updatedScenes = [...prev.scenes];
      updatedScenes[idx] = patchSceneEntityKeyframes(sc, entityId, type, shift);
      return { ...prev, scenes: updatedScenes };
    });
  };

  // Up / Down keyboard shortcut (ArrowUp / ArrowDown) for nudging selected 3D object vertically
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          activeEl.isContentEditable)
      ) {
        return;
      }
      if (
        !currentScene ||
        !selectedEntityId ||
        (selectedEntityType !== 'actor' &&
          selectedEntityType !== 'prop' &&
          selectedEntityType !== 'tdt')
      ) {
        return;
      }

      const entity =
        selectedEntityType === 'actor'
          ? currentScene.actors.find((a) => a.id === selectedEntityId)
          : selectedEntityType === 'prop'
          ? currentScene.props.find((p) => p.id === selectedEntityId)
          : (currentScene.tdtTexts || []).find((t) => t.id === selectedEntityId);
      if (!entity) return;

      e.preventDefault();
      const dy = e.key === 'ArrowUp' ? 0.7 : -0.7;
      const cur = resolveInterpolatedKeyframe(
        entity.keyframes,
        currentFrame,
        undefined,
        enableInterpolation
      );
      handleMoveEntityAtFrame(
        selectedEntityId,
        selectedEntityType,
        currentFrame,
        { ...cur, y: cur.y + dy },
        0,
        dy,
        0
      );
      setStatusMessage(
        `Moved ${e.key === 'ArrowUp' ? 'Up' : 'Down'} at Frame ${currentFrame} (Y: ${(cur.y + dy).toFixed(2)}).`
      );
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentScene, selectedEntityId, selectedEntityType, currentFrame]);

  const handleUpdateEntityColor = (
    id: string,
    type: StageEntityType,
    color?: string
  ) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    const patchColor = (kfs: Record<number, KeyframePosition>) => {
      const cur = resolveInterpolatedKeyframe(kfs, currentFrame, undefined, enableInterpolation);
      const entry: KeyframePosition = { ...cur };
      if (color) entry.color = color;
      else delete entry.color;
      return { ...kfs, [currentFrame]: entry };
    };
    updated[currentSceneIndex] = patchSceneEntityKeyframes(currentScene, id, type, patchColor);
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(
      color
        ? `Set color ${color} at Frame ${currentFrame}.`
        : `Cleared keyframe color override at Frame ${currentFrame}.`
    );
  };

  const handleUpdateEntityRotation = (
    id: string,
    type: StageEntityType,
    rotX: number,
    rotY: number,
    rotZ: number
  ) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    const patchRot = (kfs: Record<number, KeyframePosition>) => {
      const cur = resolveInterpolatedKeyframe(kfs, currentFrame, undefined, enableInterpolation);
      const next: KeyframePosition = {
        ...cur,
        rotY,
      };
      if (Math.abs(rotX) > 1e-4) next.rotX = rotX;
      else delete next.rotX;
      if (Math.abs(rotZ) > 1e-4) next.rotZ = rotZ;
      else delete next.rotZ;
      return {
        ...kfs,
        [currentFrame]: next,
      };
    };
    updated[currentSceneIndex] = patchSceneEntityKeyframes(currentScene, id, type, patchRot);
    setMovie({ ...movie, scenes: updated });
    const deg = (r: number) => Math.round((r * 180) / Math.PI);
    setStatusMessage(
      `Rotated at Frame ${currentFrame} (X:${deg(rotX)}° Y:${deg(rotY)}° Z:${deg(rotZ)}°).`
    );
  };

  const handleUpdateEntityScale = (
    id: string,
    type: StageEntityType,
    scaleX: number,
    scaleY: number,
    scaleZ: number
  ) => {
    if (!currentScene) return;
    const sx = Math.max(0.25, Math.min(3.5, scaleX));
    const sy = Math.max(0.25, Math.min(3.5, scaleY));
    const sz = Math.max(0.25, Math.min(3.5, scaleZ));
    const updated = [...movie.scenes];
    const patchKeyframes = (kfs: Record<number, KeyframePosition>) => {
      const cur = resolveInterpolatedKeyframe(kfs, currentFrame, undefined, enableInterpolation);
      return {
        ...kfs,
        [currentFrame]: {
          ...cur,
          scaleX: sx,
          scaleY: sy,
          scaleZ: sz,
        },
      };
    };
    updated[currentSceneIndex] = patchSceneEntityKeyframes(
      currentScene,
      id,
      type,
      patchKeyframes
    );
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(
      `Scaled at Frame ${currentFrame} (${sx.toFixed(2)}×${sy.toFixed(2)}×${sz.toFixed(2)}).`
    );
  };

  const handleToggleEntityVisibility = (
    id: string,
    type: StageEntityType,
    visible: boolean
  ) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    const patchKeyframes = (kfs: Record<number, KeyframePosition>) => {
      const cur = resolveInterpolatedKeyframe(kfs, currentFrame, undefined, enableInterpolation);
      return {
        ...kfs,
        [currentFrame]: {
          ...cur,
          visible,
        },
      };
    };
    updated[currentSceneIndex] = patchSceneEntityKeyframes(
      currentScene,
      id,
      type,
      patchKeyframes
    );
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`${visible ? 'Showed' : 'Hid'} ${type} at Frame ${currentFrame}.`);
  };

  const handleSetEntityFrame = (
    id: string,
    type: StageEntityType,
    targetFrame: number,
    mode: 'pin' | 'showFrom' | 'hideFrom'
  ) => {
    if (!currentScene) return;
    const tf = Math.max(0, Math.round(targetFrame));
    const updated = [...movie.scenes];
    const patchKeyframes = (kfs: Record<number, KeyframePosition>) => {
      const cur = resolveInterpolatedKeyframe(kfs, currentFrame, undefined, enableInterpolation);
      const next = { ...kfs };
      if (mode === 'showFrom' && tf > 0) {
        if (!next[0]) {
          next[0] = { ...cur, visible: false };
        } else {
          next[0] = { ...next[0], visible: false };
        }
        next[tf] = { ...cur, visible: true };
      } else if (mode === 'hideFrom') {
        next[tf] = { ...cur, visible: false };
      } else {
        next[tf] = { ...cur, visible: cur.visible === false ? true : cur.visible };
      }
      return next;
    };

    updated[currentSceneIndex] = patchSceneEntityKeyframes(
      currentScene,
      id,
      type,
      patchKeyframes,
      tf
    );
    setMovie({ ...movie, scenes: updated });
    setCurrentFrame(tf);
    setRenderFrame(tf);
    playheadRef.current.frame = tf;
    playheadRef.current.renderFrame = tf;
    setStatusMessage(
      mode === 'showFrom'
        ? `Set ${type} to enter stage at Frame ${tf}.`
        : mode === 'hideFrom'
          ? `Set ${type} to exit/hide starting at Frame ${tf}.`
          : `Pinned pose/position at Frame ${tf}.`
    );
  };

  const handleRemoveEntityKeyframe = (
    id: string,
    type: StageEntityType,
    frame: number
  ) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    const removeKey = (kfs: Record<number, KeyframePosition>) => {
      if (Object.keys(kfs).length <= 1) return kfs;
      const next = { ...kfs };
      delete next[frame];
      return next;
    };
    updated[currentSceneIndex] = patchSceneEntityKeyframes(currentScene, id, type, removeKey);
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Removed ${type} keyframe at Frame ${frame}.`);
  };

  const handleUpdateEntityPoseCel = (
    id: string,
    type: 'actor' | 'prop',
    celOffset: number,
    freeze: boolean
  ) => {
    if (!currentScene) return;
    const cleanCel = Math.max(0, Math.round(celOffset));
    const updated = [...movie.scenes];
    if (type === 'actor') {
      updated[currentSceneIndex] = {
        ...currentScene,
        actors: currentScene.actors.map((a) => {
          if (a.id !== id) return a;
          const prevMap = a.actionKeyframes || { 0: { anid: a.anid, actionName: a.actionName } };
          const curKeys = Object.keys(prevMap).map(Number).sort((x, y) => x - y);
          const prevKey = curKeys.filter((k) => k <= currentFrame).pop();
          const curAct =
            prevKey !== undefined ? prevMap[prevKey] : { anid: a.anid, actionName: a.actionName };
          return {
            ...a,
            actionKeyframes: {
              ...prevMap,
              [currentFrame]: {
                anid: curAct.anid,
                actionName: curAct.actionName,
                celOffset: cleanCel,
                freeze,
              },
            },
          };
        }),
      };
    } else {
      updated[currentSceneIndex] = {
        ...currentScene,
        props: currentScene.props.map((p) => {
          if (p.id !== id) return p;
          const prevMap = p.actionKeyframes || { 0: { action: p.action } };
          const curKeys = Object.keys(prevMap).map(Number).sort((x, y) => x - y);
          const prevKey = curKeys.filter((k) => k <= currentFrame).pop();
          const curAct = prevKey !== undefined ? prevMap[prevKey] : { action: p.action };
          return {
            ...p,
            actionKeyframes: {
              ...prevMap,
              [currentFrame]: {
                action: curAct.action,
                celOffset: cleanCel,
                freeze,
              },
            },
          };
        }),
      };
    }
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(
      `${freeze ? 'Pinned' : 'Started'} ${type} cel #${cleanCel} at Frame ${currentFrame}.`
    );
  };

  const handleClearKeyframes = (id: string, type: StageEntityType) => {
    if (!currentScene) return;
    const resolveCur = (kfs: Record<number, KeyframePosition>) =>
      resolveInterpolatedKeyframe(kfs, currentFrame, undefined, enableInterpolation);
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = patchSceneEntityKeyframes(
      currentScene,
      id,
      type,
      (kfs) => ({ 0: resolveCur(kfs) })
    );
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Cleared keyframes for ${type} (kept pose at Frame 0).`);
  };

  const handleDeleteEntity = (
    id: string,
    type: 'actor' | 'prop' | 'tdt' | 'tbox'
  ) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    if (type === 'actor') {
      updated[currentSceneIndex] = {
        ...currentScene,
        actors: currentScene.actors.filter((a) => a.id !== id),
      };
    } else if (type === 'prop') {
      updated[currentSceneIndex] = {
        ...currentScene,
        props: currentScene.props.filter((p) => p.id !== id),
      };
    } else if (type === 'tdt') {
      updated[currentSceneIndex] = {
        ...currentScene,
        tdtTexts: (currentScene.tdtTexts || []).filter((t) => t.id !== id),
      };
    } else {
      updated[currentSceneIndex] = {
        ...currentScene,
        textBoxes: (currentScene.textBoxes || []).filter((tb) => tb.id !== id),
      };
    }
    setMovie({ ...movie, scenes: updated });
    if (selectedEntityId === id) {
      setSelectedEntityId(null);
      setSelectedEntityType(null);
      setIsRecordingMovement(false);
    }
  };

  const handleAddAudioCue = (cue: ImportedAudioCue) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      audios: [
        ...currentScene.audios.filter((a) => a.frame !== cue.frame || a.isMidi !== cue.isMidi),
        cue,
      ],
    };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Added "${cue.filename}" at Frame ${cue.frame}.`);
  };

  const handleDeleteAudioCue = (id: string) => {
    if (!currentScene) return;
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      audios: currentScene.audios.filter((a) => a.id !== id),
    };
    setMovie({ ...movie, scenes: updated });
  };

  // Save authentic binary .3MM file ONLY (never .json)
  const handleSaveMovie3MM = async () => {
    if (!hasScene) {
      void sound3DMM.playUiWav('ALERT2.WAV');
      setStatusMessage('Add at least one scene before saving a .3MM movie.');
      return;
    }
    setIsSaving(true);
    try {
      setStatusMessage('Packing binary .3MM movie archive...');
      const bytes = await exportMovieTo3mmBytes(movie);
      void sound3DMM.playUiWav('FSAVE.WAV');
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeName =
        movie.title
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '_')
          .replace(/^_+|_+$/g, '') || 'movie';
      link.href = url;
      link.download = `${safeName}.3mm`;
      link.click();
      URL.revokeObjectURL(url);
      setStatusMessage(
        `Saved binary "${safeName}.3mm" (${(bytes.byteLength / 1024).toFixed(1)} KB).`
      );
    } catch (err) {
      console.error('Failed saving .3MM:', err);
      void sound3DMM.playUiWav('ALERT2.WAV');
      setStatusMessage('Error exporting binary .3MM file.');
    } finally {
      setIsSaving(false);
    }
  };

  // Import binary .3MM movies ONLY (never .json)
  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    sound3DMM.stopAll();
    setIsPlaying(false);

    if (!file.name.toLowerCase().endsWith('.3mm')) {
      void sound3DMM.playUiWav('ALERT2.WAV');
      setStatusMessage('Only authentic binary .3MM movie files are supported.');
      return;
    }

    try {
      setStatusMessage(`Decoding binary ${file.name}...`);
      const ab = await file.arrayBuffer();
      const loaded = await loadOfficial3mmMovie(ab, file.name);
      void sound3DMM.playUiWav('FNEW.WAV');
      setMovie(loaded);
      setCurrentSceneIndex(0);
      setCurrentFrame(0);
      setRenderFrame(0);
      playheadRef.current = {
        sceneIndex: 0,
        frame: 0,
        renderFrame: 0,
        scrollHoldActive: false,
        scrollElapsedSec: 0,
        completedScrollIds: {},
      };
      const firstActor = loaded.scenes[0]?.actors[0];
      setSelectedEntityId(firstActor?.id || null);
      setSelectedEntityType(firstActor ? 'actor' : null);
      setIsRecordingMovement(false);
      setStatusMessage(
        `Loaded binary .3MM movie "${loaded.title}" (${loaded.scenes.length} scene${loaded.scenes.length === 1 ? '' : 's'})!`
      );
    } catch (err) {
      console.error(err);
      void sound3DMM.playUiWav('ALERT2.WAV');
      setStatusMessage('Error decoding .3MM binary movie file.');
    }
  };

  const handleLoadSample3mm = async (sampleFile: string, label: string) => {
    setShowSamplesModal(false);
    sound3DMM.stopAll();
    setIsPlaying(false);
    setStatusMessage(`Loading authentic ${sampleFile}...`);
    try {
      const loaded = await loadOfficial3mmMovie(assetUrl(`3dmm/samples/${sampleFile}`), label);
      void sound3DMM.playUiWav('FNEW.WAV');
      setMovie(loaded);
      setCurrentSceneIndex(0);
      setCurrentFrame(0);
      setRenderFrame(0);
      playheadRef.current = {
        sceneIndex: 0,
        frame: 0,
        renderFrame: 0,
        scrollHoldActive: false,
        scrollElapsedSec: 0,
        completedScrollIds: {},
      };
      const firstActor = loaded.scenes[0]?.actors[0];
      setSelectedEntityId(firstActor?.id || null);
      setSelectedEntityType(firstActor ? 'actor' : null);
      setIsRecordingMovement(false);
      setStatusMessage(
        `Loaded "${sampleFile}" (${loaded.scenes.length} scene${loaded.scenes.length > 1 ? 's' : ''}, ${loaded.scenes[0]?.audios.length || 0} audio/MIDI cues)!`
      );
    } catch (err) {
      console.error(err);
      void sound3DMM.playUiWav('ALERT2.WAV');
      setStatusMessage(`Failed to decode ${sampleFile}.`);
    }
  };

  const handleGenerateAiMovie = async () => {
    if (isGeneratingAi) return;
    setAiError(null);
    setIsGeneratingAi(true);
    setStatusMessage('Asking Gemini AI director to write a plot & stage your 3DMM movie...');
    try {
      const generated = await generateAiMovie({
        prompt: aiPrompt,
        catalog,
        soundCatalog,
      });
      sound3DMM.stopAll();
      setIsPlaying(false);
      setMovie(generated);
      setCurrentSceneIndex(0);
      setCurrentFrame(0);
      setRenderFrame(0);
      playheadRef.current = {
        sceneIndex: 0,
        frame: 0,
        renderFrame: 0,
        scrollHoldActive: false,
        scrollElapsedSec: 0,
        completedScrollIds: {},
      };
      const firstScene = generated.scenes[0];
      const firstEntity = firstScene?.actors[0] || firstScene?.props[0] || firstScene?.tdtTexts?.[0];
      setSelectedEntityId(firstEntity?.id || null);
      setSelectedEntityType(
        firstScene?.actors[0]
          ? 'actor'
          : firstScene?.props[0]
          ? 'prop'
          : firstScene?.tdtTexts?.[0]
          ? 'tdt'
          : null
      );
      setIsRecordingMovement(false);
      setShowPlotBanner(Boolean(generated.plot));
      setShowAiModal(false);
      setMobileTab('stage');
      void sound3DMM.playUiWav('FNEW.WAV');
      setStatusMessage(
        `AI created "${generated.title}" (${generated.scenes.length} scenes) — press Play to watch!`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to generate AI movie.';
      setAiError(msg);
      void sound3DMM.playUiWav('ALERT2.WAV');
      setStatusMessage(`AI Movie generation failed: ${msg}`);
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const totalSceneObjects = currentScene
    ? currentScene.actors.length +
      currentScene.props.length +
      (currentScene.tdtTexts?.length || 0) +
      (currentScene.textBoxes?.length || 0)
    : 0;

  const activeViewSlot =
    activeCatalogScene && activeCatalogScene.views.length > 0
      ? activeCatalogScene.views.findIndex((v) => v.icam === activeCamAtFrame.icam)
      : -1;
  const activeViewNumber =
    activeViewSlot >= 0 ? activeViewSlot + 1 : activeCamAtFrame.icam + 1;

  return (
    <div className="studio-app-shell bg-[#16092e] select-none">
      <input
        ref={fileInputRef}
        type="file"
        accept=".3mm"
        onChange={handleLoadFile}
        className="hidden"
      />

      {/* Original 3DMM Studio Header Strip */}
      <header className="bg-gradient-to-r from-[#3e1d7a] via-[#5428a3] to-[#3e1d7a] border-b-2 border-[#120624] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-white shrink-0">
        <div className="flex items-center gap-2.5">
          <img
            src={assetUrl('3dmm/bmp/4NEW.BMP')}
            alt="3D Movie Maker"
            className="h-6 w-auto object-contain image-rendering-pixelated"
          />
          <span className="font-bold text-sm text-amber-300 tracking-wide">
            3D Movie Maker
          </span>
          <input
            type="text"
            value={movie.title}
            onChange={(e) => setMovie({ ...movie, title: e.target.value })}
            aria-label="Movie Title"
            className="studio-well px-2 py-0.5 text-xs font-bold text-amber-100 w-36 sm:w-44 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={handleNewBlankMovie}
            title="Start a completely blank movie (black screen until you add a scene)"
            className="studio-btn px-2.5 py-1 font-bold flex items-center gap-1.5 text-rose-200"
          >
            <FilePlus size={13} />
            <span>New</span>
          </button>

          <button
            onClick={() => {
              void sound3DMM.playUiWav('MAPOPEN.WAV');
              setShowSamplesModal(true);
            }}
            className="studio-btn px-2.5 py-1 font-bold flex items-center gap-1.5 text-amber-200"
          >
            <Film size={13} />
            <span>Sample Movies (.3MM)</span>
          </button>

          <button
            onClick={() => {
              setAiError(null);
              void sound3DMM.playUiWav('TBKOPEN.WAV');
              setShowAiModal(true);
            }}
            disabled={catalog.scenes.length === 0}
            title="Have Gemini AI direct a full 3DMM movie with plot, scenes, moving actors & props, camera cuts, and 2D/3D text"
            className="bg-gradient-to-b from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 disabled:opacity-45 disabled:cursor-not-allowed border-t-2 border-l-2 border-amber-200 border-r-2 border-b-2 border-r-orange-950 border-b-orange-950 px-2.5 py-1 font-bold flex items-center gap-1.5 text-[#1a0a2e] shadow"
          >
            <Sparkles size={13} />
            <span>AI Make Movie</span>
          </button>

          {movie.plot && (
            <button
              onClick={() => setShowPlotBanner((prev) => !prev)}
              title="Show or hide the movie plot summary"
              className={`studio-btn px-2 py-1 font-bold flex items-center gap-1 ${
                showPlotBanner ? 'text-amber-300 border-amber-400' : 'text-purple-200'
              }`}
            >
              <BookOpen size={13} />
              <span>Plot</span>
            </button>
          )}

          <button
            onClick={() => fileInputRef.current?.click()}
            className="studio-btn px-2.5 py-1 font-bold flex items-center gap-1.5 text-cyan-200"
          >
            <FolderOpen size={13} />
            <span>Open .3mm</span>
          </button>

          <button
            onClick={() => void handleSaveMovie3MM()}
            disabled={isSaving || !hasScene}
            className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-45 disabled:cursor-not-allowed border-t-2 border-l-2 border-emerald-400 border-r-2 border-b-2 border-r-emerald-950 border-b-emerald-950 px-2.5 py-1 font-bold flex items-center gap-1.5 text-white shadow"
          >
            <Save size={13} />
            <span>{isSaving ? 'Saving...' : 'Save .3mm'}</span>
          </button>

          <button
            onClick={() => {
              void sound3DMM.playUiWav('DROPDN.WAV');
              setShowSettingsModal(true);
            }}
            title="Rendering & Playback Settings (Shading & Interpolation)"
            className={`studio-btn px-2.5 py-1 font-bold flex items-center gap-1.5 ${
              enableInterpolation || enableShading
                ? 'text-amber-300 border-amber-400'
                : 'text-purple-100'
            }`}
          >
            <Settings size={13} />
            <span>Settings</span>
          </button>
        </div>
      </header>

      {/* Real Scenes Strip — Always enabled so user can add Scene 1 in a blank movie */}
      <SceneBar
        scenes={movie.scenes}
        catalogScenes={catalog.scenes}
        currentSceneIndex={currentSceneIndex}
        onSelectScene={(idx) => {
          sound3DMM.stopMusic();
          setIsPlaying(false);
          setCurrentSceneIndex(idx);
          setCurrentFrame(0);
          setRenderFrame(0);
          playheadRef.current = {
            sceneIndex: idx,
            frame: 0,
            renderFrame: 0,
            scrollHoldActive: false,
            scrollElapsedSec: 0,
            completedScrollIds: {},
          };
          setSelectedEntityId(null);
          setSelectedEntityType(null);
          setIsRecordingMovement(false);
        }}
        onAddOrOverwriteScene={handleAddOrOverwriteScene}
        onUpdateCurrentScene={handleUpdateCurrentScene}
      />

      {movie.plot && showPlotBanner && (
        <div className="bg-[#231048] border-b border-[#120624] px-3 py-1.5 text-[11px] text-amber-100 flex items-start justify-between gap-2 shrink-0 max-h-20 overflow-y-auto">
          <div className="flex items-start gap-2 min-w-0">
            <BookOpen size={13} className="text-amber-300 shrink-0 mt-0.5" />
            <p className="leading-snug">
              <span className="font-bold text-amber-300 mr-1.5">Plot:</span>
              {movie.plot}
            </p>
          </div>
          <button
            onClick={() => setShowPlotBanner(false)}
            aria-label="Hide Plot"
            className="studio-btn px-1.5 py-0.5 text-[10px] shrink-0"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {!hasScene ? (
        /* Blank Movie: pure black screen with no object-adding or sound-adding buttons */
        <div className="flex-1 bg-black" />
      ) : (
        <>
          {/* Real Camera Views Strip (Supports mid-scene cuts!) */}
          <CameraAngleBar
            currentFrame={currentFrame}
            currentViewIndex={activeCamAtFrame.icam}
            cameraCuts={currentScene!.cameraCuts}
            catalogViews={activeCatalogScene?.views || []}
            onSelectCameraView={handleSelectCameraView}
            onDeleteCameraCutAtFrame={handleDeleteCameraCutAtFrame}
          />

          {/* Mobile Stage / Cast Switcher */}
          <div className="flex md:hidden border-b border-[#120624] bg-[#231047] p-1 gap-1 text-xs shrink-0">
            <button
              onClick={() => setMobileTab('stage')}
              className={`flex-1 py-1 font-bold ${
                mobileTab === 'stage'
                  ? 'bg-[#6b36c4] border border-amber-300 text-white'
                  : 'studio-btn text-purple-100'
              }`}
            >
              🎬 3D Stage
            </button>
            <button
              onClick={() => setMobileTab('cast')}
              className={`flex-1 py-1 font-bold ${
                mobileTab === 'cast'
                  ? 'bg-[#6b36c4] border border-amber-300 text-white'
                  : 'studio-btn text-purple-100'
              }`}
            >
              🎭 Cast & Props ({totalSceneObjects})
            </button>
          </div>

          {/* Main Studio Workspace */}
          <div className="flex-1 min-h-0 min-w-0 flex flex-col md:flex-row overflow-hidden relative">
            <div className={`flex-1 min-h-0 min-w-0 relative ${mobileTab === 'stage' ? 'flex' : 'hidden md:flex'}`}>
              <Viewport3D
                sceneData={currentScene!}
                sceneIndex={currentSceneIndex}
                totalScenes={movie.scenes.length}
                activeViewNumber={activeViewNumber}
                currentFrame={currentFrame}
                renderFrame={renderFrame}
                isPlaying={isPlaying}
                enableInterpolation={enableInterpolation}
                enableShading={enableShading}
                livePlayheadRef={playheadRef}
                selectedEntityId={selectedEntityId}
                onSelectEntity={(id, type) => {
                  setSelectedEntityId(id);
                  setSelectedEntityType(type);
                }}
                onStageViewReady={(bgView) => {
                  stageViewRef.current = bgView;
                }}
                moveUpDownMode={moveUpDownMode}
                onToggleMoveUpDown={() => {
                  setMoveUpDownMode((prev) => {
                    const next = !prev;
                    if (next) setRotateMode(false);
                    setStatusMessage(
                      next
                        ? 'Up & Down drag ON: drags move vertically (Up/Down) & sideways (Left/Right) — press ArrowUp/ArrowDown anytime.'
                        : 'Up & Down drag OFF: standard ground-plane movement.'
                    );
                    return next;
                  });
                }}
                rotateMode={rotateMode}
                onToggleRotateMode={() => {
                  setRotateMode((prev) => {
                    const next = !prev;
                    if (next) setMoveUpDownMode(false);
                    setStatusMessage(
                      next
                        ? '3D Rotate drag ON: drag Left/Right to turn Y, Up/Down to tilt X, Shift+drag to roll Z.'
                        : '3D Rotate drag OFF.'
                    );
                    return next;
                  });
                }}
                isRecordingMovement={isRecordingMovement}
                onBeginRecordingAtFrame={handleBeginRecordingAtFrame}
                onRecordMovementStep={handleRecordMovementStep}
                onMoveEntityAtFrame={handleMoveEntityAtFrame}
              />
            </div>

            <div className={`${mobileTab === 'cast' ? 'flex flex-1 min-h-0 min-w-0 w-full' : 'hidden md:flex md:min-h-0'}`}>
              <ActorPropPanel
                currentFrame={currentFrame}
                totalFrames={currentScene!.totalFrames}
                onSeekFrame={handleSeekFrame}
                enableInterpolation={enableInterpolation}
                catalogActors={catalog.actors}
                catalogProps={catalog.props}
                actors={currentScene!.actors}
                props={currentScene!.props}
                tdtTexts={currentScene!.tdtTexts || []}
                textBoxes={currentScene!.textBoxes || []}
                selectedEntityId={selectedEntityId}
                selectedEntityType={selectedEntityType}
                onSelectEntity={(id, type) => {
                  setSelectedEntityId(id);
                  setSelectedEntityType(type);
                  if (window.innerWidth < 768 && type !== 'tbox') setMobileTab('stage');
                }}
                onAddActor={handleAddActor}
                onAddProp={(item) => void handleAddProp(item)}
                onUpdateActorAction={handleUpdateActorAction}
                onUpdateActorCostume={handleUpdateActorCostume}
                onUpdatePropAction={handleUpdatePropAction}
                onUpdatePropCostume={handleUpdatePropCostume}
                onUpdateTdtAction={handleUpdateTdtAction}
                onUpdateEntityColor={handleUpdateEntityColor}
                onUpdateEntityRotation={handleUpdateEntityRotation}
                onUpdateEntityScale={handleUpdateEntityScale}
                onSetEntityFrame={handleSetEntityFrame}
                onRemoveEntityKeyframe={handleRemoveEntityKeyframe}
                onToggleEntityVisibility={handleToggleEntityVisibility}
                onUpdateEntityPoseCel={handleUpdateEntityPoseCel}
                onAddTdtText={handleAddTdtText}
                onUpdateTdtText={handleUpdateTdtText}
                onAddTextBox={handleAddTextBox}
                onUpdateTextBox={handleUpdateTextBox}
                isRecordingMovement={isRecordingMovement}
                onToggleRecordingMovement={handleToggleRecordingMovement}
                onClearKeyframes={handleClearKeyframes}
                onDeleteEntity={handleDeleteEntity}
              />
            </div>
          </div>

          {/* Timeline & Sound/MIDI Cues */}
          <TimelineBar
            currentFrame={currentFrame}
            totalFrames={currentScene!.totalFrames}
            isPlaying={isPlaying}
            onTogglePlay={handleTogglePlay}
            onSeekFrame={handleSeekFrame}
            onRewind={() => {
              sound3DMM.stopAll();
              setIsPlaying(false);
              if (currentFrame === 0 && currentSceneIndex > 0) {
                setCurrentSceneIndex(0);
                setRenderFrame(0);
                playheadRef.current = {
                  sceneIndex: 0,
                  frame: 0,
                  renderFrame: 0,
                  scrollHoldActive: false,
                  scrollElapsedSec: 0,
                  completedScrollIds: {},
                };
                setSelectedEntityId(null);
                setSelectedEntityType(null);
              } else {
                setCurrentFrame(0);
                setRenderFrame(0);
                playheadRef.current.frame = 0;
                playheadRef.current.renderFrame = 0;
                playheadRef.current.scrollHoldActive = false;
                playheadRef.current.scrollElapsedSec = 0;
                playheadRef.current.completedScrollIds = {};
              }
            }}
            onOpenAudioModal={() => setIsAudioModalOpen(true)}
            audioCues={currentScene!.audios}
            cameraCuts={currentScene!.cameraCuts}
            onDeleteAudioCue={handleDeleteAudioCue}
          />
        </>
      )}

      {/* Footer Info Strip */}
      <div className="bg-[#180a33] border-t-2 border-[#120624] px-3 py-1 text-[11px] text-purple-200 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 shrink-0 min-w-0">
        <span className="truncate max-w-full">{statusMessage}</span>
        <span className="font-mono text-amber-300 text-[10px] sm:text-[11px] break-words">
          {currentScene
            ? `Actors: ${currentScene.actors.length} | Props: ${currentScene.props.length} | 3D Words: ${currentScene.tdtTexts?.length || 0} | 2D Text: ${currentScene.textBoxes?.length || 0} | Sounds: ${currentScene.audios.length}`
            : 'Blank Movie (0 Scenes)'}
        </span>
      </div>

      {/* 21 Authentic .3MM Sample Movies Modal */}
      {showSamplesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="studio-panel p-4 max-w-lg w-full text-xs text-white max-h-[90dvh] flex flex-col">
            <div className="flex items-center justify-between pb-2.5 border-b border-purple-700/80 shrink-0">
              <div className="flex items-center gap-2 font-bold text-sm text-amber-300">
                <Film size={16} />
                <span>Official 3DMM Sample Movies (21 .3MM Files)</span>
              </div>
              <button
                onClick={() => setShowSamplesModal(false)}
                className="studio-btn px-2 py-0.5 font-bold"
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3 overflow-y-auto pr-1">
              {OFFICIAL_SAMPLE_MOVIES.map((m) => (
                <button
                  key={m.file}
                  onClick={() => void handleLoadSample3mm(m.file, m.label)}
                  className="studio-btn p-2 text-left flex flex-col gap-0.5"
                >
                  <span className="font-bold text-amber-200">{m.label}</span>
                  <span className="text-[10px] text-purple-200 font-mono">{m.file}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Gemini AI Movie Generator Modal */}
      {showAiModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3">
          <div className="studio-panel p-4 max-w-lg w-full text-xs text-white max-h-[92dvh] flex flex-col gap-3 overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-purple-700/80 shrink-0">
              <div className="flex items-center gap-2 font-bold text-sm text-amber-300">
                <Sparkles size={16} />
                <span>AI Movie Director (Gemini)</span>
              </div>
              <button
                onClick={() => !isGeneratingAi && setShowAiModal(false)}
                disabled={isGeneratingAi}
                className="studio-btn px-2 py-0.5 font-bold disabled:opacity-45"
              >
                ✕
              </button>
            </div>

            <p className="text-[11px] text-purple-100 leading-relaxed">
              Gemini will write a movie plot and automatically build scenes with authentic 3DMM actors,
              actions &amp; movement keyframes, animated props, camera angle cuts, sound/MIDI cues, and
              optional 2D/3D text.
            </p>

            <div className="flex flex-col gap-1">
              <label htmlFor="ai-movie-prompt" className="font-bold text-amber-200 text-[11px]">
                Story Idea (optional — leave blank for a surprise):
              </label>
              <textarea
                id="ai-movie-prompt"
                rows={3}
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                disabled={isGeneratingAi}
                placeholder="e.g. Bongo discovers a secret treasure chest in the haunted castle while a sneaky skeleton chases him before a rocket blasts off..."
                className="studio-well p-2 text-xs text-white placeholder:text-purple-300/60 focus:outline-none resize-y"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {[
                'Haunted castle treasure heist with spooky chase',
                'Diner alien invasion & rocket escape',
                'Space station dance party gone wrong',
                'Detective mystery in the dark alley',
              ].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={isGeneratingAi}
                  onClick={() => setAiPrompt(preset)}
                  className="studio-btn px-2 py-1 text-[10px] text-purple-100 text-left disabled:opacity-45"
                >
                  {preset}
                </button>
              ))}
            </div>

            {aiError && (
              <div className="bg-rose-950/80 border border-rose-500 px-2.5 py-2 text-[11px] text-rose-200">
                {aiError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1 border-t border-purple-800/70">
              <button
                type="button"
                disabled={isGeneratingAi}
                onClick={() => setShowAiModal(false)}
                className="studio-btn px-3 py-1.5 font-bold text-purple-100 disabled:opacity-45"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isGeneratingAi || catalog.scenes.length === 0}
                onClick={() => void handleGenerateAiMovie()}
                className="bg-gradient-to-b from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 disabled:opacity-55 border-t-2 border-l-2 border-amber-200 border-r-2 border-b-2 border-r-orange-950 border-b-orange-950 px-3.5 py-1.5 font-bold flex items-center gap-1.5 text-[#1a0a2e] shadow"
              >
                <Sparkles size={13} />
                <span>{isGeneratingAi ? 'Directing Movie...' : 'Generate Movie'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Studio Settings Modal (Shading & Interpolation — Both OFF by default) */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="studio-panel p-4 max-w-md w-full text-xs text-white flex flex-col gap-3">
            <div className="flex items-center justify-between pb-2 border-b border-purple-700/80">
              <div className="flex items-center gap-2 font-bold text-sm text-amber-300">
                <Settings size={16} />
                <span>Studio Rendering &amp; Playback Settings</span>
              </div>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="studio-btn px-2 py-0.5 font-bold"
              >
                ✕
              </button>
            </div>

            <label className="studio-well p-2.5 flex items-start justify-between gap-3 cursor-pointer">
              <div className="flex flex-col gap-0.5">
                <span className="font-bold text-amber-200 text-xs">Smooth Shading &amp; Shadows</span>
                <span className="text-[11px] text-purple-200 leading-snug">
                  When OFF (default), untextured objects use classic flat shading (textured objects stay smooth) with no floor shadows. Turn ON for smooth shading &amp; shadows.
                </span>
              </div>
              <input
                type="checkbox"
                checked={enableShading}
                onChange={(e) => {
                  const next = e.target.checked;
                  setEnableShading(next);
                  setStatusMessage(`Settings: ${next ? 'Smooth Shading & Shadows ON' : 'Flat Shading (untextured objects) / Shadows OFF'}.`);
                }}
                className="mt-1 w-4 h-4 accent-amber-400 shrink-0 cursor-pointer"
              />
            </label>

            <label className="studio-well p-2.5 flex items-start justify-between gap-3 cursor-pointer">
              <div className="flex flex-col gap-0.5">
                <span className="font-bold text-cyan-200 text-xs">Interpolation (Sub-frame Tweening)</span>
                <span className="text-[11px] text-purple-200 leading-snug">
                  When OFF (default), poses, keyframes &amp; 3D word animations step sharply at classic 6 FPS frames. Turn ON for smooth sub-frame tweening.
                </span>
              </div>
              <input
                type="checkbox"
                checked={enableInterpolation}
                onChange={(e) => {
                  const next = e.target.checked;
                  setEnableInterpolation(next);
                  setStatusMessage(`Settings: Interpolation ${next ? 'ON' : 'OFF (No Interpolation)'}.`);
                }}
                className="mt-1 w-4 h-4 accent-cyan-400 shrink-0 cursor-pointer"
              />
            </label>

            <div className="flex items-center justify-between pt-2 border-t border-purple-800/70">
              <button
                type="button"
                onClick={() => {
                  setEnableShading(false);
                  setEnableInterpolation(false);
                  setStatusMessage('Reset settings to defaults: No Shading & No Interpolation.');
                }}
                className="studio-btn px-2.5 py-1 text-[11px] text-purple-200"
              >
                Reset Defaults (Both OFF)
              </button>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="bg-emerald-700 hover:bg-emerald-600 border-t-2 border-l-2 border-emerald-400 border-r-2 border-b-2 border-r-emerald-950 border-b-emerald-950 px-3.5 py-1 font-bold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {hasScene && (
        <AudioImportModal
          currentFrame={currentFrame}
          isOpen={isAudioModalOpen}
          onClose={() => setIsAudioModalOpen(false)}
          onAddAudioCue={handleAddAudioCue}
        />
      )}
    </div>
  );
}

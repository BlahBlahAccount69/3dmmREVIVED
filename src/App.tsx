import React, { useEffect, useRef, useState } from 'react';
import {
  ActorEntity,
  CameraAngle,
  CameraCutEvent,
  ImportedAudioCue,
  KeyframePosition,
  Movie,
  PropAction,
  PropEntity,
  Scene,
} from './types/movie';
import { createDefaultMovie, createEmptyScene } from './services/defaultMovie';
import {
  CatalogActorItem,
  CatalogPropItem,
  CatalogSceneItem,
  LoadedBackgroundView,
  loadThreeDmmCatalog,
  preloadThreeDmmAssets,
  ThreeDmmCatalog,
} from './services/threeDmmEngine';
import { loadOfficial3mmMovie, OFFICIAL_SAMPLE_MOVIES } from './services/movie3mmParser';
import { sound3DMM } from './services/soundLibrary';
import {
  resolveActiveCameraAtFrame,
  resolveInterpolatedKeyframe,
  Viewport3D,
} from './components/Viewport3D';
import { SceneBar } from './components/SceneBar';
import { CameraAngleBar } from './components/CameraAngleBar';
import { ActorPropPanel } from './components/ActorPropPanel';
import { TimelineBar } from './components/TimelineBar';
import { AudioImportModal } from './components/AudioImportModal';
import { Film, FolderOpen, Save } from 'lucide-react';

export default function App() {
  const [movie, setMovie] = useState<Movie>(createDefaultMovie);
  const [catalog, setCatalog] = useState<ThreeDmmCatalog>({
    actors: [],
    props: [],
    scenes: [],
  });
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [selectedEntityId, setSelectedEntityId] = useState<string | null>('actor_bongo_1');
  const [selectedEntityType, setSelectedEntityType] = useState<'actor' | 'prop' | null>('actor');

  const [isRecordingMovement, setIsRecordingMovement] = useState(false);
  const [mobileTab, setMobileTab] = useState<'stage' | 'cast'>('stage');
  const [isAudioModalOpen, setIsAudioModalOpen] = useState(false);
  const [showSamplesModal, setShowSamplesModal] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Loading real Microsoft 3DMM assets...');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const stageViewRef = useRef<LoadedBackgroundView | null>(null);

  const currentScene = movie.scenes[currentSceneIndex] || movie.scenes[0];
  const activeCatalogScene =
    catalog.scenes.find((s) => s.bkgdCno === currentScene.bkgdCno) || catalog.scenes[0];
  const activeCamAtFrame = resolveActiveCameraAtFrame(currentScene, currentFrame);

  const movieRef = useRef(movie);
  movieRef.current = movie;
  const playheadRef = useRef({ sceneIndex: currentSceneIndex, frame: currentFrame });
  playheadRef.current = { sceneIndex: currentSceneIndex, frame: currentFrame };

  // Load real 3DMM Catalog & preload scenes, views, templates, sound catalog, UI WAVs, and MS GS Wavetable SoundFont
  useEffect(() => {
    void sound3DMM.loadSoundCatalog();
    sound3DMM.preloadUiWavs([
      'CANCEL.WAV', 'GOFRSTF.WAV', 'GOPREVF.WAV', 'GONEXTF.WAV', 'PLAY.WAV', 'STOP.WAV',
      'REMACTR.WAV', 'TBKOPEN.WAV', 'MOVE.WAV', 'GROW.WAV', 'SQUASH.WAV', 'SHRINK.WAV',
      'DROPDN.WAV', 'PSELECT.WAV', 'SACT.WAV', 'COSTUME.WAV', 'SPIN.WAV', 'ACESORY.WAV',
      'ADDFRAME.WAV', 'CBACKS.WAV', 'RECFRAME.WAV', 'FSAVE.WAV', 'FNEW.WAV', 'ALERT2.WAV',
      'MAPOPEN.WAV',
    ]);
    void fetch('/3dmm/soundfont/MS_GS_Wavetable.sf2').catch(() => {});

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
        setStatusMessage('Error loading 3DMM assets from /3dmm/3dmovie/.');
      });
  }, []);

  const triggerAudiosForFrame = (scene: Scene | undefined, frame: number) => {
    if (!scene) return;
    const cues = scene.audios.filter((a) => a.frame === frame);
    for (const cue of cues) {
      void sound3DMM.playCue(cue);
    }
  };

  // Multi-scene authentic 6 FPS Playback (#define kfps 6 in SOCDEF.H)
  useEffect(() => {
    if (!isPlaying) return;

    const intervalId = window.setInterval(() => {
      const scenes = movieRef.current.scenes;
      if (!scenes || scenes.length === 0) return;

      let { sceneIndex, frame } = playheadRef.current;
      if (sceneIndex < 0 || sceneIndex >= scenes.length) sceneIndex = 0;

      const activeScene = scenes[sceneIndex];
      let nextFrame = frame + 1;
      let nextSceneIndex = sceneIndex;

      if (nextFrame > activeScene.totalFrames) {
        nextSceneIndex = (sceneIndex + 1) % scenes.length;
        nextFrame = 0;
        sound3DMM.stopMusic();
      }

      playheadRef.current = { sceneIndex: nextSceneIndex, frame: nextFrame };

      if (nextSceneIndex !== sceneIndex) {
        setCurrentSceneIndex(nextSceneIndex);
        setSelectedEntityId(null);
        setSelectedEntityType(null);
        setStatusMessage(
          `Playing Scene ${nextSceneIndex + 1}/${scenes.length}: ${scenes[nextSceneIndex].sceneName}`
        );
      }
      setCurrentFrame(nextFrame);
      triggerAudiosForFrame(scenes[nextSceneIndex], nextFrame);
    }, 1000 / 6);

    return () => window.clearInterval(intervalId);
  }, [isPlaying]);

  const handleTogglePlay = () => {
    if (isPlaying) {
      sound3DMM.stopAll();
      setIsPlaying(false);
      return;
    }
    setIsRecordingMovement(false);
    if (currentFrame === 0 && currentScene) {
      triggerAudiosForFrame(currentScene, 0);
    }
    setIsPlaying(true);
  };

  const handleSeekFrame = (frame: number) => {
    setCurrentFrame(frame);
    triggerAudiosForFrame(currentScene, frame);
  };

  // Add Scene Next Rule: add next if scene has actors/props, overwrite if empty
  const handleAddOrOverwriteScene = (chosen: CatalogSceneItem) => {
    sound3DMM.stopMusic();
    const hasEntities = currentScene.actors.length > 0 || currentScene.props.length > 0;
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
      setSelectedEntityId(null);
      setSelectedEntityType(null);
      setIsRecordingMovement(false);
      setStatusMessage(`Added scene ${chosen.name} next to Scene ${currentSceneIndex + 1}.`);
    }
  };

  const handleUpdateCurrentScene = (chosen: CatalogSceneItem) => {
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
          : [{ frame: 0, icam: currentScene.icam, yaw: currentScene.cameraAngle.yaw, pitch: currentScene.cameraAngle.pitch }];
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

  const handleChangeCameraAngle = (angle: CameraAngle) => {
    const updated = [...movie.scenes];
    if (currentFrame === 0 && (!currentScene.cameraCuts || currentScene.cameraCuts.length === 0)) {
      updated[currentSceneIndex] = {
        ...currentScene,
        cameraAngle: angle,
      };
    } else {
      const baseCuts: CameraCutEvent[] =
        currentScene.cameraCuts && currentScene.cameraCuts.length > 0
          ? [...currentScene.cameraCuts]
          : [{ frame: 0, icam: currentScene.icam, yaw: currentScene.cameraAngle.yaw, pitch: currentScene.cameraAngle.pitch }];
      const idx = baseCuts.findIndex((c) => c.frame === currentFrame);
      const activeCam = resolveActiveCameraAtFrame(currentScene, currentFrame);
      const nextCut: CameraCutEvent = {
        frame: currentFrame,
        icam: activeCam.icam,
        yaw: angle.yaw,
        pitch: angle.pitch,
      };
      if (idx >= 0) baseCuts[idx] = nextCut;
      else baseCuts.push(nextCut);
      baseCuts.sort((a, b) => a.frame - b.frame);
      updated[currentSceneIndex] = {
        ...currentScene,
        cameraAngle: currentFrame === 0 ? angle : currentScene.cameraAngle,
        cameraCuts: baseCuts,
      };
    }
    setMovie({ ...movie, scenes: updated });
  };

  const handleDeleteCameraCutAtFrame = (frame: number) => {
    if (!currentScene.cameraCuts) return;
    const filtered = currentScene.cameraCuts.filter((c) => c.frame !== frame);
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      cameraCuts: filtered.length > 0 ? filtered : undefined,
    };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Removed camera cut at Frame ${frame}.`);
  };

  // Place new actor/prop using Camera-Aligned Stage Space (or world APOS for imported .3MM scenes)
  const computePlacementForCurrentView = (slot: number): KeyframePosition => {
    const offsets = [0, 3.8, -3.8, 7.2, -7.2];
    const lateralStep = offsets[slot % offsets.length];
    const depthStep = -Math.floor(slot / offsets.length) * 3.2;

    if (currentScene.coordMode !== 'world') {
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
    const slot = currentScene.actors.length + currentScene.props.length;
    const pos = computePlacementForCurrentView(slot);
    const newActor: ActorEntity = {
      id: 'actor_' + Math.random().toString(36).substring(2, 9),
      tmplCno: item.tmplCno,
      name: item.name,
      anid: 0, // Strictly default At Rest
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

  const handleAddProp = (item: CatalogPropItem) => {
    const slot = currentScene.actors.length + currentScene.props.length;
    const pos = computePlacementForCurrentView(slot);
    const newProp: PropEntity = {
      id: 'prop_' + Math.random().toString(36).substring(2, 9),
      tmplCno: item.tmplCno,
      name: item.name,
      action: 'at rest',
      keyframes: {
        [currentFrame]: { ...pos, rotY: 0 },
      },
    };
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      props: [...currentScene.props, newProp],
    };
    setMovie({ ...movie, scenes: updated });
    setSelectedEntityId(newProp.id);
    setSelectedEntityType('prop');
    setMobileTab('stage');
    setStatusMessage(`Placed prop "${item.name}" in Camera #${activeCamAtFrame.icam + 1}.`);
  };

  // Supports per-frame action switching for Actors!
  const handleUpdateActorAction = (id: string, anid: number, actionName: string) => {
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      actors: currentScene.actors.map((a) => {
        if (a.id !== id) return a;
        const nextMap: Record<number, { anid: number; actionName: string }> = {
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
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      actors: currentScene.actors.map((a) =>
        a.id === id ? { ...a, costumeCmids } : a
      ),
    };
    setMovie({ ...movie, scenes: updated });
  };

  // Supports per-frame action switching for Props!
  const handleUpdatePropAction = (id: string, action: PropAction) => {
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      props: currentScene.props.map((p) => {
        if (p.id !== id) return p;
        const nextMap: Record<number, { action: PropAction }> = {
          ...(p.actionKeyframes || { 0: { action: p.action } }),
          [currentFrame]: { action },
        };
        return {
          ...p,
          action: currentFrame === 0 ? action : p.action,
          actionKeyframes: nextMap,
        };
      }),
    };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Set prop action "${action}" at Frame ${currentFrame}.`);
  };

  const handleToggleRecordingMovement = () => {
    if (!selectedEntityId) return;
    const next = !isRecordingMovement;
    void sound3DMM.playUiWav('RECFRAME.WAV');
    if (next) {
      setIsPlaying(false);
      setMobileTab('stage');
      setStatusMessage(`Recording motion at 6 FPS from Frame ${currentFrame} — drag entity!`);
    } else {
      setStatusMessage('Stopped recording movement.');
    }
    setIsRecordingMovement(next);
  };

  const handleBeginRecordingAtFrame = (
    entityId: string,
    type: 'actor' | 'prop',
    startFrame: number,
    pos: { x: number; y: number; z: number; rotY: number }
  ) => {
    setIsPlaying(false);
    setMovie((prev) => {
      const idx = playheadRef.current.sceneIndex;
      const sc = prev.scenes[idx];
      if (!sc) return prev;
      const truncate = (kfs: Record<number, KeyframePosition>) => {
        const cur = resolveInterpolatedKeyframe(kfs, startFrame);
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
          visible: cur.visible === false ? true : cur.visible,
        };
        return out;
      };
      const updatedScenes = [...prev.scenes];
      updatedScenes[idx] =
        type === 'actor'
          ? {
              ...sc,
              totalFrames: Math.max(sc.totalFrames, startFrame),
              actors: sc.actors.map((a) =>
                a.id === entityId ? { ...a, keyframes: truncate(a.keyframes) } : a
              ),
            }
          : {
              ...sc,
              totalFrames: Math.max(sc.totalFrames, startFrame),
              props: sc.props.map((p) =>
                p.id === entityId ? { ...p, keyframes: truncate(p.keyframes) } : p
              ),
            };
      return { ...prev, scenes: updatedScenes };
    });
  };

  const handleRecordMovementStep = (
    entityId: string,
    type: 'actor' | 'prop',
    frame: number,
    pos: { x: number; y: number; z: number; rotY: number },
    advancePlayhead: boolean
  ) => {
    setMovie((prev) => {
      const idx = playheadRef.current.sceneIndex;
      const sc = prev.scenes[idx];
      if (!sc) return prev;
      const write = (kfs: Record<number, KeyframePosition>) => {
        const cur = resolveInterpolatedKeyframe(kfs, frame);
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
          visible: cur.visible === false ? true : cur.visible,
        };
        return out;
      };
      const updatedScenes = [...prev.scenes];
      updatedScenes[idx] =
        type === 'actor'
          ? {
              ...sc,
              totalFrames: Math.max(sc.totalFrames, frame),
              actors: sc.actors.map((a) =>
                a.id === entityId ? { ...a, keyframes: write(a.keyframes) } : a
              ),
            }
          : {
              ...sc,
              totalFrames: Math.max(sc.totalFrames, frame),
              props: sc.props.map((p) =>
                p.id === entityId ? { ...p, keyframes: write(p.keyframes) } : p
              ),
            };
      return { ...prev, scenes: updatedScenes };
    });

    if (advancePlayhead) {
      playheadRef.current = { sceneIndex: playheadRef.current.sceneIndex, frame };
      setCurrentFrame(frame);
      triggerAudiosForFrame(movieRef.current.scenes[playheadRef.current.sceneIndex], frame);
    }
  };

  const handleMoveEntityAtFrame = (
    entityId: string,
    type: 'actor' | 'prop',
    frame: number,
    pos: { x: number; y: number; z: number; rotY: number },
    deltaX: number,
    deltaZ: number
  ) => {
    setMovie((prev) => {
      const idx = playheadRef.current.sceneIndex;
      const sc = prev.scenes[idx];
      if (!sc) return prev;
      const shift = (kfs: Record<number, KeyframePosition>) => {
        const cur = resolveInterpolatedKeyframe(kfs, frame);
        const out: Record<number, KeyframePosition> = {};
        Object.entries(kfs).forEach(([k, v]) => {
          const fn = Number(k);
          if (fn < frame) out[fn] = v;
          else if (fn > frame) {
            out[fn] = {
              ...v,
              x: v.x + deltaX,
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
        };
        return out;
      };
      const updatedScenes = [...prev.scenes];
      updatedScenes[idx] =
        type === 'actor'
          ? {
              ...sc,
              actors: sc.actors.map((a) =>
                a.id === entityId ? { ...a, keyframes: shift(a.keyframes) } : a
              ),
            }
          : {
              ...sc,
              props: sc.props.map((p) =>
                p.id === entityId ? { ...p, keyframes: shift(p.keyframes) } : p
              ),
            };
      return { ...prev, scenes: updatedScenes };
    });
  };

  const handleUpdateEntityScale = (
    id: string,
    type: 'actor' | 'prop',
    scaleX: number,
    scaleY: number,
    scaleZ: number
  ) => {
    const sx = Math.max(0.25, Math.min(3.5, scaleX));
    const sy = Math.max(0.25, Math.min(3.5, scaleY));
    const sz = Math.max(0.25, Math.min(3.5, scaleZ));
    const updated = [...movie.scenes];
    const patchKeyframes = (kfs: Record<number, KeyframePosition>) => {
      const cur = resolveInterpolatedKeyframe(kfs, currentFrame);
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
    updated[currentSceneIndex] =
      type === 'actor'
        ? {
            ...currentScene,
            actors: currentScene.actors.map((a) =>
              a.id === id ? { ...a, keyframes: patchKeyframes(a.keyframes) } : a
            ),
          }
        : {
            ...currentScene,
            props: currentScene.props.map((p) =>
              p.id === id ? { ...p, keyframes: patchKeyframes(p.keyframes) } : p
            ),
          };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(
      `Scaled at Frame ${currentFrame} (${sx.toFixed(2)}×${sy.toFixed(2)}×${sz.toFixed(2)}).`
    );
  };

  const handleToggleEntityVisibility = (
    id: string,
    type: 'actor' | 'prop',
    visible: boolean
  ) => {
    const updated = [...movie.scenes];
    const patchKeyframes = (kfs: Record<number, KeyframePosition>) => {
      const cur = resolveInterpolatedKeyframe(kfs, currentFrame);
      return {
        ...kfs,
        [currentFrame]: {
          ...cur,
          visible,
        },
      };
    };
    updated[currentSceneIndex] =
      type === 'actor'
        ? {
            ...currentScene,
            actors: currentScene.actors.map((a) =>
              a.id === id ? { ...a, keyframes: patchKeyframes(a.keyframes) } : a
            ),
          }
        : {
            ...currentScene,
            props: currentScene.props.map((p) =>
              p.id === id ? { ...p, keyframes: patchKeyframes(p.keyframes) } : p
            ),
          };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`${visible ? 'Showed' : 'Hid'} ${type} at Frame ${currentFrame}.`);
  };

  const handleSetEntityFrame = (
    id: string,
    type: 'actor' | 'prop',
    targetFrame: number,
    mode: 'pin' | 'showFrom'
  ) => {
    const tf = Math.max(0, Math.round(targetFrame));
    const updated = [...movie.scenes];
    const patchKeyframes = (kfs: Record<number, KeyframePosition>) => {
      const cur = resolveInterpolatedKeyframe(kfs, currentFrame);
      const next = { ...kfs };
      if (mode === 'showFrom' && tf > 0) {
        if (!next[0]) {
          next[0] = { ...cur, visible: false };
        } else {
          next[0] = { ...next[0], visible: false };
        }
        next[tf] = { ...cur, visible: true };
      } else {
        next[tf] = { ...cur, visible: cur.visible === false ? true : cur.visible };
      }
      return next;
    };

    updated[currentSceneIndex] =
      type === 'actor'
        ? {
            ...currentScene,
            totalFrames: Math.max(currentScene.totalFrames, tf),
            actors: currentScene.actors.map((a) =>
              a.id === id ? { ...a, keyframes: patchKeyframes(a.keyframes) } : a
            ),
          }
        : {
            ...currentScene,
            totalFrames: Math.max(currentScene.totalFrames, tf),
            props: currentScene.props.map((p) =>
              p.id === id ? { ...p, keyframes: patchKeyframes(p.keyframes) } : p
            ),
          };
    setMovie({ ...movie, scenes: updated });
    setCurrentFrame(tf);
    setStatusMessage(
      mode === 'showFrom'
        ? `Set ${type} to enter scene at Frame ${tf}.`
        : `Pinned pose/position at Frame ${tf}.`
    );
  };

  const handleUpdateEntityPoseCel = (
    id: string,
    type: 'actor' | 'prop',
    celOffset: number,
    freeze: boolean
  ) => {
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
          const curAct = prevKey !== undefined ? prevMap[prevKey] : { anid: a.anid, actionName: a.actionName };
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

  const handleClearKeyframes = (id: string, type: 'actor' | 'prop') => {
    const resolveCur = (kfs: Record<number, KeyframePosition>) => {
      return resolveInterpolatedKeyframe(kfs, currentFrame);
    };
    const updated = [...movie.scenes];
    if (type === 'actor') {
      updated[currentSceneIndex] = {
        ...currentScene,
        actors: currentScene.actors.map((a) =>
          a.id === id ? { ...a, keyframes: { 0: resolveCur(a.keyframes) } } : a
        ),
      };
    } else {
      updated[currentSceneIndex] = {
        ...currentScene,
        props: currentScene.props.map((p) =>
          p.id === id ? { ...p, keyframes: { 0: resolveCur(p.keyframes) } } : p
        ),
      };
    }
    setMovie({ ...movie, scenes: updated });
  };

  const handleDeleteEntity = (id: string, type: 'actor' | 'prop') => {
    const updated = [...movie.scenes];
    if (type === 'actor') {
      updated[currentSceneIndex] = {
        ...currentScene,
        actors: currentScene.actors.filter((a) => a.id !== id),
      };
    } else {
      updated[currentSceneIndex] = {
        ...currentScene,
        props: currentScene.props.filter((p) => p.id !== id),
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
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      audios: [...currentScene.audios.filter((a) => a.frame !== cue.frame || a.isMidi !== cue.isMidi), cue],
    };
    setMovie({ ...movie, scenes: updated });
    setStatusMessage(`Added "${cue.filename}" at Frame ${cue.frame}.`);
  };

  const handleDeleteAudioCue = (id: string) => {
    const updated = [...movie.scenes];
    updated[currentSceneIndex] = {
      ...currentScene,
      audios: currentScene.audios.filter((a) => a.id !== id),
    };
    setMovie({ ...movie, scenes: updated });
  };

  const handleSaveMovieJSON = () => {
    void sound3DMM.playUiWav('FSAVE.WAV');
    const jsonString = JSON.stringify(movie, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${movie.title.toLowerCase().replace(/\s+/g, '_')}.3mm.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatusMessage('Saved complete movie + embedded audio/MIDI cues to single .3mm.json.');
  };

  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    sound3DMM.stopAll();
    setIsPlaying(false);

    try {
      if (file.name.toLowerCase().endsWith('.3mm')) {
        setStatusMessage(`Decoding real binary ${file.name}...`);
        const ab = await file.arrayBuffer();
        const loaded = await loadOfficial3mmMovie(ab, file.name);
        void sound3DMM.playUiWav('FNEW.WAV');
        setMovie(loaded);
        setCurrentSceneIndex(0);
        setCurrentFrame(0);
        setSelectedEntityId(loaded.scenes[0]?.actors[0]?.id || null);
        setSelectedEntityType(loaded.scenes[0]?.actors[0] ? 'actor' : null);
        setIsRecordingMovement(false);
        setStatusMessage(`Loaded official binary movie "${loaded.title}"!`);
      } else {
        const text = await file.text();
        const loaded = JSON.parse(text) as Movie;
        if (loaded && loaded.scenes && loaded.scenes.length > 0) {
          void sound3DMM.playUiWav('FNEW.WAV');
          setMovie(loaded);
          setCurrentSceneIndex(0);
          setCurrentFrame(0);
          setSelectedEntityId(loaded.scenes[0]?.actors[0]?.id || null);
          setSelectedEntityType(loaded.scenes[0]?.actors[0] ? 'actor' : null);
          setIsRecordingMovement(false);
          setStatusMessage(`Loaded movie "${loaded.title}".`);
        }
      }
    } catch (err) {
      console.error(err);
      void sound3DMM.playUiWav('ALERT2.WAV');
      setStatusMessage('Error loading movie file.');
    }
  };

  const handleLoadSample3mm = async (sampleFile: string, label: string) => {
    setShowSamplesModal(false);
    sound3DMM.stopAll();
    setIsPlaying(false);
    setStatusMessage(`Loading authentic ${sampleFile}...`);
    try {
      const loaded = await loadOfficial3mmMovie(`/3dmm/samples/${sampleFile}`, label);
      void sound3DMM.playUiWav('FNEW.WAV');
      setMovie(loaded);
      setCurrentSceneIndex(0);
      setCurrentFrame(0);
      setSelectedEntityId(loaded.scenes[0]?.actors[0]?.id || null);
      setSelectedEntityType(loaded.scenes[0]?.actors[0] ? 'actor' : null);
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

  return (
    <div className="w-screen h-screen bg-[#16092e] flex flex-col overflow-hidden select-none">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.3mm"
        onChange={handleLoadFile}
        className="hidden"
      />

      {/* Original 3DMM Studio Header Strip (Browser-Native, No Win95 Window Chrome) */}
      <header className="bg-gradient-to-r from-[#3e1d7a] via-[#5428a3] to-[#3e1d7a] border-b-2 border-[#120624] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-white shrink-0">
        <div className="flex items-center gap-2.5">
          <img
            src="/3dmm/bmp/4NEW.BMP"
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
            onClick={() => fileInputRef.current?.click()}
            className="studio-btn px-2.5 py-1 font-bold flex items-center gap-1.5 text-cyan-200"
          >
            <FolderOpen size={13} />
            <span>Open .3mm / .json</span>
          </button>

          <button
            onClick={handleSaveMovieJSON}
            className="bg-emerald-700 hover:bg-emerald-600 border-t-2 border-l-2 border-emerald-400 border-r-2 border-b-2 border-r-emerald-950 border-b-emerald-950 px-2.5 py-1 font-bold flex items-center gap-1.5 text-white shadow"
          >
            <Save size={13} />
            <span>Save .3mm.json</span>
          </button>
        </div>
      </header>

      {/* Real Scenes Strip */}
      <SceneBar
        scenes={movie.scenes}
        catalogScenes={catalog.scenes}
        currentSceneIndex={currentSceneIndex}
        onSelectScene={(idx) => {
          sound3DMM.stopMusic();
          setIsPlaying(false);
          setCurrentSceneIndex(idx);
          setCurrentFrame(0);
          setSelectedEntityId(null);
          setSelectedEntityType(null);
          setIsRecordingMovement(false);
        }}
        onAddOrOverwriteScene={handleAddOrOverwriteScene}
        onUpdateCurrentScene={handleUpdateCurrentScene}
      />

      {/* Real Camera Views Strip (Supports mid-scene cuts!) */}
      <CameraAngleBar
        currentFrame={currentFrame}
        currentViewIndex={activeCamAtFrame.icam}
        cameraCuts={currentScene.cameraCuts}
        catalogViews={activeCatalogScene?.views || []}
        cameraAngle={{ yaw: activeCamAtFrame.yaw, pitch: activeCamAtFrame.pitch }}
        onSelectCameraView={handleSelectCameraView}
        onChangeCameraAngle={handleChangeCameraAngle}
        onDeleteCameraCutAtFrame={handleDeleteCameraCutAtFrame}
      />

      {/* Mobile Stage / Cast Switcher */}
      <div className="flex md:hidden border-b border-[#120624] bg-[#231047] p-1 gap-1 text-xs shrink-0">
        <button
          onClick={() => setMobileTab('stage')}
          className={`flex-1 py-1 font-bold ${
            mobileTab === 'stage' ? 'bg-[#6b36c4] border border-amber-300 text-white' : 'studio-btn text-purple-100'
          }`}
        >
          🎬 3D Stage
        </button>
        <button
          onClick={() => setMobileTab('cast')}
          className={`flex-1 py-1 font-bold ${
            mobileTab === 'cast' ? 'bg-[#6b36c4] border border-amber-300 text-white' : 'studio-btn text-purple-100'
          }`}
        >
          🎭 Cast & Props ({currentScene.actors.length + currentScene.props.length})
        </button>
      </div>

      {/* Main Studio Workspace */}
      <div className="flex-1 flex overflow-hidden relative">
        <div className={`flex-1 relative ${mobileTab === 'stage' ? 'flex' : 'hidden md:flex'}`}>
          <Viewport3D
            sceneData={currentScene}
            sceneIndex={currentSceneIndex}
            totalScenes={movie.scenes.length}
            currentFrame={currentFrame}
            selectedEntityId={selectedEntityId}
            onSelectEntity={(id, type) => {
              setSelectedEntityId(id);
              setSelectedEntityType(type);
            }}
            onStageViewReady={(bgView) => {
              stageViewRef.current = bgView;
            }}
            isRecordingMovement={isRecordingMovement}
            onBeginRecordingAtFrame={handleBeginRecordingAtFrame}
            onRecordMovementStep={handleRecordMovementStep}
            onMoveEntityAtFrame={handleMoveEntityAtFrame}
          />
        </div>

        <div className={`${mobileTab === 'cast' ? 'flex flex-1 w-full' : 'hidden md:flex'}`}>
          <ActorPropPanel
            currentFrame={currentFrame}
            totalFrames={currentScene.totalFrames}
            onSeekFrame={handleSeekFrame}
            catalogActors={catalog.actors}
            catalogProps={catalog.props}
            actors={currentScene.actors}
            props={currentScene.props}
            selectedEntityId={selectedEntityId}
            selectedEntityType={selectedEntityType}
            onSelectEntity={(id, type) => {
              setSelectedEntityId(id);
              setSelectedEntityType(type);
              if (window.innerWidth < 768) setMobileTab('stage');
            }}
            onAddActor={handleAddActor}
            onAddProp={handleAddProp}
            onUpdateActorAction={handleUpdateActorAction}
            onUpdateActorCostume={handleUpdateActorCostume}
            onUpdatePropAction={handleUpdatePropAction}
            onUpdateEntityScale={handleUpdateEntityScale}
            onSetEntityFrame={handleSetEntityFrame}
            onToggleEntityVisibility={handleToggleEntityVisibility}
            onUpdateEntityPoseCel={handleUpdateEntityPoseCel}
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
        totalFrames={currentScene.totalFrames}
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        onSeekFrame={handleSeekFrame}
        onRewind={() => {
          sound3DMM.stopMusic();
          setIsPlaying(false);
          if (currentFrame === 0 && currentSceneIndex > 0) {
            setCurrentSceneIndex(0);
            setSelectedEntityId(null);
            setSelectedEntityType(null);
          } else {
            setCurrentFrame(0);
          }
        }}
        onOpenAudioModal={() => setIsAudioModalOpen(true)}
        audioCues={currentScene.audios}
        cameraCuts={currentScene.cameraCuts}
        onDeleteAudioCue={handleDeleteAudioCue}
      />

      {/* Footer Info Strip */}
      <div className="bg-[#180a33] border-t-2 border-[#120624] px-3 py-1 text-[11px] text-purple-200 flex items-center justify-between shrink-0">
        <span className="truncate mr-2">{statusMessage}</span>
        <span className="font-mono text-amber-300 shrink-0">
          Actors: {currentScene.actors.length} | Props: {currentScene.props.length} | Sounds:{' '}
          {currentScene.audios.length}
        </span>
      </div>

      {/* 21 Authentic .3MM Sample Movies Modal */}
      {showSamplesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="studio-panel p-4 max-w-lg w-full text-xs text-white max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between pb-2.5 border-b border-purple-700/80">
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

      <AudioImportModal
        currentFrame={currentFrame}
        isOpen={isAudioModalOpen}
        onClose={() => setIsAudioModalOpen(false)}
        onAddAudioCue={handleAddAudioCue}
      />
    </div>
  );
}

export interface KeyframePosition {
  x: number;
  y: number;
  z: number;
  rotX?: number;
  rotY: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  visible?: boolean;
  color?: string;
}

export interface ActionKeyframe {
  anid: number;
  actionName: string;
  celOffset?: number;
  freeze?: boolean;
}

export interface PropActionKeyframe {
  action: PropAction;
  anid?: number;
  celOffset?: number;
  freeze?: boolean;
}

export interface CostumeMtrlOverride {
  ibset: number;
  mtrlCno: number;
}

export interface ActorEntity {
  id: string;
  tmplCno: number;
  name: string;
  anid: number;
  actionName: string;
  actionKeyframes?: Record<number, ActionKeyframe>;
  costumeCmids?: number[];
  costumeMtrls?: CostumeMtrlOverride[];
  keyframes: Record<number, KeyframePosition>;
}

export type PropAction = string;

export interface PropEntity {
  id: string;
  tmplCno: number;
  name: string;
  action: PropAction;
  anid?: number;
  actionKeyframes?: Record<number, PropActionKeyframe>;
  costumeCmids?: number[];
  costumeMtrls?: CostumeMtrlOverride[];
  keyframes: Record<number, KeyframePosition>;
}

export type TdtAction =
  | 'At Rest'
  | 'Flip Letters'
  | 'Spin Letters'
  | 'Cartwheel Letters'
  | 'Side to Side'
  | 'Rock'
  | 'Back and Forth'
  | 'Grow and Shrink'
  | 'Flip'
  | 'Spin'
  | 'Cartwheel'
  | 'The Wave'
  | 'Hide and Appear'
  | 'Walk Forward*'
  | 'Hop'
  | 'Stretch';

export interface TdtActionKeyframe {
  action: TdtAction | string;
  celOffset?: number;
  freeze?: boolean;
}

export interface TdtTextEntity {
  id: string;
  text: string;
  tdfCno: number;
  tdts: number; // 0=flat, 1=circle, 2=arch, 6=vertical, 7=curved
  mtrlCno?: number;
  action?: TdtAction | string;
  actionKeyframes?: Record<number, TdtActionKeyframe>;
  keyframes: Record<number, KeyframePosition>;
}

export interface ScreenTextRun {
  text: string;
  fontName?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface ScreenTextBox {
  id: string;
  text: string;
  runs?: ScreenTextRun[];
  fontName: string;
  fontSize?: number;
  color?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  startFrame: number;
  endFrame: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  isScrolling: boolean;
}

export interface ImportedAudioCue {
  id: string;
  frame: number;
  filename: string;
  audioData: string; // Base64 Data URL for WAV/MP3/WebM
  midiData?: string; // Base64 Data URL for MIDS or SMF MIDI
  isMidi?: boolean;
  isCustomAudio?: boolean;
  loop?: boolean;
  waitForFinish?: boolean;
  ttsVoice?: string;
  ttsPitch?: number;
  ttsSpeed?: number;
  msndCno?: number;
  isStopper?: boolean;
  playlist?: {
    audioData?: string;
    midiData?: string;
    isMidi?: boolean;
    name?: string;
  }[];
}

export interface CameraAngle {
  yaw: number;
  pitch: number;
}

export interface CameraCutEvent {
  frame: number;
  icam: number;
  yaw?: number;
  pitch?: number;
}

export type SceneTransition = 'cut' | 'dissolve' | 'fadeToBlack' | 'fadeToWhite';

export interface Scene {
  id: string;
  bkgdCno: number;
  sceneName: string;
  icam: number;
  cameraAngle: CameraAngle;
  cameraCuts?: CameraCutEvent[];
  transition?: SceneTransition;
  coordMode?: 'stage' | 'world';
  actors: ActorEntity[];
  props: PropEntity[];
  tdtTexts?: TdtTextEntity[];
  textBoxes?: ScreenTextBox[];
  audios: ImportedAudioCue[];
  totalFrames: number;
}

export interface Movie {
  title: string;
  plot?: string;
  scenes: Scene[];
}

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

export interface TdtTextEntity {
  id: string;
  text: string;
  tdfCno: number;
  tdts: number;
  mtrlCno?: number;
  keyframes: Record<number, KeyframePosition>;
}

export interface ScreenTextBox {
  id: string;
  text: string;
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
  loop?: boolean;
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

export interface Scene {
  id: string;
  bkgdCno: number;
  sceneName: string;
  icam: number;
  cameraAngle: CameraAngle;
  cameraCuts?: CameraCutEvent[];
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

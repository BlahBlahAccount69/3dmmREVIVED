import React from 'react';
import {
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Volume2,
} from 'lucide-react';
import { CameraCutEvent, ImportedAudioCue } from '../types/movie';
import { sound3DMM } from '../services/soundLibrary';
import { assetUrl } from '../utils/assetUrl';

interface TimelineBarProps {
  currentFrame: number;
  totalFrames: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeekFrame: (frame: number) => void;
  onRewind: () => void;
  onOpenAudioModal: () => void;
  audioCues: ImportedAudioCue[];
  cameraCuts?: CameraCutEvent[];
  onDeleteAudioCue: (id: string) => void;
}

export const TimelineBar: React.FC<TimelineBarProps> = ({
  currentFrame,
  totalFrames,
  isPlaying,
  onTogglePlay,
  onSeekFrame,
  onRewind,
  onOpenAudioModal,
  audioCues,
  cameraCuts,
  onDeleteAudioCue,
}) => {
  const currentAudioCue = audioCues.find((a) => a.frame === currentFrame);

  return (
    <div className="bg-[#2c1557] border-t-2 border-[#8c63dc] p-2 flex flex-col gap-1.5 text-xs text-slate-100 select-none">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              void sound3DMM.playUiWav('GOFRSTF.WAV');
              onRewind();
            }}
            title="Rewind to Frame 0"
            className="studio-btn p-1.5"
          >
            <RotateCcw size={13} />
          </button>

          <button
            onClick={() => {
              void sound3DMM.playUiWav('GOPREVF.WAV');
              onSeekFrame(Math.max(0, currentFrame - 1));
            }}
            title="Previous Frame"
            className="studio-btn px-1.5 py-1 flex items-center"
          >
            <img
              src={assetUrl('3dmm/bmp/B5CELBK.BMP')}
              alt="Prev Frame"
              className="h-3.5 w-auto object-contain image-rendering-pixelated"
            />
          </button>

          <button
            onClick={() => {
              void sound3DMM.playUiWav(isPlaying ? 'STOP.WAV' : 'PLAY.WAV');
              onTogglePlay();
            }}
            className={`px-3 py-1 font-bold text-xs flex items-center gap-1.5 ${
              isPlaying
                ? 'bg-amber-400 border-2 border-amber-100 text-slate-950'
                : 'studio-btn text-amber-200'
            }`}
          >
            {isPlaying ? (
              <>
                <Pause size={13} fill="currentColor" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play size={13} fill="currentColor" />
                <span>Play (6 FPS)</span>
              </>
            )}
          </button>

          <button
            onClick={() => {
              void sound3DMM.playUiWav('GONEXTF.WAV');
              onSeekFrame(Math.min(totalFrames, currentFrame + 1));
            }}
            title="Next Frame"
            className="studio-btn px-1.5 py-1 flex items-center"
          >
            <img
              src={assetUrl('3dmm/bmp/B5CELFW.BMP')}
              alt="Next Frame"
              className="h-3.5 w-auto object-contain image-rendering-pixelated"
            />
          </button>

          <div className="studio-well px-2.5 py-0.5 font-mono font-bold text-[11px] ml-1 text-amber-300">
            Frame: {currentFrame} / {totalFrames} (6 FPS)
          </div>
        </div>

        {/* Sound & MIDI Cue Controls */}
        <div className="flex items-center gap-1.5">
          {currentAudioCue ? (
            <div className="bg-[#3b206f] border-2 border-amber-400 px-2 py-0.5 flex items-center gap-1.5 text-[11px]">
              {currentAudioCue.isMidi ? (
                <img src={assetUrl('3dmm/bmp/3NOTE.BMP')} alt="" className="h-4 w-auto object-contain image-rendering-pixelated" />
              ) : (
                <Volume2 size={12} className="text-amber-300" />
              )}
              <span className="font-bold truncate max-w-[160px] text-amber-100">
                {currentAudioCue.filename}
              </span>
              <button
                onClick={() => void sound3DMM.playCue(currentAudioCue)}
                className="text-cyan-300 hover:text-white p-0.5"
                title="Preview Sound / MIDI"
              >
                <Play size={11} fill="currentColor" />
              </button>
              <button
                onClick={() => {
                  void sound3DMM.playUiWav('REMACTR.WAV');
                  onDeleteAudioCue(currentAudioCue.id);
                }}
                className="text-rose-400 hover:text-rose-300 p-0.5"
                title="Remove Sound"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                void sound3DMM.playUiWav('TBKOPEN.WAV');
                onOpenAudioModal();
              }}
              className="studio-btn px-2.5 py-0.5 font-bold text-[11px] flex items-center gap-1.5 text-amber-200"
            >
              <img
                src={assetUrl('3dmm/bmp/3NOTE.BMP')}
                alt=""
                className="h-4 w-auto object-contain image-rendering-pixelated"
              />
              <span>Add Sound / MIDI @ f{currentFrame}</span>
            </button>
          )}
        </div>
      </div>

      {/* Interactive Cel Scrubber */}
      <div className="studio-well p-1.5 flex flex-col gap-1">
        <div className="relative h-3 w-full">
          {cameraCuts?.map((cut) => {
            if (cut.frame <= 0) return null;
            const leftPct = (cut.frame / Math.max(totalFrames, 1)) * 100;
            return (
              <div
                key={`camcut_${cut.frame}`}
                onClick={() => onSeekFrame(cut.frame)}
                className="absolute top-0 -translate-x-1/2 cursor-pointer z-10"
                style={{ left: `${leftPct}%` }}
                title={`Camera Cut @ Frame ${cut.frame}: View #${cut.icam + 1}`}
              >
                <div className="w-2.5 h-2.5 bg-cyan-400 border border-black" />
              </div>
            );
          })}
          {audioCues.map((cue) => {
            const leftPct = (cue.frame / Math.max(totalFrames, 1)) * 100;
            return (
              <div
                key={cue.id}
                onClick={() => onSeekFrame(cue.frame)}
                className="absolute top-0 -translate-x-1/2 cursor-pointer z-20"
                style={{ left: `${leftPct}%` }}
                title={`${cue.isMidi ? 'MIDI' : 'Sound'} @ Frame ${cue.frame}: ${cue.filename}`}
              >
                <div
                  className={`w-2.5 h-2.5 border border-black ${
                    cue.isMidi ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
              </div>
            );
          })}
        </div>

        <input
          type="range"
          min={0}
          max={totalFrames}
          value={currentFrame}
          onChange={(e) => onSeekFrame(parseInt(e.target.value, 10))}
          className="w-full accent-amber-400 cursor-pointer h-2"
        />

        <div className="flex justify-between text-[9px] font-mono text-purple-300 px-0.5">
          <span>0</span>
          <span>{Math.round(totalFrames * 0.25)}</span>
          <span>{Math.round(totalFrames * 0.5)}</span>
          <span>{Math.round(totalFrames * 0.75)}</span>
          <span>{totalFrames}</span>
        </div>
      </div>
    </div>
  );
};

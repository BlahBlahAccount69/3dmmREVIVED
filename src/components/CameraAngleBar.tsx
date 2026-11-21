import React from 'react';
import { CameraCutEvent } from '../types/movie';
import { CatalogCameraView } from '../services/threeDmmEngine';
import { sound3DMM } from '../services/soundLibrary';
import { Trash2 } from 'lucide-react';
import { assetUrl } from '../utils/assetUrl';

interface CameraAngleBarProps {
  currentFrame: number;
  currentViewIndex: number;
  cameraCuts?: CameraCutEvent[];
  catalogViews: CatalogCameraView[];
  onSelectCameraView: (icam: number) => void;
  onDeleteCameraCutAtFrame: (frame: number) => void;
}

export const CameraAngleBar: React.FC<CameraAngleBarProps> = ({
  currentFrame,
  currentViewIndex,
  cameraCuts,
  catalogViews,
  onSelectCameraView,
  onDeleteCameraCutAtFrame,
}) => {
  const cutAtCurrentFrame =
    currentFrame > 0 ? cameraCuts?.find((c) => c.frame === currentFrame) : undefined;

  return (
    <div className="bg-[#210f44] border-b-2 border-[#120624] px-2.5 py-1 flex items-center gap-2 text-xs text-slate-200 select-none min-w-0 shrink-0">
      <div className="flex items-center gap-1.5 font-bold text-amber-300 studio-well px-2 py-0.5 shrink-0">
        <img
          src={assetUrl('3dmm/bmp/1VIEW.BMP')}
          alt="3DMM Camera View"
          className="h-5 w-auto object-contain inline-block image-rendering-pixelated"
        />
        <span className="hidden sm:inline">Views @ f{currentFrame}:</span>
        <span className="sm:hidden">f{currentFrame}:</span>
      </div>

      {/* Real 3DMM Camera Angle Thumbnails from BKGDS.3TH */}
      <div className="flex items-center gap-1 overflow-x-auto py-0.5 flex-1 min-w-0">
        {catalogViews.map((v, idx) => {
          const isActive = v.icam === currentViewIndex;
          const hasCutHere = cutAtCurrentFrame?.icam === v.icam;
          return (
            <button
              key={v.cathCno}
              onClick={() => {
                void sound3DMM.playUiWav('CBACKS.WAV');
                onSelectCameraView(v.icam);
              }}
              title={
                currentFrame === 0
                  ? `Set View #${idx + 1}`
                  : `Cut to View #${idx + 1} at Frame ${currentFrame}`
              }
              className={`shrink-0 overflow-hidden flex items-center gap-1 px-1 py-0.5 ${
                isActive
                  ? 'bg-[#6b36c4] border-2 border-amber-300 text-amber-100 font-bold shadow'
                  : 'studio-btn text-purple-100'
              }`}
            >
              {v.thumbDataUrl && (
                <img
                  src={v.thumbDataUrl}
                  alt={`Cam ${idx + 1}`}
                  className="w-8 h-5 object-cover image-rendering-pixelated"
                />
              )}
              <span className="text-[10px] pr-0.5">
                #{idx + 1}
                {hasCutHere ? '•' : ''}
              </span>
            </button>
          );
        })}
      </div>

      {cutAtCurrentFrame && (
        <button
          onClick={() => {
            void sound3DMM.playUiWav('CANCEL.WAV');
            onDeleteCameraCutAtFrame(currentFrame);
          }}
          title={`Remove camera cut at Frame ${currentFrame}`}
          className="px-1.5 py-0.5 bg-rose-900/80 hover:bg-rose-700 border border-rose-400 text-[10px] text-rose-100 flex items-center gap-1 shrink-0"
        >
          <Trash2 size={10} />
          <span>Cut f{currentFrame}</span>
        </button>
      )}
    </div>
  );
};


import React, { useEffect, useState } from 'react';
import { ImportedAudioCue } from '../types/movie';
import { CatalogSoundItem, sound3DMM } from '../services/soundLibrary';
import { Music, Play, Square, Upload, Volume2 } from 'lucide-react';
import { assetUrl } from '../utils/assetUrl';

interface AudioImportModalProps {
  currentFrame: number;
  isOpen: boolean;
  onClose: () => void;
  onAddAudioCue: (cue: ImportedAudioCue) => void;
}

export const AudioImportModal: React.FC<AudioImportModalProps> = ({
  currentFrame,
  isOpen,
  onClose,
  onAddAudioCue,
}) => {
  const [tab, setTab] = useState<'sfx' | 'speech' | 'music' | 'custom'>('sfx');
  const [catalog, setCatalog] = useState<CatalogSoundItem[]>([]);
  const [search, setSearch] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    sound3DMM.loadSoundCatalog().then(setCatalog).catch(console.error);
  }, [isOpen]);

  if (!isOpen) return null;

  const filtered = catalog.filter(
    (s) =>
      ((tab === 'sfx' && s.category === 'sfx') ||
        (tab === 'speech' && s.category === 'speech') ||
        (tab === 'music' && s.category === 'music')) &&
      s.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  const handleSelectCatalogSound = async (item: CatalogSoundItem) => {
    setIsProcessing(true);
    setErrorMsg(null);
    try {
      const extracted = await sound3DMM.extractSoundItemCueData(item);
      const isCustom = Boolean(item.sampleFile || item.midiFileUrl || extracted?.isCustomAudio);
      onAddAudioCue({
        id: 'snd_' + Math.random().toString(36).substring(2, 9),
        frame: currentFrame,
        filename: item.name,
        audioData: extracted?.audioData || '',
        midiData: extracted?.midiData,
        isMidi: item.isMidi || extracted?.isMidi,
        isCustomAudio: isCustom,
        loop: item.isMidi,
        msndCno: isCustom ? undefined : item.msndCno,
      });
      void sound3DMM.previewCatalogItem(item);
      onClose();
    } catch {
      setErrorMsg('Could not extract sound/MIDI from archive.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsProcessing(true);
    setErrorMsg(null);
    try {
      const dataUrl = await sound3DMM.bitcrushAudioFile(file);
      onAddAudioCue({
        id: 'snd_' + Math.random().toString(36).substring(2, 9),
        frame: currentFrame,
        filename: `${file.name} (8-bit)`,
        audioData: dataUrl,
      });
      void sound3DMM.playBase64Audio('preview', dataUrl);
      onClose();
    } catch {
      setErrorMsg('Could not decode audio file. Please pick a valid WAV, MP3, or OGG.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="studio-panel max-w-lg w-full max-h-[90dvh] text-xs text-white overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="bg-[#43217c] border-b-2 border-[#120624] px-3 py-2 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 font-bold text-amber-300 text-sm min-w-0">
            <img
              src={assetUrl('3dmm/bmp/3NOTE.BMP')}
              alt=""
              className="h-5 w-auto object-contain image-rendering-pixelated shrink-0"
            />
            <span className="truncate">Add 3DMM Sound / MIDI at Frame {currentFrame}</span>
          </div>
          <button
            onClick={() => {
              sound3DMM.stopAll();
              void sound3DMM.playUiWav('CANCEL.WAV');
              onClose();
            }}
            className="studio-btn px-2 py-0.5 font-bold text-white shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Category Tabs */}
        <div className="flex flex-wrap gap-1.5 p-2.5 border-b border-purple-900 bg-[#1b0b38] shrink-0">
          <button
            onClick={() => setTab('sfx')}
            className={`px-2.5 py-1 font-bold ${
              tab === 'sfx' ? 'bg-[#6b36c4] border-2 border-amber-300 text-white' : 'studio-btn text-purple-100'
            }`}
          >
            🔊 Sound FX ({catalog.filter((c) => c.category === 'sfx').length})
          </button>
          <button
            onClick={() => setTab('speech')}
            className={`px-2.5 py-1 font-bold ${
              tab === 'speech' ? 'bg-[#6b36c4] border-2 border-amber-300 text-white' : 'studio-btn text-purple-100'
            }`}
          >
            💬 Speech ({catalog.filter((c) => c.category === 'speech').length})
          </button>
          <button
            onClick={() => setTab('music')}
            className={`px-2.5 py-1 font-bold ${
              tab === 'music' ? 'bg-emerald-700 border-2 border-amber-300 text-white' : 'studio-btn text-emerald-200'
            }`}
          >
            🎵 MIDI Music ({catalog.filter((c) => c.category === 'music').length})
          </button>
          <button
            onClick={() => setTab('custom')}
            className={`px-2.5 py-1 font-bold ${
              tab === 'custom' ? 'bg-amber-700 border-2 border-amber-200 text-white' : 'studio-btn text-amber-200'
            }`}
          >
            🎙️ Import Custom
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2.5 flex-1 min-h-0">
          {tab !== 'custom' ? (
            <>
              <div className="flex flex-wrap gap-1.5 shrink-0">
                <input
                  type="text"
                  placeholder="Search SOUND.3TH & SNDS.3CN..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="studio-well flex-1 min-w-0 px-2.5 py-1.5 text-white text-xs focus:outline-none"
                />
                {tab === 'music' && (
                  <button
                    onClick={() => sound3DMM.stopMusic()}
                    className="studio-btn px-2.5 py-1 flex items-center gap-1 text-rose-200 shrink-0"
                    title="Stop MIDI Preview"
                  >
                    <Square size={10} fill="currentColor" />
                    <span>Stop</span>
                  </button>
                )}
              </div>
              <div className="overflow-y-auto flex-1 min-h-0 max-h-64 flex flex-col gap-1 pr-1">
                {filtered.map((item) => (
                  <div
                    key={item.cno}
                    className="flex items-center justify-between studio-well px-2.5 py-1.5"
                  >
                    <div className="flex items-center gap-2 truncate">
                      {item.isMidi ? (
                        <Music size={13} className="text-emerald-300 shrink-0" />
                      ) : (
                        <Volume2 size={13} className="text-cyan-300 shrink-0" />
                      )}
                      <span className="truncate font-semibold">{item.name}</span>
                      {item.sourceLabel && (
                        <span className="text-[10px] text-purple-300 shrink-0">[{item.sourceLabel}]</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => void sound3DMM.previewCatalogItem(item)}
                        className="studio-btn px-2 py-0.5 text-[11px] flex items-center gap-1"
                        title="Preview"
                      >
                        <Play size={10} fill="currentColor" />
                        <span>Play</span>
                      </button>
                      <button
                        disabled={isProcessing}
                        onClick={() => void handleSelectCatalogSound(item)}
                        className="bg-emerald-700 hover:bg-emerald-600 border border-emerald-400 text-white font-bold px-2.5 py-0.5 text-[11px]"
                      >
                        + Add
                      </button>
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="text-center text-purple-300 py-6">
                    {catalog.length === 0 ? 'Loading SOUND.3TH & SNDS.3CN...' : 'No matching sounds.'}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              <div className="studio-well p-2.5 text-purple-200 leading-relaxed">
                Import any audio clip (WAV/MP3/OGG). It will be bitcrushed to authentic 22kHz 8-bit PCM WAV and embedded directly inside your saved <code className="text-amber-300">.3mm</code> movie!
              </div>
              <label className="studio-btn cursor-pointer p-4 flex flex-col items-center gap-2 text-center border-dashed border-2 border-amber-400">
                <Upload size={22} className="text-amber-300" />
                <span className="font-bold text-amber-200">
                  {isProcessing ? 'Bitcrushing audio...' : 'Click to choose audio file'}
                </span>
                <input
                  type="file"
                  accept="audio/*"
                  disabled={isProcessing}
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>
            </div>
          )}

          {errorMsg && (
            <div className="bg-rose-950 border border-rose-500 text-rose-200 px-2.5 py-1.5">
              {errorMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

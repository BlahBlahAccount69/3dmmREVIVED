import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ImportedAudioCue } from '../types/movie';
import {
  CatalogSoundItem,
  SAPI4_VOICES,
  sound3DMM,
  synthesizeSapi4Tts,
} from '../services/soundLibrary';
import { Bot, Mic, Music, Play, RotateCcw, Square, Upload, Volume2 } from 'lucide-react';
import { assetUrl } from '../utils/assetUrl';

interface AudioImportModalProps {
  currentFrame: number;
  isOpen: boolean;
  onClose: () => void;
  onAddAudioCue: (cue: ImportedAudioCue) => void;
}

const MAX_RECORD_SECONDS = 30;

export const AudioImportModal: React.FC<AudioImportModalProps> = ({
  currentFrame,
  isOpen,
  onClose,
  onAddAudioCue,
}) => {
  const [tab, setTab] = useState<'sfx' | 'speech' | 'music' | 'record' | 'tts' | 'custom'>('sfx');
  const [catalog, setCatalog] = useState<CatalogSoundItem[]>([]);
  const [search, setSearch] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordElapsedSec, setRecordElapsedSec] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [voiceName, setVoiceName] = useState('My Voice');
  const [recordedDataUrl, setRecordedDataUrl] = useState<string | null>(null);
  const [recordedDurationSec, setRecordedDurationSec] = useState(0);
  const [recordWaitForFinish, setRecordWaitForFinish] = useState(true);

  // BonziBuddy / SAPI4 TTS state
  const [ttsText, setTtsText] = useState('Hello there! Expand dong in 3D Movie Maker!');
  const [ttsVoice, setTtsVoice] = useState(SAPI4_VOICES[0].id);
  const [ttsPitch, setTtsPitch] = useState(SAPI4_VOICES[0].defPitch);
  const [ttsSpeed, setTtsSpeed] = useState(SAPI4_VOICES[0].defSpeed);
  const [ttsWaitForFinish, setTtsWaitForFinish] = useState(true);
  const [ttsAudioData, setTtsAudioData] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordRafRef = useRef<number | null>(null);
  const analyserCtxRef = useRef<AudioContext | null>(null);
  const recordStartMsRef = useRef<number>(0);

  const cleanupRecordingResources = useCallback((stopRecorder = true) => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recordRafRef.current !== null) {
      window.cancelAnimationFrame(recordRafRef.current);
      recordRafRef.current = null;
    }
    const mr = mediaRecorderRef.current;
    if (stopRecorder && mr && mr.state !== 'inactive') {
      try {
        mr.stop();
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
      mediaStreamRef.current = null;
    }
    if (analyserCtxRef.current) {
      analyserCtxRef.current.close().catch(() => {});
      analyserCtxRef.current = null;
    }
    setIsRecording(false);
    setMicLevel(0);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      cleanupRecordingResources(true);
      return;
    }
    // Hide embedded sample .3MM voices & sounds from the manual user picker (AI director still uses them)
    sound3DMM
      .loadSoundCatalog()
      .then((items) => setCatalog(items.filter((s) => !s.sampleFile)))
      .catch(console.error);
    return () => {
      cleanupRecordingResources(true);
    };
  }, [isOpen, cleanupRecordingResources]);

  if (!isOpen) return null;

  const filtered = catalog.filter(
    (s) =>
      !s.sampleFile &&
      ((tab === 'sfx' && s.category === 'sfx') ||
        (tab === 'speech' && s.category === 'speech') ||
        (tab === 'music' && s.category === 'music')) &&
      s.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  const activeSapiVoice = SAPI4_VOICES.find((v) => v.id === ttsVoice) || SAPI4_VOICES[0];

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
        isCustomAudio: true,
      });
      void sound3DMM.playBase64Audio('preview', dataUrl);
      onClose();
    } catch {
      setErrorMsg('Could not decode audio file. Please pick a valid WAV, MP3, or OGG.');
    } finally {
      setIsProcessing(false);
    }
  };

  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') {
      try {
        mr.stop();
      } catch {
        cleanupRecordingResources(false);
      }
    } else {
      cleanupRecordingResources(false);
    }
  };

  const startRecording = async () => {
    if (isRecording || isProcessing) return;
    setErrorMsg(null);
    setRecordedDataUrl(null);
    setRecordedDurationSec(0);
    setRecordElapsedSec(0);

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setErrorMsg('Microphone recording requires a modern browser with microphone permissions enabled.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      const supportedMime =
        typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
          ? preferredTypes.find((t) => MediaRecorder.isTypeSupported(t))
          : undefined;

      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);

      recordChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const meterCtx = new AudioCtx();
        analyserCtxRef.current = meterCtx;
        const src = meterCtx.createMediaStreamSource(stream);
        const analyser = meterCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tickMeter = () => {
          if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') return;
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const dev = Math.abs(data[i] - 128) / 128;
            if (dev > peak) peak = dev;
          }
          setMicLevel(Math.min(1, peak * 2.2));
          recordRafRef.current = window.requestAnimationFrame(tickMeter);
        };
        recordRafRef.current = window.requestAnimationFrame(tickMeter);
      } catch {
        // level meter optional
      }

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        const elapsed = Math.max(0.2, (Date.now() - recordStartMsRef.current) / 1000);
        const mime = recorder.mimeType || supportedMime || 'audio/webm';
        const rawBlob = new Blob(recordChunksRef.current, { type: mime });
        cleanupRecordingResources(false);

        if (rawBlob.size === 0) {
          setErrorMsg('No audio was captured from the microphone.');
          return;
        }

        setIsProcessing(true);
        try {
          const dataUrl = await sound3DMM.bitcrushAudioBlob(rawBlob, MAX_RECORD_SECONDS);
          setRecordedDataUrl(dataUrl);
          setRecordedDurationSec(Math.min(MAX_RECORD_SECONDS, Number(elapsed.toFixed(1))));
          void sound3DMM.playBase64Audio('voice_preview', dataUrl);
        } catch {
          setErrorMsg('Could not encode recorded voice audio. Try speaking again or check mic input.');
        } finally {
          setIsProcessing(false);
        }
      };

      recordStartMsRef.current = Date.now();
      setIsRecording(true);
      recorder.start(120);

      recordTimerRef.current = window.setInterval(() => {
        const sec = (Date.now() - recordStartMsRef.current) / 1000;
        setRecordElapsedSec(sec);
        if (sec >= MAX_RECORD_SECONDS) {
          stopRecording();
        }
      }, 100);
    } catch (err) {
      cleanupRecordingResources(true);
      const msg = err instanceof Error ? err.message : '';
      if (/denied|notallowed|permission/i.test(msg)) {
        setErrorMsg('Microphone permission was denied. Allow mic access in browser settings and retry.');
      } else {
        setErrorMsg('Could not access microphone. Check that a mic is connected and allowed.');
      }
    }
  };

  const handleAddRecordedVoice = () => {
    if (!recordedDataUrl) return;
    const cleanName = voiceName.trim() || `Voice @ f${currentFrame}`;
    onAddAudioCue({
      id: 'snd_' + Math.random().toString(36).substring(2, 9),
      frame: currentFrame,
      filename: cleanName,
      audioData: recordedDataUrl,
      isCustomAudio: true,
      waitForFinish: recordWaitForFinish,
    });
    sound3DMM.stopAll();
    onClose();
  };

  const handleGenerateTts = async (addImmediately: boolean) => {
    const clean = ttsText.trim();
    if (!clean) {
      setErrorMsg('Enter text to synthesize.');
      return;
    }
    setIsProcessing(true);
    setErrorMsg(null);
    try {
      const res = await synthesizeSapi4Tts({
        text: clean,
        voice: ttsVoice,
        pitch: ttsPitch,
        speed: ttsSpeed,
      });
      setTtsAudioData(res.audioData);
      if (addImmediately) {
        onAddAudioCue({
          id: 'snd_' + Math.random().toString(36).substring(2, 9),
          frame: currentFrame,
          filename: `TTS: ${clean.slice(0, 24)}`,
          audioData: res.audioData,
          isCustomAudio: true,
          waitForFinish: ttsWaitForFinish,
          ttsVoice: res.voice,
          ttsPitch: res.pitch,
          ttsSpeed: res.speed,
        });
        void sound3DMM.playBase64Audio('tts_preview', res.audioData);
        onClose();
      } else {
        void sound3DMM.playBase64Audio('tts_preview', res.audioData);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'BonziBuddy SAPI4 TTS generation failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSwitchTab = (nextTab: typeof tab) => {
    if (isRecording) stopRecording();
    setErrorMsg(null);
    setTab(nextTab);
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
            <span className="truncate">Add 3DMM Sound / Voice / MIDI at Frame {currentFrame}</span>
          </div>
          <button
            onClick={() => {
              cleanupRecordingResources(true);
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
            onClick={() => handleSwitchTab('sfx')}
            className={`px-2 py-1 font-bold ${
              tab === 'sfx' ? 'bg-[#6b36c4] border-2 border-amber-300 text-white' : 'studio-btn text-purple-100'
            }`}
          >
            🔊 Sound FX ({catalog.filter((c) => c.category === 'sfx').length})
          </button>
          <button
            onClick={() => handleSwitchTab('speech')}
            className={`px-2 py-1 font-bold ${
              tab === 'speech' ? 'bg-[#6b36c4] border-2 border-amber-300 text-white' : 'studio-btn text-purple-100'
            }`}
          >
            💬 Speech ({catalog.filter((c) => c.category === 'speech').length})
          </button>
          <button
            onClick={() => handleSwitchTab('music')}
            className={`px-2 py-1 font-bold ${
              tab === 'music' ? 'bg-emerald-700 border-2 border-amber-300 text-white' : 'studio-btn text-emerald-200'
            }`}
          >
            🎵 MIDI ({catalog.filter((c) => c.category === 'music').length})
          </button>
          <button
            onClick={() => handleSwitchTab('record')}
            className={`px-2 py-1 font-bold ${
              tab === 'record' ? 'bg-rose-700 border-2 border-amber-300 text-white' : 'studio-btn text-rose-200'
            }`}
          >
            🎤 Record Voice
          </button>
          <button
            onClick={() => handleSwitchTab('tts')}
            className={`px-2 py-1 font-bold ${
              tab === 'tts' ? 'bg-indigo-700 border-2 border-amber-300 text-white' : 'studio-btn text-indigo-200'
            }`}
          >
            🤖 Bonzi TTS
          </button>
          <button
            onClick={() => handleSwitchTab('custom')}
            className={`px-2 py-1 font-bold ${
              tab === 'custom' ? 'bg-amber-700 border-2 border-amber-200 text-white' : 'studio-btn text-amber-200'
            }`}
          >
            📁 Import Audio
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2.5 flex-1 min-h-0 overflow-y-auto">
          {tab === 'tts' ? (
            <div className="flex flex-col gap-2.5 py-1">
              <div className="studio-well p-2.5 text-purple-200 leading-relaxed flex items-center gap-2">
                <Bot size={16} className="text-indigo-300 shrink-0" />
                <span>
                  Synthesize BonziBuddy / SAPI4 TruVoice speech with exact pitch &amp; speed, packed right into your movie!
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-purple-200 font-semibold">Voice Profile</label>
                <div className="flex gap-1.5">
                  <select
                    value={ttsVoice}
                    onChange={(e) => {
                      const next = SAPI4_VOICES.find((v) => v.id === e.target.value) || SAPI4_VOICES[0];
                      setTtsVoice(next.id);
                      setTtsPitch(next.defPitch);
                      setTtsSpeed(next.defSpeed);
                      setTtsAudioData(null);
                    }}
                    className="studio-well flex-1 px-2 py-1.5 text-white text-xs"
                  >
                    {SAPI4_VOICES.map((v) => (
                      <option key={v.id} value={v.id} className="bg-[#1b0b38]">
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      const bonzi = SAPI4_VOICES[0];
                      setTtsVoice(bonzi.id);
                      setTtsPitch(140);
                      setTtsSpeed(157);
                      setTtsAudioData(null);
                    }}
                    className="studio-btn px-2 py-1 text-[11px] text-purple-100 shrink-0"
                    title="Reset to BonziBuddy preset (pitch 140, speed 157)"
                  >
                    Bonzi Preset
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-purple-200 font-semibold">Spoken Text</label>
                <textarea
                  rows={2}
                  maxLength={240}
                  value={ttsText}
                  onChange={(e) => {
                    setTtsText(e.target.value);
                    setTtsAudioData(null);
                  }}
                  placeholder="Type dialogue for BonziBuddy / SAPI4..."
                  className="studio-well px-2.5 py-1.5 text-white text-xs focus:outline-none resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="studio-well p-2 flex flex-col gap-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-purple-200 font-semibold">Pitch</span>
                    <span className="text-amber-300 font-mono">{ttsPitch}</span>
                  </div>
                  <input
                    type="range"
                    min={activeSapiVoice.minPitch}
                    max={activeSapiVoice.maxPitch}
                    value={ttsPitch}
                    onChange={(e) => {
                      setTtsPitch(Number(e.target.value));
                      setTtsAudioData(null);
                    }}
                  />
                </div>
                <div className="studio-well p-2 flex flex-col gap-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-purple-200 font-semibold">Speed</span>
                    <span className="text-amber-300 font-mono">{ttsSpeed}</span>
                  </div>
                  <input
                    type="range"
                    min={activeSapiVoice.minSpeed}
                    max={activeSapiVoice.maxSpeed}
                    value={ttsSpeed}
                    onChange={(e) => {
                      setTtsSpeed(Number(e.target.value));
                      setTtsAudioData(null);
                    }}
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-[11px] text-purple-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ttsWaitForFinish}
                  onChange={(e) => setTtsWaitForFinish(e.target.checked)}
                />
                <span>Wait for voice to finish before advancing frame</span>
              </label>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => void handleGenerateTts(false)}
                  className="studio-btn px-3 py-1.5 flex items-center gap-1.5 font-semibold disabled:opacity-50"
                >
                  <Play size={12} fill="currentColor" />
                  <span>{isProcessing ? 'Synthesizing...' : ttsAudioData ? 'Replay Preview' : 'Generate & Preview'}</span>
                </button>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => {
                    if (ttsAudioData) {
                      onAddAudioCue({
                        id: 'snd_' + Math.random().toString(36).substring(2, 9),
                        frame: currentFrame,
                        filename: `TTS: ${ttsText.trim().slice(0, 24)}`,
                        audioData: ttsAudioData,
                        isCustomAudio: true,
                        waitForFinish: ttsWaitForFinish,
                        ttsVoice,
                        ttsPitch,
                        ttsSpeed,
                      });
                      onClose();
                    } else {
                      void handleGenerateTts(true);
                    }
                  }}
                  className="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 border-2 border-emerald-300 text-white font-bold px-3 py-1.5"
                >
                  + Add Voice @ Frame {currentFrame}
                </button>
              </div>
            </div>
          ) : tab === 'record' ? (
            <div className="flex flex-col gap-3 py-1">
              <div className="studio-well p-2.5 text-purple-200 leading-relaxed">
                Record your own voice line with your microphone (up to {MAX_RECORD_SECONDS}s). It is encoded as authentic 22kHz 8-bit 3DMM audio and packed into your saved <code className="text-amber-300">.3mm</code> movie!
              </div>

              <div className="flex items-center gap-2">
                <label className="text-purple-200 font-semibold shrink-0">Voice Name:</label>
                <input
                  type="text"
                  maxLength={32}
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  placeholder="My Voice Line"
                  className="studio-well flex-1 px-2.5 py-1 text-white text-xs focus:outline-none"
                />
              </div>

              <label className="flex items-center gap-2 text-[11px] text-purple-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recordWaitForFinish}
                  onChange={(e) => setRecordWaitForFinish(e.target.checked)}
                />
                <span>Wait for recorded voice to finish before advancing frame</span>
              </label>

              {/* Recorder Controls & Meter */}
              <div className="studio-well p-3 flex flex-col gap-2.5 items-center">
                <div className="flex items-center gap-3">
                  {!isRecording ? (
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => void startRecording()}
                      className="bg-rose-700 hover:bg-rose-600 disabled:opacity-50 border-2 border-rose-300 text-white font-bold px-4 py-2 flex items-center gap-2"
                    >
                      <Mic size={15} />
                      <span>{recordedDataUrl ? 'Record New Take' : 'Start Recording'}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={stopRecording}
                      className="bg-rose-600 hover:bg-rose-500 border-2 border-amber-300 text-white font-bold px-4 py-2 flex items-center gap-2 animate-pulse"
                    >
                      <Square size={14} fill="currentColor" />
                      <span>Stop Recording ({recordElapsedSec.toFixed(1)}s / {MAX_RECORD_SECONDS}s)</span>
                    </button>
                  )}
                </div>

                {isRecording && (
                  <div className="w-full flex flex-col gap-1">
                    <div className="w-full h-2.5 bg-[#120624] border border-purple-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500 transition-[width] duration-75"
                        style={{ width: `${Math.max(4, Math.round(micLevel * 100))}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-rose-200 text-center">
                      Listening... click Stop Recording when done.
                    </div>
                  </div>
                )}

                {isProcessing && (
                  <div className="text-amber-300 font-semibold">
                    Converting voice to 22kHz 8-bit 3DMM WAV...
                  </div>
                )}

                {recordedDataUrl && !isRecording && !isProcessing && (
                  <div className="w-full flex flex-col gap-2 border-t border-purple-900/70 pt-2.5">
                    <div className="flex items-center justify-between text-[11px] text-emerald-300">
                      <span>Voice ready ({recordedDurationSec}s • 8-bit 3DMM WAV)</span>
                      <button
                        type="button"
                        onClick={() => {
                          setRecordedDataUrl(null);
                          setRecordedDurationSec(0);
                        }}
                        className="studio-btn px-2 py-0.5 flex items-center gap-1 text-purple-200"
                      >
                        <RotateCcw size={10} />
                        <span>Clear</span>
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void sound3DMM.playBase64Audio('voice_preview', recordedDataUrl)}
                        className="studio-btn px-3 py-1.5 flex items-center gap-1.5 font-semibold"
                      >
                        <Play size={12} fill="currentColor" />
                        <span>Preview Voice</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleAddRecordedVoice}
                        className="flex-1 bg-emerald-700 hover:bg-emerald-600 border-2 border-emerald-300 text-white font-bold px-3 py-1.5"
                      >
                        + Add Voice @ Frame {currentFrame}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : tab === 'custom' ? (
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
          ) : (
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

import { useEffect, useRef, useCallback, useState } from 'react';
import * as Tone from 'tone';
import { SYNTH_DEFAULTS, EFFECT_DEFAULTS, WaveformType, LfoWaveformType } from '../constants/synth';

export interface SynthParams {
  volume: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  waveform: WaveformType;
}

export interface EffectParams {
  reverbWet: number;
  delayWet: number;
  chorusWet: number;
  filterFreq: number;
}

export interface LfoParams {
  rate: number;
  filterDepth: number;
  ampDepth: number;
  waveform: LfoWaveformType;
  sync: boolean;
}

export interface UseSynthReturn {
  synth: Tone.PolySynth | null;
  startNote: (note: string) => Promise<void>;
  stopNote: (note: string) => void;
  updateSynthParams: (params: Partial<SynthParams>) => void;
  updateEffectParams: (params: Partial<EffectParams>) => void;
  updateLfoParams: (params: Partial<LfoParams>) => void;
  isAudioReady: boolean;
  audioError: string | null;
}

// LFO波形をTone.jsの有効な型に変換する関数
const getLfoWaveformType = (waveform: LfoWaveformType): Tone.ToneOscillatorType => {
  switch (waveform) {
    case 'sine':
      return 'sine';
    case 'square':
      return 'square';
    case 'sawtooth':
      return 'sawtooth';
    case 'random':
      // randomの場合はsineにフォールバック（将来的にノイズ生成器を使用予定）
      return 'sine';
    default:
      return 'sine';
  }
};

export const useSynth = (
  synthParams: SynthParams,
  effectParams: EffectParams,
  lfoParams: LfoParams
): UseSynthReturn => {
  const synthRef = useRef<Tone.PolySynth | null>(null);
  const reverbRef = useRef<Tone.Reverb | null>(null);
  const delayRef = useRef<Tone.FeedbackDelay | null>(null);
  const chorusRef = useRef<Tone.Chorus | null>(null);
  const filterRef = useRef<Tone.Filter | null>(null);
  const volumeNodeRef = useRef<Tone.Volume | null>(null);
  
  // LFO references (no pitch LFO)
  const filterLfoRef = useRef<Tone.LFO | null>(null);
  const ampLfoRef = useRef<Tone.LFO | null>(null);
  
  // LFO scale nodes for controlling modulation depth
  const filterScaleRef = useRef<Tone.Scale | null>(null);
  const ampScaleRef = useRef<Tone.Scale | null>(null);
  
  const activeNotesRef = useRef<Set<string>>(new Set());
  const isInitializedRef = useRef<boolean>(false);
  const [isAudioReady, setIsAudioReady] = useState<boolean>(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  // ベース周波数の参照を保持
  const baseFilterFreqRef = useRef<number>(effectParams.filterFreq);
  const currentLfoDepthRef = useRef({ filter: 0, amp: 0 });

  // オーディオコンテキストの初期化（ユーザーインタラクション時に呼び出す）
  const initializeAudio = useCallback(async (): Promise<boolean> => {
    if (isInitializedRef.current) {
      return true;
    }

    try {
      // ユーザーインタラクションが必要
      await Tone.start();
      
      console.log('AudioContext状態:', Tone.getContext().state);
      
      // シンセサイザーとエフェクトの作成
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: synthParams.waveform },
        envelope: {
          attack: synthParams.attack,
          decay: synthParams.decay,
          sustain: synthParams.sustain,
          release: synthParams.release
        }
      });
      synth.maxPolyphony = SYNTH_DEFAULTS.maxPolyphony;
      
      // エフェクトの作成
      const reverb = new Tone.Reverb({ 
        decay: EFFECT_DEFAULTS.reverbDecay, 
        wet: effectParams.reverbWet 
      });
      const delay = new Tone.FeedbackDelay({ 
        delayTime: EFFECT_DEFAULTS.delayTime, 
        feedback: EFFECT_DEFAULTS.delayFeedback, 
        wet: effectParams.delayWet 
      });
      const chorus = new Tone.Chorus({ 
        frequency: EFFECT_DEFAULTS.chorusFrequency, 
        depth: EFFECT_DEFAULTS.chorusDepth, 
        wet: effectParams.chorusWet 
      });
      const filter = new Tone.Filter({ 
        frequency: effectParams.filterFreq, 
        type: EFFECT_DEFAULTS.filterType 
      });
      const volumeNode = new Tone.Volume(synthParams.volume);
      
      // LFOの作成 (フィルターとアンプのみ)
      const lfoWaveformType = getLfoWaveformType(lfoParams.waveform);
      
      const filterLfo = new Tone.LFO(lfoParams.rate, -1, 1);
      filterLfo.type = lfoWaveformType;
      
      const ampLfo = new Tone.LFO(lfoParams.rate, -1, 1);
      ampLfo.type = lfoWaveformType;
      
      // LFOスケールノードの作成（モジュレーション深度制御用）
      const filterScale = new Tone.Scale(
        effectParams.filterFreq * (1 - lfoParams.filterDepth), 
        effectParams.filterFreq * (1 + lfoParams.filterDepth)
      );
      const ampScale = new Tone.Scale(
        -12 * lfoParams.ampDepth, 
        12 * lfoParams.ampDepth
      );
      
      // LFOとスケールノードの接続
      filterLfo.connect(filterScale);
      ampLfo.connect(ampScale);
      
      // フィルターLFOの接続
      filterScale.connect(filter.frequency);
      
      // アンプLFOの接続
      ampScale.connect(volumeNode.volume);
      
      // LFO開始
      filterLfo.start();
      ampLfo.start();
      
      // オーディオチェーンの接続
      synth.connect(filter);
      filter.connect(chorus);
      chorus.connect(delay);
      delay.connect(reverb);
      reverb.connect(volumeNode);
      volumeNode.toDestination();
      
      // リファレンスの保存
      synthRef.current = synth;
      reverbRef.current = reverb;
      delayRef.current = delay;
      chorusRef.current = chorus;
      filterRef.current = filter;
      volumeNodeRef.current = volumeNode;
      filterLfoRef.current = filterLfo;
      ampLfoRef.current = ampLfo;
      filterScaleRef.current = filterScale;
      ampScaleRef.current = ampScale;
      
      // ベース値を設定
      baseFilterFreqRef.current = effectParams.filterFreq;
      currentLfoDepthRef.current = {
        filter: lfoParams.filterDepth,
        amp: lfoParams.ampDepth
      };
      
      // リバーブの準備完了を待つ
      await reverb.ready;
      
      isInitializedRef.current = true;
      setIsAudioReady(true);
      setAudioError(null);
      
      console.log('LFO接続を含むオーディオシステムが正常に初期化されました');
      return true;
      
    } catch (error) {
      console.error('オーディオ初期化エラー:', error);
      const errorMessage = error instanceof Error ? error.message : 'オーディオの初期化に失敗しました';
      setAudioError(errorMessage);
      setIsAudioReady(false);
      return false;
    }
  }, [synthParams, effectParams, lfoParams]);

  // ノートの開始（初期化を含む）
  const startNote = useCallback(async (note: string): Promise<void> => {
    // まだ初期化されていない場合は初期化を試行
    if (!isInitializedRef.current) {
      const initialized = await initializeAudio();
      if (!initialized) {
        console.warn('オーディオが初期化されていないため、音を再生できません');
        return;
      }
    }

    if (!synthRef.current || activeNotesRef.current.has(note)) return;
    
    try {
      activeNotesRef.current.add(note);
      synthRef.current.triggerAttack(note);
    } catch (error) {
      console.error('ノート再生エラー:', error);
      activeNotesRef.current.delete(note);
    }
  }, [initializeAudio]);
  
  const stopNote = useCallback((note: string) => {
    if (!synthRef.current || !activeNotesRef.current.has(note)) return;
    
    try {
      activeNotesRef.current.delete(note);
      synthRef.current.triggerRelease(note);
    } catch (error) {
      console.error('ノート停止エラー:', error);
    }
  }, []);

  // パラメーター更新関数
  const updateSynthParams = useCallback((params: Partial<SynthParams>) => {
    if (synthRef.current && (params.waveform || params.attack || params.decay || params.sustain || params.release)) {
      synthRef.current.set({
        oscillator: params.waveform ? { type: params.waveform } : undefined,
        envelope: {
          attack: params.attack ?? synthParams.attack,
          decay: params.decay ?? synthParams.decay,
          sustain: params.sustain ?? synthParams.sustain,
          release: params.release ?? synthParams.release
        }
      });
    }
    if (params.volume !== undefined && volumeNodeRef.current) {
      volumeNodeRef.current.volume.value = params.volume;
    }
  }, [synthParams]);

  const updateEffectParams = useCallback((params: Partial<EffectParams>) => {
    if (params.reverbWet !== undefined && reverbRef.current) {
      reverbRef.current.wet.value = params.reverbWet;
    }
    if (params.delayWet !== undefined && delayRef.current) {
      delayRef.current.wet.value = params.delayWet;
    }
    if (params.chorusWet !== undefined && chorusRef.current) {
      chorusRef.current.wet.value = params.chorusWet;
    }
    if (params.filterFreq !== undefined && filterRef.current) {
      filterRef.current.frequency.value = params.filterFreq;
      baseFilterFreqRef.current = params.filterFreq;
      
      // フィルターLFOの範囲を更新
      if (filterScaleRef.current) {
        const filterDepth = currentLfoDepthRef.current.filter;
        filterScaleRef.current.min = params.filterFreq * (1 - filterDepth);
        filterScaleRef.current.max = params.filterFreq * (1 + filterDepth);
      }
    }
  }, []);

  const updateLfoParams = useCallback((params: Partial<LfoParams>) => {
    if (!filterLfoRef.current || !ampLfoRef.current) return;

    // レート更新
    if (params.rate !== undefined) {
      filterLfoRef.current.frequency.value = params.rate;
      ampLfoRef.current.frequency.value = params.rate;
    }

    // 波形更新
    if (params.waveform !== undefined) {
      const waveformType = getLfoWaveformType(params.waveform);
      filterLfoRef.current.type = waveformType;
      ampLfoRef.current.type = waveformType;
    }

    // 深度更新
    if (params.filterDepth !== undefined) {
      currentLfoDepthRef.current.filter = params.filterDepth;
      if (filterScaleRef.current) {
        const baseFreq = baseFilterFreqRef.current;
        filterScaleRef.current.min = baseFreq * (1 - params.filterDepth);
        filterScaleRef.current.max = baseFreq * (1 + params.filterDepth);
      }
    }

    if (params.ampDepth !== undefined) {
      currentLfoDepthRef.current.amp = params.ampDepth;
      if (ampScaleRef.current) {
        const maxDbChange = 12 * params.ampDepth; // 最大±12dBの変化
        ampScaleRef.current.min = -maxDbChange;
        ampScaleRef.current.max = maxDbChange;
      }
    }

    // LFOパラメーター更新をログ出力（デバッグ用）
    console.log('LFO parameters updated and connected:', {
      rate: params.rate,
      filterDepth: params.filterDepth,
      ampDepth: params.ampDepth,
      waveform: params.waveform
    });
  }, []);

  // パラメーター変更時の更新
  useEffect(() => {
    if (isInitializedRef.current) {
      updateSynthParams(synthParams);
    }
  }, [synthParams, updateSynthParams]);

  useEffect(() => {
    if (isInitializedRef.current) {
      updateEffectParams(effectParams);
    }
  }, [effectParams, updateEffectParams]);

  useEffect(() => {
    if (isInitializedRef.current) {
      updateLfoParams(lfoParams);
    }
  }, [lfoParams, updateLfoParams]);

  // クリーンアップ
  useEffect(() => {
    return () => {
      // オーディオノードのクリーンアップ
      synthRef.current?.dispose();
      reverbRef.current?.dispose();
      delayRef.current?.dispose();
      chorusRef.current?.dispose();
      filterRef.current?.dispose();
      volumeNodeRef.current?.dispose();
      filterLfoRef.current?.dispose();
      ampLfoRef.current?.dispose();
      filterScaleRef.current?.dispose();
      ampScaleRef.current?.dispose();
    };
  }, []);

  return {
    synth: synthRef.current,
    startNote,
    stopNote,
    updateSynthParams,
    updateEffectParams,
    updateLfoParams,
    isAudioReady,
    audioError
  };
};
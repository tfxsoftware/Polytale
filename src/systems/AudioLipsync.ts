import type {
  ActiveDialogue,
  ActiveSound,
  ActorObjectDef,
  FrameState,
  PlayAudioWithLipsyncEvent,
  VoiceDef,
} from '../timeline/types';
import { clamp, clamp01, damp, hashString, lerp, seededRandom } from '../utils/math';

/** Estado de boca entregue ao Actor (valores 0..1 -> morph targets). */
export interface LipsyncState {
  /** Abertura da mandíbula (morph `jawOpen`) — dirigida pela energia RMS. */
  jawOpen: number;
  /** Boca esticada (vogais "e"/"i") — energia relativa de agudos. */
  mouthWide: number;
  /** Boca arredondada (vogais "o"/"u") — energia relativa de graves. */
  mouthPucker: number;
  /** Energia RMS bruta normalizada (0..1). */
  energy: number;
  speaking: boolean;
}

const SILENT: LipsyncState = { jawOpen: 0, mouthWide: 0, mouthPucker: 0, energy: 0, speaking: false };

/* ========================================================================== */
/*  Voz procedural (sintetizador de formantes)                                */
/* ========================================================================== */

type PhoneKind = 'vowel' | 'fricative' | 'plosive' | 'nasal' | 'liquid' | 'pause';

interface Phone {
  kind: PhoneKind;
  /** Segundos. */
  dur: number;
  /** Formantes F1..F3 (Hz) para fones sonoros. */
  formants: [number, number, number];
  /** Centro da banda de ruído (fricativas/plosivas). */
  noiseHz: number;
  pitchMul: number;
  amp: number;
  /** Abertura de boca esperada (para lipsync estimado). */
  open: number;
  wide: number;
  round: number;
}

export interface VoicePlan {
  phones: Phone[];
  duration: number;
}

const VOWELS: Record<string, { f: [number, number, number]; open: number; wide: number; round: number }> = {
  a: { f: [730, 1090, 2440], open: 1.0, wide: 0.2, round: 0.0 },
  e: { f: [530, 1840, 2480], open: 0.55, wide: 0.8, round: 0.0 },
  i: { f: [300, 2290, 3010], open: 0.25, wide: 1.0, round: 0.0 },
  o: { f: [570, 840, 2410], open: 0.6, wide: 0.0, round: 0.8 },
  u: { f: [320, 870, 2240], open: 0.3, wide: 0.0, round: 1.0 },
};

const FRICATIVES: Record<string, number> = { s: 5500, z: 5000, f: 1800, v: 1600, x: 3000, j: 2800, c: 4800 };
const PLOSIVES = new Set(['p', 't', 'k', 'b', 'd', 'g', 'q']);
const NASALS = new Set(['m', 'n']);
const LIQUIDS = new Set(['l', 'r']);

/**
 * "TTS procedural": converte texto em uma sequência de fones aproximados
 * (vogais com formantes, fricativas, plosivas...) e sintetiza um AudioBuffer.
 * Não é inteligível como fala real, mas tem ritmo/entonação do texto
 * (estilo "balbucio" de jogos clássicos) e alimenta o AnalyserNode de verdade.
 */
export class ProceduralVoice {
  static plan(text: string, voice: VoiceDef = {}): VoicePlan {
    const rate = clamp(voice.rate ?? 1, 0.3, 3);
    const timbre = clamp(voice.timbre ?? 1, 0.6, 1.8);
    const rand = seededRandom(hashString(text));
    const clean = text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();

    const phones: Phone[] = [];
    const push = (p: Omit<Phone, 'formants' | 'open' | 'wide' | 'round'> & Partial<Phone>) =>
      phones.push({ formants: [500, 1500, 2500], open: 0, wide: 0, round: 0, ...p });

    const sentenceEnds: number[] = [];
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      const next = clean[i + 1] ?? '';
      const jitter = 1 + (rand() - 0.5) * 0.08;

      if (ch === 'y') {
        const v = VOWELS.i;
        push({ kind: 'vowel', dur: 0.08 / rate, noiseHz: 0, pitchMul: jitter, amp: 1, ...scaleVowel(v, timbre) });
      } else if (ch in VOWELS) {
        const v = VOWELS[ch];
        // Vogal antes de espaço/pontuação é levemente alongada (sílaba tônica final).
        const stressed = /[\s.,!?;:]/.test(next) || next === '';
        push({
          kind: 'vowel',
          dur: (stressed ? 0.12 : 0.085) / rate,
          noiseHz: 0,
          pitchMul: jitter * (stressed ? 1.04 : 1),
          amp: 1,
          ...scaleVowel(v, timbre),
        });
      } else if (ch === 'c' && (next === 'h' || next === 'e' || next === 'i')) {
        push({ kind: 'fricative', dur: 0.07 / rate, noiseHz: next === 'h' ? 3000 : 5200, pitchMul: 1, amp: 0.35, wide: 0.3 });
        if (next === 'h') i++;
      } else if (ch === 'n' && next === 'h') {
        push({ kind: 'nasal', dur: 0.06 / rate, noiseHz: 0, pitchMul: jitter, amp: 0.45, formants: [280, 2000, 2700].map((f) => f * timbre) as [number, number, number], open: 0.1 });
        i++;
      } else if (ch === 'l' && next === 'h') {
        push({ kind: 'liquid', dur: 0.06 / rate, noiseHz: 0, pitchMul: jitter, amp: 0.6, formants: [300, 2100, 2800].map((f) => f * timbre) as [number, number, number], open: 0.2, wide: 0.4 });
        i++;
      } else if (ch in FRICATIVES || ch === 'ç') {
        push({ kind: 'fricative', dur: 0.075 / rate, noiseHz: FRICATIVES[ch] ?? 5000, pitchMul: 1, amp: ch === 'f' || ch === 'v' ? 0.25 : 0.35, wide: 0.25 });
      } else if (PLOSIVES.has(ch) || ch === 'c') {
        push({ kind: 'plosive', dur: 0.055 / rate, noiseHz: ch === 'p' || ch === 'b' ? 900 : ch === 't' || ch === 'd' ? 3500 : 2000, pitchMul: 1, amp: 0.5 });
      } else if (NASALS.has(ch)) {
        push({ kind: 'nasal', dur: 0.06 / rate, noiseHz: 0, pitchMul: jitter, amp: 0.45, formants: [250, 1100, 2400].map((f) => f * timbre) as [number, number, number], open: 0.05 });
      } else if (LIQUIDS.has(ch)) {
        push({ kind: 'liquid', dur: 0.05 / rate, noiseHz: 0, pitchMul: jitter, amp: 0.6, formants: [380, 1250, 2500].map((f) => f * timbre) as [number, number, number], open: 0.25 });
      } else if (ch === ' ') {
        push({ kind: 'pause', dur: 0.05 / rate, noiseHz: 0, pitchMul: 1, amp: 0 });
      } else if (ch === ',' || ch === ';' || ch === ':') {
        push({ kind: 'pause', dur: 0.2 / rate, noiseHz: 0, pitchMul: 1, amp: 0 });
      } else if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
        sentenceEnds.push(phones.length);
        push({ kind: 'pause', dur: 0.3 / rate, noiseHz: 0, pitchMul: ch === '?' ? 1.3 : 1, amp: ch === '!' ? 1.25 : 1 });
      }
      // 'h' isolado e demais símbolos são mudos.
    }

    // Entonação: declínio ao longo da frase; '?' sobe no final, '!' enfatiza.
    let segStart = 0;
    for (const endIdx of [...sentenceEnds, phones.length]) {
      const marker = phones[endIdx];
      const rising = marker?.kind === 'pause' && marker.pitchMul > 1.1;
      const emphatic = marker?.kind === 'pause' && marker.amp > 1.1;
      const count = Math.max(1, endIdx - segStart);
      for (let k = segStart; k < endIdx; k++) {
        const p = phones[k];
        const u = (k - segStart) / count;
        let contour = lerp(1.08, 0.9, u);
        if (rising && u > 0.7) contour *= lerp(1, 1.3, (u - 0.7) / 0.3);
        p.pitchMul *= contour;
        if (emphatic) p.amp *= 1.15;
      }
      if (marker && marker.kind === 'pause') {
        marker.pitchMul = 1;
        marker.amp = 0;
      }
      segStart = endIdx + 1;
    }

    const duration = phones.reduce((s, p) => s + p.dur, 0);
    return { phones, duration };
  }

  /** Renderiza o plano em amostras PCM mono (Float32). */
  static render(plan: VoicePlan, voice: VoiceDef, sampleRate: number): Float32Array {
    const f0 = clamp(voice.pitch ?? 140, 50, 600);
    const tail = 0.08;
    const out = new Float32Array(Math.ceil((plan.duration + tail) * sampleRate));
    const rand = seededRandom(hashString(`render:${plan.duration}:${f0}`));

    const formant = [new Biquad(), new Biquad(), new Biquad()];
    const noiseFilter = new Biquad();
    const formantGains = [1, 0.55, 0.25];
    const bandwidths = [90, 110, 160];
    let prevFormants: [number, number, number] = plan.phones.find((p) => p.kind === 'vowel')?.formants ?? [500, 1500, 2500];

    let phase = 0;
    let lp = 0;
    let n = 0;
    const block = 32;

    for (const ph of plan.phones) {
      const len = Math.max(1, Math.round(ph.dur * sampleRate));
      const attack = Math.min(len / 3, 0.012 * sampleRate);
      const release = Math.min(len / 3, 0.018 * sampleRate);
      const voiced = ph.kind === 'vowel' || ph.kind === 'nasal' || ph.kind === 'liquid';
      const from = prevFormants;
      const to = ph.formants;
      if (ph.noiseHz > 0) noiseFilter.bandpass(ph.noiseHz, 2.5, sampleRate);

      for (let i = 0; i < len && n < out.length; i++, n++) {
        if (i % block === 0 && voiced) {
          // Transição suave de formantes (coarticulação) nos primeiros 35% do fone.
          const k = clamp01(i / (len * 0.35));
          for (let f = 0; f < 3; f++) {
            const hz = lerp(from[f], to[f], k);
            formant[f].bandpass(hz, hz / bandwidths[f], sampleRate);
          }
        }
        const env = Math.min(1, i / attack, (len - i) / release);
        let s = 0;

        if (voiced) {
          const t = n / sampleRate;
          const vibrato = 1 + 0.012 * Math.sin(2 * Math.PI * 5.2 * t);
          const freq = f0 * ph.pitchMul * vibrato;
          phase += freq / sampleRate;
          if (phase >= 1) phase -= 1;
          // Pulso glotal aproximado: dente de serra suavizado + pequena aspiração.
          const saw = 1 - 2 * phase;
          lp += (saw - lp) * 0.35;
          const src = lp + (rand() - 0.5) * 0.04;
          for (let f = 0; f < 3; f++) s += formant[f].process(src) * formantGains[f];
          s *= ph.amp * 3.2;
        }
        if (ph.kind === 'fricative') {
          s += noiseFilter.process(rand() * 2 - 1) * ph.amp * 1.6;
        } else if (ph.kind === 'plosive') {
          // Oclusão (silêncio) seguida de explosão curta.
          const burstStart = len * 0.55;
          if (i > burstStart) {
            const b = 1 - (i - burstStart) / (len - burstStart);
            s += noiseFilter.process(rand() * 2 - 1) * ph.amp * b * 2.2;
          }
        }
        out[n] = s * env;
      }
      if (voiced) prevFormants = to;
    }

    // Normaliza o pico.
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0) {
      const g = 0.85 / peak;
      for (let i = 0; i < out.length; i++) out[i] *= g;
    }
    return out;
  }

  /** Lipsync estimado (sem áudio analisável) a partir do plano de fones. */
  static mouthAt(plan: VoicePlan, t: number): LipsyncState {
    if (t < 0 || t > plan.duration) return SILENT;
    let acc = 0;
    for (const p of plan.phones) {
      if (t < acc + p.dur) {
        const local = (t - acc) / p.dur;
        const env = Math.sin(Math.PI * clamp01(local)) ** 0.6;
        const amp = p.kind === 'pause' ? 0 : clamp01(p.amp);
        const open = (p.kind === 'vowel' ? p.open : p.open * 0.6 + (p.kind === 'plosive' ? 0.15 : 0.05)) * env * amp;
        return { jawOpen: open, mouthWide: p.wide * env * amp, mouthPucker: p.round * env * amp, energy: amp * env, speaking: true };
      }
      acc += p.dur;
    }
    return SILENT;
  }
}

function scaleVowel(v: (typeof VOWELS)[string], timbre: number) {
  return {
    formants: v.f.map((f) => f * timbre) as [number, number, number],
    open: v.open,
    wide: v.wide,
    round: v.round,
  };
}

/** Biquad (RBJ cookbook) em JS para síntese offline. */
class Biquad {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  bandpass(freq: number, q: number, sampleRate: number): void {
    const f = clamp(freq, 20, sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/* ========================================================================== */
/*  Sons procedurais (ambiência / SFX)                                         */
/* ========================================================================== */

function renderProceduralSound(name: string, sampleRate: number): { data: Float32Array; loop: boolean } {
  const rand = seededRandom(hashString(name));
  const sec = (s: number) => new Float32Array(Math.ceil(s * sampleRate));

  switch (name) {
    case 'procedural:wind': {
      const out = sec(6);
      let b0 = 0;
      let b1 = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sampleRate;
        const white = rand() * 2 - 1;
        b0 = 0.995 * b0 + white * 0.03; // ruído marrom (grave)
        b1 += (white - b1) * 0.08; // ruído filtrado (médio)
        const gust = 0.55 + 0.45 * Math.sin((2 * Math.PI * t) / 6) * Math.sin((2 * Math.PI * t) / 2.3 + 1);
        out[i] = (b0 * 2.2 + b1 * 0.35) * gust * 0.6;
      }
      return { data: makeLoopable(out, sampleRate, 0.5), loop: true };
    }
    case 'procedural:fire': {
      const out = sec(4);
      let b = 0;
      for (let i = 0; i < out.length; i++) {
        const white = rand() * 2 - 1;
        b = 0.98 * b + white * 0.06;
        let s = b * 0.9;
        if (rand() < 0.0009) {
          // estalo
          const len = Math.floor(sampleRate * 0.012);
          for (let k = 0; k < len && i + k < out.length; k++) out[i + k] += (rand() * 2 - 1) * (1 - k / len) * 0.7;
        }
        out[i] += s;
      }
      return { data: makeLoopable(out, sampleRate, 0.3), loop: true };
    }
    case 'procedural:thunder': {
      const out = sec(6);
      let b = 0;
      let lp = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sampleRate;
        const white = rand() * 2 - 1;
        b = 0.997 * b + white * 0.05;
        lp += (b - lp) * 0.05;
        const crack = t < 0.25 ? (rand() * 2 - 1) * (1 - t / 0.25) * 0.8 : 0;
        const rumble = Math.exp(-t * 0.7) * (0.7 + 0.3 * Math.sin(t * 9 + Math.sin(t * 3) * 2));
        out[i] = lp * 8 * rumble + crack;
      }
      return { data: normalize(out, 0.95), loop: false };
    }
    case 'procedural:chime':
    default: {
      const out = sec(2.5);
      const partials = [880, 1318.5, 1760, 2637];
      for (let i = 0; i < out.length; i++) {
        const t = i / sampleRate;
        let s = 0;
        partials.forEach((f, k) => (s += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * (2 + k * 1.5)) / (k + 1)));
        out[i] = s * 0.5 * Math.min(1, t / 0.005);
      }
      return { data: out, loop: false };
    }
  }
}

function normalize(data: Float32Array, peakTarget: number): Float32Array {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] *= peakTarget / peak;
  return data;
}

/** Crossfade do final com o início para loop sem clique. */
function makeLoopable(data: Float32Array, sampleRate: number, fadeSec: number): Float32Array {
  const n = Math.floor(fadeSec * sampleRate);
  const out = new Float32Array(data.length - n);
  out.set(data.subarray(0, out.length));
  for (let i = 0; i < n; i++) {
    const k = i / n;
    out[i] = data[i] * k + data[out.length + i] * (1 - k);
  }
  return normalize(out, 0.8);
}

/* ========================================================================== */
/*  AudioLipsync                                                              */
/* ========================================================================== */

interface ActorChannel {
  input: GainNode;
  analyser: AnalyserNode;
  timeData: Float32Array<ArrayBuffer>;
  freqData: Uint8Array<ArrayBuffer>;
  state: LipsyncState;
}

interface PlayingBuffer {
  kind: 'buffer';
  source: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
  offset: number;
  rate: number;
  loop: boolean;
  duration: number;
}

interface PlayingSpeech {
  kind: 'speech';
}

type Playing = PlayingBuffer | PlayingSpeech;

/**
 * Áudio + lipsync.
 *
 * - Cada ator tem um canal: GainNode -> AnalyserNode (fftSize 1024 = 512 bandas) -> master.
 * - A energia RMS (domínio do tempo) aciona o morph `jawOpen`; a distribuição
 *   espectral das 512 bandas separa boca esticada (agudos) de arredondada (graves).
 * - Sem arquivo de áudio: voz 'speech' usa window.speechSynthesis (fallback nativo)
 *   com boca estimada pelo texto; voz 'babble' sintetiza um AudioBuffer procedural.
 * - `sync(frame)` mantém as fontes de áudio alinhadas à timeline (seek/pause/rate).
 */
export class AudioLipsync {
  readonly context: AudioContext;
  /** Saída final da mixagem (pós-compressor) — ponto de captura para gravação. */
  readonly output: AudioNode;
  private readonly master: GainNode;
  private readonly sfxBus: GainNode;
  private readonly channels = new Map<string, ActorChannel>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly plans = new Map<string, VoicePlan>();
  private readonly playing = new Map<string, Playing>();
  private readonly voices = new Map<string, VoiceDef>();
  private readonly speechAvailable: boolean;
  private lastDiscontinuity = -1;
  private _muted = false;
  private speakingSpeechKey: string | null = null;

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new Ctor();
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 4;
    this.master = this.context.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(compressor).connect(this.context.destination);
    this.output = compressor;
    this.sfxBus = this.context.createGain();
    this.sfxBus.gain.value = 0.6;
    this.sfxBus.connect(this.master);
    this.speechAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  get muted(): boolean {
    return this._muted;
  }

  /** Deve ser chamado a partir de um gesto do usuário (política de autoplay). */
  async unlock(): Promise<void> {
    if (this.context.state !== 'running') {
      try {
        await this.context.resume();
      } catch (err) {
        console.warn('[AudioLipsync] não foi possível iniciar o AudioContext', err);
      }
    }
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.context.currentTime, 0.02);
    if (muted) this.cancelSpeech();
  }

  /** Buffers decodificados pelo AssetLoader. */
  registerBuffer(url: string, buffer: AudioBuffer): void {
    this.buffers.set(url, buffer);
  }

  /** Configura canais/vozes para os atores da história (chamado antes da compilação). */
  configureActors(actors: Iterable<[string, ActorObjectDef]>): void {
    this.stopAll();
    for (const ch of this.channels.values()) ch.input.disconnect();
    this.channels.clear();
    this.voices.clear();
    for (const [id, def] of actors) {
      const input = this.context.createGain();
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 1024; // 512 bandas de frequência
      analyser.smoothingTimeConstant = 0.35;
      input.connect(analyser).connect(this.master);
      this.channels.set(id, {
        input,
        analyser,
        timeData: new Float32Array(analyser.fftSize),
        freqData: new Uint8Array(analyser.frequencyBinCount),
        state: { ...SILENT },
      });
      this.voices.set(id, def.voice ?? {});
    }
  }

  /**
   * Duração real da fala quando conhecida (buffer de arquivo ou voz procedural).
   * Usado pelo ActionRegistry na compilação. Para 'speech' retorna undefined (estimativa por texto).
   */
  durationFor(ev: PlayAudioWithLipsyncEvent, actor: ActorObjectDef | undefined): number | undefined {
    if (ev.audio) {
      const buf = this.buffers.get(ev.audio);
      if (buf) return buf.duration;
    }
    const voice = actor?.voice ?? {};
    if ((voice.engine ?? 'speech') === 'babble') return this.babbleBuffer(ev.text, voice).duration;
    return undefined;
  }

  soundDuration(src: string): number | undefined {
    return this.soundBuffer(src)?.duration;
  }

  /** Estado de boca atual (suavizado) de um ator. */
  getState(actorId: string): LipsyncState {
    return this.channels.get(actorId)?.state ?? SILENT;
  }

  /** Alinha as fontes de áudio ao estado da timeline. Chamado a cada quadro. */
  sync(frame: FrameState, playing: boolean, rate: number, discontinuity: number): void {
    const jumped = discontinuity !== this.lastDiscontinuity;
    this.lastDiscontinuity = discontinuity;

    const live = new Set<string>();
    if (playing) {
      for (const d of frame.dialogues) {
        live.add(d.key);
        this.syncDialogue(d, rate, jumped);
      }
      for (const s of frame.sounds) {
        live.add(s.key);
        this.syncSound(s, rate);
      }
    }
    for (const key of [...this.playing.keys()]) if (!live.has(key)) this.stop(key);
  }

  /** Analisa os canais e atualiza o estado de boca. `frame` permite o lipsync estimado. */
  update(dt: number, frame: FrameState, playing: boolean): void {
    const speakingActors = new Map<string, ActiveDialogue>();
    for (const d of frame.dialogues) if (d.localTime < d.speakDuration) speakingActors.set(d.actorId, d);

    for (const [id, ch] of this.channels) {
      const d = speakingActors.get(id);
      let target: LipsyncState = SILENT;

      if (d && playing) {
        const p = this.playing.get(d.key);
        if (p?.kind === 'buffer') target = this.analyse(ch);
        else target = this.estimated(d, id);
      }

      const s = ch.state;
      // Ataque rápido, release mais lento (boca não "trava" aberta, mas também não treme).
      const lambda = (cur: number, tgt: number) => (tgt > cur ? 28 : 14);
      s.jawOpen = damp(s.jawOpen, target.jawOpen, lambda(s.jawOpen, target.jawOpen), dt);
      s.mouthWide = damp(s.mouthWide, target.mouthWide, 16, dt);
      s.mouthPucker = damp(s.mouthPucker, target.mouthPucker, 16, dt);
      s.energy = damp(s.energy, target.energy, 20, dt);
      s.speaking = target.speaking;
    }
  }

  dispose(): void {
    this.stopAll();
    void this.context.close();
  }

  /* ---------------------------------------------------------------------- */

  private analyse(ch: ActorChannel): LipsyncState {
    ch.analyser.getFloatTimeDomainData(ch.timeData);
    let sum = 0;
    for (let i = 0; i < ch.timeData.length; i++) sum += ch.timeData[i] * ch.timeData[i];
    const rms = Math.sqrt(sum / ch.timeData.length);
    // Gate de ruído + curva de resposta perceptual.
    const energy = clamp01((rms - 0.012) * 5.5) ** 0.7;

    ch.analyser.getByteFrequencyData(ch.freqData);
    const binHz = this.context.sampleRate / ch.analyser.fftSize;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let i = 1; i < ch.freqData.length; i++) {
      const hz = i * binHz;
      const v = ch.freqData[i] / 255;
      if (hz < 900) low += v;
      else if (hz < 2200) mid += v;
      else if (hz < 6000) high += v;
    }
    const total = low + mid + high + 1e-6;
    const highRatio = (high + mid * 0.5) / total;
    const lowRatio = low / total;
    return {
      jawOpen: energy,
      mouthWide: clamp01(energy * (highRatio - 0.15) * 2.2),
      mouthPucker: clamp01(energy * (lowRatio - 0.55) * 2.5),
      energy,
      speaking: true,
    };
  }

  private estimated(d: ActiveDialogue, actorId: string): LipsyncState {
    const voice = this.voices.get(actorId) ?? {};
    const plan = this.planFor(d.text, voice);
    // Estica o plano para caber exatamente no tempo de fala da timeline.
    const t = (d.localTime / Math.max(0.001, d.speakDuration)) * plan.duration;
    return ProceduralVoice.mouthAt(plan, t);
  }

  private planFor(text: string, voice: VoiceDef): VoicePlan {
    const key = `${text}|${voice.rate ?? 1}|${voice.timbre ?? 1}`;
    let plan = this.plans.get(key);
    if (!plan) {
      plan = ProceduralVoice.plan(text, voice);
      this.plans.set(key, plan);
    }
    return plan;
  }

  private babbleBuffer(text: string, voice: VoiceDef): AudioBuffer {
    const key = `babble:${text}|${voice.pitch ?? 140}|${voice.rate ?? 1}|${voice.timbre ?? 1}`;
    let buf = this.buffers.get(key);
    if (!buf) {
      const data = ProceduralVoice.render(this.planFor(text, voice), voice, this.context.sampleRate);
      buf = this.context.createBuffer(1, data.length, this.context.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(key, buf);
    }
    return buf;
  }

  private soundBuffer(src: string): AudioBuffer | undefined {
    if (!src.startsWith('procedural:')) return this.buffers.get(src);
    let buf = this.buffers.get(src);
    if (!buf) {
      const { data } = renderProceduralSound(src, this.context.sampleRate);
      buf = this.context.createBuffer(1, data.length, this.context.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(src, buf);
    }
    return buf;
  }

  private dialogueBuffer(d: ActiveDialogue, voice: VoiceDef): AudioBuffer | undefined {
    if (d.audio) {
      const buf = this.buffers.get(d.audio);
      if (buf) return buf;
    }
    if ((voice.engine ?? 'speech') === 'babble') return this.babbleBuffer(d.text, voice);
    return undefined;
  }

  private syncDialogue(d: ActiveDialogue, rate: number, jumped: boolean): void {
    const voice = this.voices.get(d.actorId) ?? {};
    const ch = this.channels.get(d.actorId);
    if (!ch) return;
    const buffer = this.dialogueBuffer(d, voice);

    if (buffer) {
      if (d.localTime >= buffer.duration) {
        this.stop(d.key);
        return;
      }
      this.ensureBuffer(d.key, buffer, d.localTime, rate, false, d.volume * (voice.volume ?? 1), ch.input);
      return;
    }

    // Fallback nativo: Web Speech API.
    const engine = voice.engine ?? 'speech';
    if (engine !== 'speech' || !this.speechAvailable || this._muted) return;
    if (jumped && this.playing.has(d.key)) this.stop(d.key);
    // speechSynthesis não suporta offset: só inicia perto do começo da fala.
    if (!this.playing.has(d.key) && d.localTime < 0.35) {
      this.speak(d, voice, rate);
      this.playing.set(d.key, { kind: 'speech' });
    }
  }

  private syncSound(s: ActiveSound, rate: number): void {
    const buffer = this.soundBuffer(s.src);
    if (!buffer) return;
    const offset = s.loop ? s.localTime % buffer.duration : s.localTime;
    if (!s.loop && offset >= buffer.duration) {
      this.stop(s.key);
      return;
    }
    this.ensureBuffer(s.key, buffer, offset, rate, s.loop, s.volume, this.sfxBus);
  }

  /** Garante que a fonte toca na posição esperada; reinicia se houver drift. */
  private ensureBuffer(
    key: string,
    buffer: AudioBuffer,
    expectedOffset: number,
    rate: number,
    loop: boolean,
    volume: number,
    destination: AudioNode,
  ): void {
    const now = this.context.currentTime;
    const cur = this.playing.get(key);
    if (cur?.kind === 'buffer') {
      let actual = cur.offset + (now - cur.startedAt) * cur.rate;
      if (cur.loop) actual %= cur.duration;
      let drift = Math.abs(actual - expectedOffset);
      if (cur.loop) drift = Math.min(drift, cur.duration - drift);
      if (drift < 0.12 && Math.abs(cur.rate - rate) < 1e-3) return;
      this.stop(key);
    }
    if (this.context.state !== 'running') return;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = rate;
    const gain = this.context.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(clamp(volume, 0, 2), now, 0.01);
    source.connect(gain).connect(destination);
    source.start(now, clamp(expectedOffset, 0, Math.max(0, buffer.duration - 0.001)));
    this.playing.set(key, { kind: 'buffer', source, gain, startedAt: now, offset: expectedOffset, rate, loop, duration: buffer.duration });
  }

  private speak(d: ActiveDialogue, voice: VoiceDef, rate: number): void {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(d.text);
    const lang = voice.lang ?? 'pt-BR';
    u.lang = lang;
    u.rate = clamp((voice.rate ?? 1) * rate, 0.1, 4);
    const pitch = voice.pitch ?? 1;
    u.pitch = clamp(pitch > 2 ? pitch / 150 : pitch, 0, 2);
    u.volume = clamp(d.volume * (voice.volume ?? 1), 0, 1);
    const voices = synth.getVoices();
    const match = voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(lang.split('-')[0]));
    if (match) u.voice = match;
    this.speakingSpeechKey = d.key;
    u.onend = () => {
      if (this.speakingSpeechKey === d.key) this.speakingSpeechKey = null;
    };
    synth.speak(u);
  }

  private cancelSpeech(): void {
    if (this.speechAvailable && this.speakingSpeechKey) window.speechSynthesis.cancel();
    this.speakingSpeechKey = null;
  }

  private stop(key: string): void {
    const p = this.playing.get(key);
    if (!p) return;
    this.playing.delete(key);
    if (p.kind === 'buffer') {
      const now = this.context.currentTime;
      p.gain.gain.setTargetAtTime(0, now, 0.015);
      try {
        p.source.stop(now + 0.06);
      } catch {
        /* já parado */
      }
      p.source.onended = () => {
        p.source.disconnect();
        p.gain.disconnect();
      };
    } else if (this.speakingSpeechKey === key) {
      this.cancelSpeech();
    }
  }

  private stopAll(): void {
    for (const key of [...this.playing.keys()]) this.stop(key);
    this.cancelSpeech();
  }
}

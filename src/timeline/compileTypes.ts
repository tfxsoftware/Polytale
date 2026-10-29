import type {
  ActorObjectDef,
  CameraShotDef,
  EasingName,
  EventType,
  FrameState,
  LightDef,
  ObjectDef,
  PlayAudioWithLipsyncEvent,
  StoryEvent,
  StoryScript,
} from './types';
import type { InteractionContext } from './interactions';
import type { EasingFn, Interpolator } from './easing';

/* ========================================================================== */
/*  Contratos dos handlers                                                    */
/* ========================================================================== */

/**
 * Escrita contínua/instantânea em um canal de estado.
 * Ações no mesmo canal se sobrepõem em ordem temporal; o valor inicial
 * (`from`) de cada segmento é amostrado do canal no instante do evento,
 * o que torna interrupções suaves e o seek determinístico.
 */
export interface TrackWrite<V> {
  channel: string;
  get(frame: FrameState): V;
  set(frame: FrameState, value: V): void;
  interpolate: Interpolator<V>;
  resolve(from: V): V;
  /** Sobrescreve a duração do evento só para este canal. */
  duration?: number;
}

/** Efeito com janela de tempo (legenda, tremor, gesto, som). */
export interface IntervalWrite {
  /** Pode ser Infinity (ex.: som em loop sem duração). */
  duration: number;
  apply(frame: FrameState, localTime: number, progress: number): void;
}

/** Erasure de tipo para armazenar tracks heterogêneos. */
export type AnyTrack = TrackWrite<unknown>;
export function track<V>(t: TrackWrite<V>): AnyTrack {
  return t as unknown as AnyTrack;
}

export interface CompileContext {
  script: StoryScript;
  objects: ReadonlyMap<string, ObjectDef>;
  lights: ReadonlyMap<string, LightDef>;
  shots: ReadonlyMap<string, CameraShotDef>;
  /** Índice do evento na lista original. */
  index: number;
  /** Consultas ao estado já compilado (posições/rotações no tempo). */
  query: InteractionContext;
  speechDuration(ev: PlayAudioWithLipsyncEvent): number;
  soundDuration(src: string): number | undefined;
}

export interface ActionHandler<E extends StoryEvent = StoryEvent> {
  /** Duração padrão quando o evento não informa `duration`. */
  defaultDuration?: number;
  defaultEasing?: EasingName;
  validate?(ev: E, ctx: CompileContext): string[];
  tracks?(ev: E, ctx: CompileContext): AnyTrack[];
  interval?(ev: E, ctx: CompileContext): IntervalWrite | null;
  /**
   * Macro: gera eventos derivados (com `time` >= ao do evento), que entram na
   * fila de compilação e são validados normalmente.
   */
  expand?(ev: E, ctx: CompileContext): StoryEvent[];
}

export interface CompileOptions {
  /** Duração de fala conhecida (ex.: AudioBuffer carregado ou voz sintetizada). */
  speechDuration?: (ev: PlayAudioWithLipsyncEvent, actor: ActorObjectDef | undefined) => number | undefined;
  soundDuration?: (src: string) => number | undefined;
}

export interface Segment {
  start: number;
  duration: number;
  ease: EasingFn;
  from: unknown;
  to: unknown;
  write: AnyTrack;
}

export interface Interval {
  start: number;
  duration: number;
  write: IntervalWrite;
}

export interface CompiledStory {
  script: StoryScript;
  duration: number;
  objects: ReadonlyMap<string, ObjectDef>;
  lights: ReadonlyMap<string, LightDef>;
  shots: ReadonlyMap<string, CameraShotDef>;
  warnings: string[];
  /** Marcadores para UI (ex.: falas no scrubber). */
  markers: { time: number; type: EventType; label: string }[];
  readonly base: FrameState;
  readonly channels: ReadonlyMap<string, Segment[]>;
  readonly intervals: readonly Interval[];
}

export class StoryScriptError extends Error {
  constructor(readonly errors: string[]) {
    super(`StoryScript inválido:\n- ${errors.join('\n- ')}`);
    this.name = 'StoryScriptError';
  }
}

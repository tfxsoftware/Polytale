import {
  ACCESSORIES,
  BODY_BUILDS,
  BODY_PARTS,
  HAIR_STYLES,
  HEAD_SHAPES,
  OUTFITS,
  CAMERA_PRESETS,
  SOCKETS,
  DEFAULT_RETRO_SETTINGS,
  EASINGS,
  EXPRESSIONS,
  GESTURES,
  PROCEDURAL_SOUNDS,
  estimateSpeechDuration,
  type ActorFrame,
  type AttachValue,
  type Hand,
  type PoseFrame,
  type ReachFrame,
  type ReachTarget,
  type SocketRef,
  type ActorObjectDef,
  type CameraShotDef,
  type CameraShotSpec,
  type CameraValue,
  type ClipState,
  type EasingName,
  type EventOf,
  type EventType,
  type ExpressionWeights,
  type FrameState,
  type LightDef,
  type LookTarget,
  type ObjectDef,
  type ObjectFrame,
  type PlayAudioWithLipsyncEvent,
  type RGB,
  type RetroSettings,
  type StoryEvent,
  type StoryScript,
  type Vec3,
} from './types';
import { clamp01, hashString, hexToRgb, isHexColor, lerp, shortestAngleDeltaDeg } from '../utils/math';
import { interpolatePose, poseFrameFrom, resolvePose, restPoseFrame, validateGestureDef, validatePoseDef } from './poses';
import { expandInteraction, validateInteraction, type InteractionContext } from './interactions';

/* ========================================================================== */
/*  Easings                                                                   */
/* ========================================================================== */

export type EasingFn = (t: number) => number;

export const Easings: Record<EasingName, EasingFn> = {
  linear: (t) => t,
  step: (t) => (t < 1 ? 0 : 1),
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeOutElastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  easeOutBounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

/* ========================================================================== */
/*  Interpoladores                                                            */
/* ========================================================================== */

export type Interpolator<V> = (from: V, to: V, alpha: number) => V;

export const Interp = {
  number: ((a, b, t) => lerp(a, b, t)) as Interpolator<number>,
  vec3: ((a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]) as Interpolator<Vec3>,
  /** Euler em graus pelo menor caminho em cada eixo. */
  angles: ((a, b, t) => [
    a[0] + shortestAngleDeltaDeg(a[0], b[0]) * t,
    a[1] + shortestAngleDeltaDeg(a[1], b[1]) * t,
    a[2] + shortestAngleDeltaDeg(a[2], b[2]) * t,
  ]) as Interpolator<Vec3>,
  rgb: ((a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]) as Interpolator<RGB>,
  weights: ((a, b, t) => {
    const out = {} as ExpressionWeights;
    for (const k of EXPRESSIONS) out[k] = lerp(a[k], b[k], t);
    return out;
  }) as Interpolator<ExpressionWeights>,
  settings: ((a, b, t) => {
    const out = { ...a };
    for (const k of Object.keys(b) as (keyof RetroSettings)[]) out[k] = lerp(a[k], b[k], t);
    return out;
  }) as Interpolator<RetroSettings>,
  camera: ((a, b, t) => (t >= 1 ? b : t <= 0 ? a : { kind: 'blend', from: a, to: b, alpha: t })) as Interpolator<CameraValue>,
  pose: interpolatePose as Interpolator<PoseFrame>,
  reach: ((a, b, t) => ({
    target: b.target,
    prev: b.prev,
    // Troca de alvo com o braço estendido: mistura prev -> target ao longo do segmento.
    blend: b.prev !== null ? t : b.blend,
    weight: lerp(a.weight, b.weight, t),
    shake: lerp(a.shake, b.shake, t),
  })) as Interpolator<ReachFrame>,
  attach: ((_a, b, t) => ({ from: b.from, to: b.to, alpha: t })) as Interpolator<AttachValue>,
  step<V>(): Interpolator<V> {
    return (a, b, t) => (t >= 1 ? b : a);
  },
};

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
type AnyTrack = TrackWrite<unknown>;
function track<V>(t: TrackWrite<V>): AnyTrack {
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

interface Segment {
  start: number;
  duration: number;
  ease: EasingFn;
  from: unknown;
  to: unknown;
  write: AnyTrack;
}

interface Interval {
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

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function neutralWeights(): ExpressionWeights {
  const w = {} as ExpressionWeights;
  for (const k of EXPRESSIONS) w[k] = 0;
  return w;
}

function cloneFrame(f: FrameState, time: number): FrameState {
  const objects: Record<string, ObjectFrame> = {};
  for (const k in f.objects) objects[k] = { ...f.objects[k] };
  const actors: Record<string, ActorFrame> = {};
  for (const k in f.actors) actors[k] = { ...f.actors[k] };
  const lights: FrameState['lights'] = {};
  for (const k in f.lights) lights[k] = { ...f.lights[k] };
  return {
    time,
    objects,
    actors,
    lights,
    camera: f.camera,
    shakes: [],
    fx: { ...f.fx, settings: { ...f.fx.settings } },
    hour: f.hour,
    dialogues: [],
    sounds: [],
  };
}

function requireActor(id: unknown, ctx: CompileContext, field = 'target'): string[] {
  if (typeof id !== 'string') return [`'${field}' deve ser o id (string) de um ator`];
  const def = ctx.objects.get(id);
  if (!def) return [`'${field}': objeto '${id}' nunca é criado (falta SPAWN_OBJECT)`];
  if (def.kind !== 'actor') return [`'${field}': '${id}' não é um ator`];
  return [];
}

function requireObject(id: unknown, ctx: CompileContext): string[] {
  if (typeof id !== 'string') return [`'target' deve ser o id (string) de um objeto`];
  if (!ctx.objects.has(id)) return [`'target': objeto '${id}' nunca é criado (falta SPAWN_OBJECT)`];
  return [];
}

function validateShotSpec(ev: CameraShotSpec, ctx: CompileContext): string[] {
  const errs: string[] = [];
  if (ev.shot !== undefined) {
    if (!ctx.shots.has(ev.shot)) errs.push(`plano '${ev.shot}' não existe em 'cameras'`);
  } else if (ev.preset !== undefined) {
    if (!CAMERA_PRESETS.includes(ev.preset)) errs.push(`preset '${ev.preset}' inválido (use ${CAMERA_PRESETS.join(', ')})`);
    if (ev.subject !== undefined) errs.push(...requireActor(ev.subject, ctx, 'subject'));
    if (ev.over !== undefined) errs.push(...requireActor(ev.over, ctx, 'over'));
    if ((ev.preset === 'close_up' || ev.preset === 'medium' || ev.preset === 'over_shoulder') && ev.subject === undefined) {
      errs.push(`preset '${ev.preset}' exige 'subject'`);
    }
  } else {
    errs.push(`informe 'shot' (id em cameras) ou 'preset'`);
  }
  if (ev.fov !== undefined && (!isNum(ev.fov) || ev.fov <= 1 || ev.fov >= 170)) errs.push(`'fov' deve estar entre 1 e 170`);
  if (ev.offset !== undefined && !isVec3(ev.offset)) errs.push(`'offset' deve ser [x, y, z]`);
  return errs;
}

function shotSpecOf(ev: CameraShotSpec): CameraShotSpec {
  const { shot, preset, subject, over, side, fov, offset, handheld } = ev;
  const spec: CameraShotSpec = {};
  if (shot !== undefined) spec.shot = shot;
  if (preset !== undefined) spec.preset = preset;
  if (subject !== undefined) spec.subject = subject;
  if (over !== undefined) spec.over = over;
  if (side !== undefined) spec.side = side;
  if (fov !== undefined) spec.fov = fov;
  if (offset !== undefined) spec.offset = offset;
  if (handheld !== undefined) spec.handheld = handheld;
  return spec;
}

/* ---- Fábricas de tracks reutilizáveis ---- */

function objectPositionTrack(id: string, to: Vec3, duration?: number): AnyTrack {
  return track<Vec3>({
    channel: `object:${id}:position`,
    get: (f) => f.objects[id].position,
    set: (f, v) => {
      f.objects[id].position = v;
    },
    interpolate: Interp.vec3,
    resolve: () => to,
    duration,
  });
}

function objectRotationTrack(id: string, to: Vec3, duration?: number): AnyTrack {
  return track<Vec3>({
    channel: `object:${id}:rotation`,
    get: (f) => f.objects[id].rotation,
    set: (f, v) => {
      f.objects[id].rotation = v;
    },
    interpolate: Interp.angles,
    resolve: () => to,
    duration,
  });
}

function objectScaleTrack(id: string, to: number, duration?: number): AnyTrack {
  return track<number>({
    channel: `object:${id}:scale`,
    get: (f) => f.objects[id].scale,
    set: (f, v) => {
      f.objects[id].scale = v;
    },
    interpolate: Interp.number,
    resolve: () => to,
    duration,
  });
}

function objectVisibleTrack(id: string, to: boolean): AnyTrack {
  return track<boolean>({
    channel: `object:${id}:visible`,
    get: (f) => f.objects[id].visible,
    set: (f, v) => {
      f.objects[id].visible = v;
    },
    interpolate: Interp.step<boolean>(),
    resolve: () => to,
    duration: 0,
  });
}

function isReachTarget(v: unknown, ctx: CompileContext): string[] {
  if (typeof v === 'string') return ctx.objects.has(v) ? [] : [`alvo '${v}' não existe`];
  if (isVec3(v)) return [];
  if (!isObj(v)) return [`'to' deve ser id, [x, y, z], { target, part } ou { midpoint }`];
  const errs: string[] = [];
  if ('midpoint' in v) {
    const m = v.midpoint;
    if (!Array.isArray(m) || m.length !== 2 || !m.every((id) => typeof id === 'string' && ctx.objects.has(id))) {
      errs.push(`'midpoint' deve ser [idA, idB] de objetos existentes`);
    }
    if (v.height !== undefined && !isNum(v.height)) errs.push(`'height' deve ser número`);
  } else {
    if (typeof v.target !== 'string' || !ctx.objects.has(v.target)) errs.push(`'to.target' deve ser id de objeto existente`);
    if (v.part !== undefined && !(BODY_PARTS as readonly string[]).includes(String(v.part))) {
      errs.push(`'to.part' inválido (use ${BODY_PARTS.join(', ')})`);
    }
  }
  if (v.offset !== undefined && !isVec3(v.offset)) errs.push(`'offset' deve ser [x, y, z]`);
  return errs;
}

function validateActorStyle(def: ActorObjectDef): string[] {
  const errs: string[] = [];
  const oneOf = (field: string, value: unknown, list: readonly string[]) => {
    if (value !== undefined && !list.includes(String(value))) errs.push(`'object.${field}' inválido (use ${list.join(', ')})`);
  };
  oneOf('build', def.build, BODY_BUILDS);
  oneOf('headShape', def.headShape, HEAD_SHAPES);
  oneOf('hair', def.hair, HAIR_STYLES);
  oneOf('outfit', def.outfit, OUTFITS);
  if (def.accessories !== undefined) {
    if (!Array.isArray(def.accessories)) errs.push(`'object.accessories' deve ser um array`);
    else for (const a of def.accessories) oneOf('accessories', a, ACCESSORIES);
  }
  return errs;
}

function reachTrack(id: string, hand: Hand, to: ReachTarget | null, shake: number): AnyTrack {
  return track<ReachFrame>({
    channel: `actor:${id}:reach:${hand}`,
    get: (f) => f.actors[id].reach[hand],
    set: (f, v) => {
      const a = f.actors[id];
      a.reach = { ...a.reach, [hand]: v };
    },
    interpolate: Interp.reach,
    resolve: (from) => {
      if (to === null) return { target: from.target, prev: null, blend: 1, weight: 0, shake: 0 };
      const extended = from.weight > 0.01 && from.target !== null;
      return { target: to, prev: extended ? from.target : null, blend: 1, weight: 1, shake };
    },
  });
}

function attachTrack(id: string, to: SocketRef | null, duration?: number): AnyTrack {
  return track<AttachValue>({
    channel: `object:${id}:attach`,
    get: (f) => f.objects[id].attach,
    set: (f, v) => {
      f.objects[id].attach = v;
    },
    interpolate: Interp.attach,
    // Parte do encaixe "efetivo" atual (se a transição anterior não terminou, usa o mais próximo).
    resolve: (from) => ({ from: from.alpha >= 0.5 ? from.to : from.from, to, alpha: 1 }),
    duration,
  });
}

function heightOf(ctx: CompileContext, id: string): number {
  const def = ctx.objects.get(id);
  return def?.kind === 'actor' ? def.height ?? 1.75 : 1;
}

/* ========================================================================== */
/*  Handlers padrão                                                           */
/* ========================================================================== */

const GESTURE_DURATIONS: Record<string, number> = {
  wave: 1.6,
  point: 1.4,
  shrug: 1.2,
  nod: 0.9,
  headShake: 1.1,
  bow: 1.8,
};

type HandlerMap = { [K in EventType]: ActionHandler<EventOf<K>> };

function createDefaultHandlers(): HandlerMap {
  return {
    SPAWN_OBJECT: {
      validate(ev, ctx) {
        const errs: string[] = [];
        if (typeof ev.target !== 'string' || !ev.target) errs.push(`'target' (id do objeto) é obrigatório`);
        else if (!ctx.objects.has(ev.target)) errs.push(`o primeiro SPAWN_OBJECT de '${ev.target}' precisa de 'object' (ou de uma entrada em 'cast')`);
        if (ev.object !== undefined) {
          if (!isObj(ev.object)) errs.push(`'object' deve ser um objeto`);
          else if (ev.object.kind === 'actor') {
            if (typeof ev.object.name !== 'string') errs.push(`'object.name' é obrigatório para atores`);
            errs.push(...validateActorStyle(ev.object));
          } else if (ev.object.kind === 'prop') {
            if (typeof ev.object.prop !== 'string') errs.push(`'object.prop' é obrigatório para props`);
          } else errs.push(`'object.kind' deve ser 'actor' ou 'prop'`);
        }
        if (ev.position !== undefined && !isVec3(ev.position)) errs.push(`'position' deve ser [x, y, z]`);
        if (ev.rotation !== undefined && !isVec3(ev.rotation)) errs.push(`'rotation' deve ser [x, y, z] em graus`);
        if (ev.scale !== undefined && (!isNum(ev.scale) || ev.scale <= 0)) errs.push(`'scale' deve ser > 0`);
        return errs;
      },
      tracks(ev) {
        const t = [objectVisibleTrack(ev.target, true)];
        if (ev.position) t.push(objectPositionTrack(ev.target, ev.position, 0));
        if (ev.rotation) t.push(objectRotationTrack(ev.target, ev.rotation, 0));
        if (ev.scale !== undefined) t.push(objectScaleTrack(ev.target, ev.scale, 0));
        return t;
      },
    },

    DESPAWN_OBJECT: {
      validate: (ev, ctx) => requireObject(ev.target, ctx),
      tracks: (ev) => [objectVisibleTrack(ev.target, false)],
    },

    TRANSFORM_OBJECT: {
      defaultDuration: 0,
      defaultEasing: 'easeInOutQuad',
      validate(ev, ctx) {
        const errs = requireObject(ev.target, ctx);
        if (ev.position === undefined && ev.rotation === undefined && ev.scale === undefined) {
          errs.push(`informe 'position', 'rotation' e/ou 'scale'`);
        }
        if (ev.position !== undefined && !isVec3(ev.position)) errs.push(`'position' deve ser [x, y, z]`);
        if (ev.rotation !== undefined && !isVec3(ev.rotation)) errs.push(`'rotation' deve ser [x, y, z] em graus`);
        if (ev.scale !== undefined && (!isNum(ev.scale) || ev.scale <= 0)) errs.push(`'scale' deve ser > 0`);
        return errs;
      },
      tracks(ev) {
        const t: AnyTrack[] = [];
        if (ev.position) t.push(objectPositionTrack(ev.target, ev.position));
        if (ev.rotation) t.push(objectRotationTrack(ev.target, ev.rotation));
        if (ev.scale !== undefined) t.push(objectScaleTrack(ev.target, ev.scale));
        return t;
      },
    },

    PLAY_AUDIO_WITH_LIPSYNC: {
      validate(ev, ctx) {
        const errs = requireActor(ev.target, ctx);
        if (typeof ev.text !== 'string') errs.push(`'text' (legenda) é obrigatório`);
        if (ev.audio !== undefined && typeof ev.audio !== 'string') errs.push(`'audio' deve ser uma URL`);
        if (ev.hold !== undefined && (!isNum(ev.hold) || ev.hold < 0)) errs.push(`'hold' deve ser >= 0`);
        if (ev.subtitle !== undefined && typeof ev.subtitle !== 'boolean') errs.push(`'subtitle' deve ser true ou false`);
        return errs;
      },
      interval(ev, ctx) {
        const speak = isNum(ev.duration) && ev.duration > 0 ? ev.duration : ctx.speechDuration(ev);
        const hold = ev.hold ?? 0.5;
        const key = `dlg:${ctx.index}`;
        return {
          duration: speak + hold,
          apply(f, local) {
            f.dialogues.push({
              key,
              actorId: ev.target,
              text: ev.text,
              audio: ev.audio,
              volume: ev.volume ?? 1,
              start: ev.time,
              speakDuration: speak,
              localTime: local,
              subtitle: ev.subtitle ?? true,
            });
          },
        };
      },
    },

    CAMERA_CUT: {
      validate: (ev, ctx) => validateShotSpec(ev, ctx),
      tracks: (ev) => [
        track<CameraValue>({
          channel: 'camera',
          get: (f) => f.camera,
          set: (f, v) => {
            f.camera = v;
          },
          interpolate: Interp.step<CameraValue>(),
          resolve: () => ({ kind: 'shot', spec: shotSpecOf(ev) }),
          duration: 0,
        }),
      ],
    },

    CAMERA_TRANSITION: {
      defaultDuration: 1.5,
      defaultEasing: 'easeInOutCubic',
      validate: (ev, ctx) => validateShotSpec(ev, ctx),
      tracks: (ev) => [
        track<CameraValue>({
          channel: 'camera',
          get: (f) => f.camera,
          set: (f, v) => {
            f.camera = v;
          },
          interpolate: Interp.camera,
          resolve: () => ({ kind: 'shot', spec: shotSpecOf(ev) }),
        }),
      ],
    },

    CAMERA_SHAKE: {
      validate(ev) {
        const errs: string[] = [];
        if (ev.intensity !== undefined && (!isNum(ev.intensity) || ev.intensity < 0)) errs.push(`'intensity' deve ser >= 0`);
        if (ev.decay !== undefined && (!isNum(ev.decay) || ev.decay <= 0)) errs.push(`'decay' deve ser > 0`);
        return errs;
      },
      interval(ev, ctx) {
        const decay = ev.decay ?? 3;
        // Até a amplitude cair abaixo de 1%: e^(-decay*t) = 0.01.
        const duration = isNum(ev.duration) && ev.duration > 0 ? ev.duration : Math.log(100) / decay;
        const seed = hashString(`shake:${ctx.index}`) % 1000;
        return {
          duration,
          apply(f, local) {
            f.shakes.push({ intensity: ev.intensity ?? 0.4, frequency: ev.frequency ?? 18, decay, localTime: local, seed });
          },
        };
      },
    },

    SET_LIGHT: {
      defaultDuration: 0,
      defaultEasing: 'easeInOutSine',
      validate(ev, ctx) {
        const errs: string[] = [];
        if (!ctx.lights.has(ev.target)) errs.push(`luz '${ev.target}' não existe em scene.lights`);
        if (ev.color !== undefined && !isHexColor(ev.color)) errs.push(`'color' deve ser hex (#rrggbb)`);
        if (ev.intensity !== undefined && (!isNum(ev.intensity) || ev.intensity < 0)) errs.push(`'intensity' deve ser >= 0`);
        if (ev.position !== undefined && !isVec3(ev.position)) errs.push(`'position' deve ser [x, y, z]`);
        if (ev.color === undefined && ev.intensity === undefined && ev.position === undefined) {
          errs.push(`informe 'color', 'intensity' e/ou 'position'`);
        }
        return errs;
      },
      tracks(ev) {
        const id = ev.target;
        const t: AnyTrack[] = [];
        if (ev.color !== undefined) {
          const rgb = hexToRgb(ev.color);
          t.push(
            track<RGB>({
              channel: `light:${id}:color`,
              get: (f) => f.lights[id].color,
              set: (f, v) => {
                f.lights[id].color = v;
              },
              interpolate: Interp.rgb,
              resolve: () => rgb,
            }),
          );
        }
        if (ev.intensity !== undefined) {
          const to = ev.intensity;
          t.push(
            track<number>({
              channel: `light:${id}:intensity`,
              get: (f) => f.lights[id].intensity,
              set: (f, v) => {
                f.lights[id].intensity = v;
              },
              interpolate: Interp.number,
              resolve: () => to,
            }),
          );
        }
        if (ev.position !== undefined) {
          const to = ev.position;
          t.push(
            track<Vec3>({
              channel: `light:${id}:position`,
              get: (f) => f.lights[id].position,
              set: (f, v) => {
                f.lights[id].position = v;
              },
              interpolate: Interp.vec3,
              resolve: () => to,
            }),
          );
        }
        return t;
      },
    },

    SET_LOOK_TARGET: {
      validate(ev, ctx) {
        const errs = requireActor(ev.target, ctx);
        const l = ev.lookAt;
        if (l === null || l === 'camera' || isVec3(l)) return errs;
        if (typeof l === 'string') {
          if (!ctx.objects.has(l)) errs.push(`'lookAt': objeto '${l}' não existe`);
        } else errs.push(`'lookAt' deve ser id de ator, 'camera', [x, y, z] ou null`);
        return errs;
      },
      tracks: (ev) => [
        track<LookTarget>({
          channel: `actor:${ev.target}:lookAt`,
          get: (f) => f.actors[ev.target].lookAt,
          set: (f, v) => {
            f.actors[ev.target].lookAt = v;
          },
          interpolate: Interp.step<LookTarget>(),
          resolve: () => ev.lookAt,
          duration: 0,
        }),
      ],
    },

    SET_EXPRESSION: {
      defaultDuration: 0.35,
      defaultEasing: 'easeInOutQuad',
      validate(ev, ctx) {
        const errs = requireActor(ev.target, ctx);
        if (!EXPRESSIONS.includes(ev.expression)) errs.push(`'expression' inválida (use ${EXPRESSIONS.join(', ')})`);
        if (ev.intensity !== undefined && (!isNum(ev.intensity) || ev.intensity < 0 || ev.intensity > 1.5)) {
          errs.push(`'intensity' deve estar entre 0 e 1.5`);
        }
        return errs;
      },
      tracks(ev) {
        const target = neutralWeights();
        if (ev.expression !== 'neutral') target[ev.expression] = ev.intensity ?? 1;
        return [
          track<ExpressionWeights>({
            channel: `actor:${ev.target}:expression`,
            get: (f) => f.actors[ev.target].expression,
            set: (f, v) => {
              f.actors[ev.target].expression = v;
            },
            interpolate: Interp.weights,
            resolve: () => target,
          }),
        ];
      },
    },

    PLAY_GESTURE: {
      validate(ev, ctx) {
        const errs = requireActor(ev.target, ctx);
        const custom = ctx.script.gestures ?? {};
        if (!(GESTURES as readonly string[]).includes(ev.gesture) && !(ev.gesture in custom)) {
          errs.push(`'gesture' inválido (use ${GESTURES.join(', ')} ou um nome de 'gestures')`);
        }
        return errs;
      },
      interval(ev, ctx) {
        const custom = ctx.script.gestures?.[ev.gesture];
        const duration = isNum(ev.duration) && ev.duration > 0 ? ev.duration : custom?.duration ?? GESTURE_DURATIONS[ev.gesture] ?? 1.2;
        return {
          duration,
          apply(f, _local, progress) {
            f.actors[ev.target].gesture = { name: ev.gesture, progress };
          },
        };
      },
    },

    SET_POSE: {
      defaultDuration: 0.6,
      defaultEasing: 'easeInOutQuad',
      validate(ev, ctx) {
        const errs = requireActor(ev.target, ctx);
        errs.push(...validatePoseDef(ev.pose));
        if (ev.seatHeight !== undefined && (!isNum(ev.seatHeight) || ev.seatHeight < 0)) errs.push(`'seatHeight' deve ser >= 0`);
        return errs;
      },
      tracks(ev, ctx) {
        const def = resolvePose(ev.pose, heightOf(ctx, ev.target), ev.seatHeight);
        return [
          track<PoseFrame>({
            channel: `actor:${ev.target}:pose`,
            get: (f) => f.actors[ev.target].pose,
            set: (f, v) => {
              f.actors[ev.target].pose = v;
            },
            interpolate: Interp.pose,
            resolve: (from) => poseFrameFrom(def, from, ev.merge ?? false),
          }),
        ];
      },
    },

    REACH: {
      defaultDuration: 0.5,
      defaultEasing: 'easeInOutQuad',
      validate(ev, ctx) {
        const errs = requireActor(ev.target, ctx);
        if (ev.hand !== undefined && !['left', 'right', 'both'].includes(ev.hand)) errs.push(`'hand' deve ser left, right ou both`);
        if (ev.to === undefined) errs.push(`'to' é obrigatório (use null para recolher)`);
        else if (ev.to !== null) errs.push(...isReachTarget(ev.to, ctx));
        if (ev.hold !== undefined && (!isNum(ev.hold) || ev.hold < 0)) errs.push(`'hold' deve ser >= 0`);
        if (ev.shake !== undefined && (!isNum(ev.shake) || ev.shake < 0 || ev.shake > 2)) errs.push(`'shake' deve estar entre 0 e 2`);
        return errs;
      },
      expand(ev) {
        const hand = ev.hand ?? 'right';
        if (hand === 'both') {
          return (['left', 'right'] as const).map((h) => ({ ...ev, hand: h }));
        }
        if (ev.hold !== undefined && ev.to !== null) {
          const duration = ev.duration ?? 0.5;
          return [{ time: ev.time + duration + ev.hold, type: 'REACH', target: ev.target, hand, to: null, duration, easing: ev.easing, label: ev.label }];
        }
        return [];
      },
      tracks(ev) {
        const hand = ev.hand ?? 'right';
        if (hand === 'both') return [];
        return [reachTrack(ev.target, hand, ev.to, ev.shake ?? 0)];
      },
    },

    ATTACH_OBJECT: {
      defaultDuration: 0.15,
      defaultEasing: 'easeOutQuad',
      validate(ev, ctx) {
        const errs = requireObject(ev.target, ctx);
        if (ctx.objects.get(ev.target)?.kind === 'actor') errs.push(`apenas props podem ser presos (target '${ev.target}' é ator)`);
        errs.push(...requireActor(ev.to, ctx, 'to'));
        if (ev.socket !== undefined && !(SOCKETS as readonly string[]).includes(ev.socket)) errs.push(`'socket' inválido (use ${SOCKETS.join(', ')})`);
        if (ev.offset !== undefined && !isVec3(ev.offset)) errs.push(`'offset' deve ser [x, y, z]`);
        if (ev.rotation !== undefined && !isVec3(ev.rotation)) errs.push(`'rotation' deve ser [x, y, z] em graus`);
        return errs;
      },
      tracks: (ev) => [
        attachTrack(ev.target, {
          actor: ev.to,
          socket: ev.socket ?? 'handR',
          offset: ev.offset ?? [0, -0.07, 0.02],
          rotation: ev.rotation ?? [0, 0, 0],
        }),
      ],
    },

    DETACH_OBJECT: {
      defaultDuration: 0.4,
      defaultEasing: 'easeInQuad',
      validate(ev, ctx) {
        const errs = requireObject(ev.target, ctx);
        if (ev.position !== undefined && !isVec3(ev.position)) errs.push(`'position' deve ser [x, y, z]`);
        if (ev.rotation !== undefined && !isVec3(ev.rotation)) errs.push(`'rotation' deve ser [x, y, z] em graus`);
        return errs;
      },
      tracks(ev, ctx) {
        // Sem posição explícita: pousa no chão, à frente de quem segurava.
        let position = ev.position;
        if (!position) {
          const holder = ctx.query.holderOf(ev.target, ev.time);
          if (holder) {
            const p = ctx.query.positionOf(holder, ev.time);
            const yaw = (ctx.query.yawOf(holder, ev.time) * Math.PI) / 180;
            position = [p[0] + Math.sin(yaw) * 0.5, 0, p[2] + Math.cos(yaw) * 0.5];
          }
        }
        const t: AnyTrack[] = [attachTrack(ev.target, null)];
        if (position) t.push(objectPositionTrack(ev.target, position, 0));
        if (ev.rotation) t.push(objectRotationTrack(ev.target, ev.rotation, 0));
        return t;
      },
    },

    INTERACT: {
      validate: (ev, ctx) => validateInteraction(ev, ctx.query),
      expand: (ev, ctx) => expandInteraction(ev, ctx.query),
    },

    PLAY_ANIMATION: {
      validate(ev, ctx) {
        const errs = requireActor(ev.target, ctx);
        if (typeof ev.clip !== 'string' || !ev.clip) errs.push(`'clip' é obrigatório`);
        return errs;
      },
      tracks: (ev) => [
        track<ClipState | null>({
          channel: `actor:${ev.target}:clip`,
          get: (f) => f.actors[ev.target].clip,
          set: (f, v) => {
            f.actors[ev.target].clip = v;
          },
          interpolate: Interp.step<ClipState | null>(),
          resolve: (from) => ({
            name: ev.clip,
            loop: ev.loop ?? true,
            startAt: ev.time,
            fade: ev.fade ?? 0.3,
            prev: from ? { name: from.name, loop: from.loop, startAt: from.startAt } : null,
          }),
          duration: 0,
        }),
      ],
    },

    SET_RETRO_FX: {
      defaultDuration: 0,
      defaultEasing: 'easeInOutQuad',
      validate(ev) {
        const errs: string[] = [];
        if (ev.enabled === undefined && ev.settings === undefined) errs.push(`informe 'enabled' e/ou 'settings'`);
        if (ev.settings !== undefined) {
          if (!isObj(ev.settings)) errs.push(`'settings' deve ser um objeto`);
          else
            for (const [k, v] of Object.entries(ev.settings)) {
              if (!(k in DEFAULT_RETRO_SETTINGS)) errs.push(`'settings.${k}' desconhecido`);
              else if (!isNum(v)) errs.push(`'settings.${k}' deve ser número`);
            }
        }
        return errs;
      },
      tracks(ev) {
        const t: AnyTrack[] = [];
        if (ev.enabled !== undefined) {
          const enabled = ev.enabled;
          t.push(
            track<boolean>({
              channel: 'fx:retro',
              get: (f) => f.fx.retro,
              set: (f, v) => {
                f.fx.retro = v;
              },
              interpolate: Interp.step<boolean>(),
              resolve: () => enabled,
              duration: 0,
            }),
          );
        }
        if (ev.settings) {
          const patch = ev.settings;
          t.push(
            track<RetroSettings>({
              channel: 'fx:settings',
              get: (f) => f.fx.settings,
              set: (f, v) => {
                f.fx.settings = v;
              },
              interpolate: Interp.settings,
              resolve: (from) => ({ ...from, ...patch }),
            }),
          );
        }
        return t;
      },
    },

    SET_TIME_OF_DAY: {
      defaultDuration: 0,
      defaultEasing: 'easeInOutSine',
      validate(ev, ctx) {
        const errs: string[] = [];
        if (!isNum(ev.hour) || ev.hour < 0 || ev.hour > 24) errs.push(`'hour' deve estar entre 0 e 24`);
        if (typeof ctx.script.scene?.timeOfDay !== 'number') errs.push(`defina 'scene.timeOfDay' para usar o ciclo dia/noite`);
        return errs;
      },
      tracks: (ev) => [
        track<number | null>({
          channel: 'env:hour',
          get: (f) => f.hour,
          set: (f, v) => {
            f.hour = v;
          },
          interpolate: (a, b, t) => (a === null || b === null ? b : lerp(a, b, t)),
          // Sempre avança: escolhe o próximo `hour` (mod 24) depois do atual.
          resolve: (from) => {
            if (from === null) return ev.hour;
            let to = ev.hour + Math.floor(from / 24) * 24;
            while (to < from) to += 24;
            return to;
          },
        }),
      ],
    },

    FADE_SCREEN: {
      defaultDuration: 1,
      defaultEasing: 'easeInOutSine',
      validate(ev) {
        const errs: string[] = [];
        if (!isNum(ev.to) || ev.to < 0 || ev.to > 1) errs.push(`'to' deve estar entre 0 e 1`);
        if (ev.color !== undefined && !isHexColor(ev.color)) errs.push(`'color' deve ser hex (#rrggbb)`);
        return errs;
      },
      tracks(ev) {
        const t: AnyTrack[] = [
          track<number>({
            channel: 'fx:fade',
            get: (f) => f.fx.fade,
            set: (f, v) => {
              f.fx.fade = v;
            },
            interpolate: Interp.number,
            resolve: () => ev.to,
          }),
        ];
        if (ev.color !== undefined) {
          const rgb = hexToRgb(ev.color, [0, 0, 0]);
          t.push(
            track<RGB>({
              channel: 'fx:fadeColor',
              get: (f) => f.fx.fadeColor,
              set: (f, v) => {
                f.fx.fadeColor = v;
              },
              interpolate: Interp.step<RGB>(),
              resolve: () => rgb,
              duration: 0,
            }),
          );
        }
        return t;
      },
    },

    FLASH_SCREEN: {
      validate(ev) {
        const errs: string[] = [];
        if (ev.color !== undefined && !isHexColor(ev.color)) errs.push(`'color' deve ser hex (#rrggbb)`);
        return errs;
      },
      interval(ev) {
        const duration = isNum(ev.duration) && ev.duration > 0 ? ev.duration : 0.35;
        const color = hexToRgb(ev.color, [1, 1, 1]);
        const intensity = ev.intensity ?? 1;
        return {
          duration,
          apply(f, _local, progress) {
            const v = intensity * Math.pow(1 - progress, 2);
            if (v > f.fx.flash) {
              f.fx.flash = v;
              f.fx.flashColor = color;
            }
          },
        };
      },
    },

    PLAY_SOUND: {
      validate(ev) {
        const errs: string[] = [];
        if (typeof ev.src !== 'string' || !ev.src) errs.push(`'src' é obrigatório`);
        else if (ev.src.startsWith('procedural:') && !(PROCEDURAL_SOUNDS as readonly string[]).includes(ev.src)) {
          errs.push(`'src' procedural inválido (use ${PROCEDURAL_SOUNDS.join(', ')})`);
        }
        return errs;
      },
      interval(ev, ctx) {
        const known = ctx.soundDuration(ev.src);
        const loop = ev.loop ?? false;
        const duration = isNum(ev.duration) && ev.duration > 0 ? ev.duration : loop ? Infinity : known ?? 3;
        const key = `snd:${ctx.index}`;
        return {
          duration,
          apply(f, local) {
            f.sounds.push({ key, src: ev.src, volume: ev.volume ?? 1, loop, start: ev.time, duration, localTime: local });
          },
        };
      },
    },
  };
}

/* ========================================================================== */
/*  ActionRegistry                                                            */
/* ========================================================================== */

/**
 * Registro de ações: valida o StoryScript, compila os eventos em segmentos
 * por canal e avalia o estado completo da cena para qualquer instante.
 *
 * `evaluate(t)` é uma função pura de `t` — base da reversibilidade (seek).
 */
export class ActionRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  constructor() {
    const defaults = createDefaultHandlers();
    for (const type of Object.keys(defaults) as EventType[]) {
      this.handlers.set(type, defaults[type] as unknown as ActionHandler);
    }
  }

  /** Registra ou substitui um handler (extensão da engine). */
  register<K extends EventType>(type: K, handler: ActionHandler<EventOf<K>>): void {
    this.handlers.set(type, handler as unknown as ActionHandler);
  }

  get types(): string[] {
    return [...this.handlers.keys()];
  }

  /** Validação estrutural de um JSON arbitrário. */
  validateStructure(raw: unknown): string[] {
    const errs: string[] = [];
    if (!isObj(raw)) return ['o StoryScript deve ser um objeto JSON'];
    if (!isObj(raw.meta) || typeof raw.meta.title !== 'string') errs.push(`'meta.title' é obrigatório`);
    if (!Array.isArray(raw.timeline)) errs.push(`'timeline' deve ser um array de eventos`);
    if (raw.scene !== undefined) {
      if (!isObj(raw.scene)) errs.push(`'scene' deve ser um objeto`);
      else {
        const lights = raw.scene.lights;
        if (lights !== undefined) {
          if (!Array.isArray(lights)) errs.push(`'scene.lights' deve ser um array`);
          else {
            const ids = new Set<string>();
            lights.forEach((l, i) => {
              if (!isObj(l) || typeof l.id !== 'string') errs.push(`scene.lights[${i}]: 'id' é obrigatório`);
              else {
                if (ids.has(l.id)) errs.push(`scene.lights: id duplicado '${l.id}'`);
                ids.add(l.id);
                if (!['ambient', 'hemisphere', 'directional', 'point', 'spot'].includes(String(l.type))) {
                  errs.push(`scene.lights[${i}]: 'type' inválido`);
                }
              }
            });
          }
        }
        if (raw.scene.props !== undefined && !Array.isArray(raw.scene.props)) errs.push(`'scene.props' deve ser um array`);
      }
    }
    if (raw.cameras !== undefined) {
      if (!Array.isArray(raw.cameras)) errs.push(`'cameras' deve ser um array`);
      else {
        const ids = new Set<string>();
        raw.cameras.forEach((c, i) => {
          if (!isObj(c) || typeof c.id !== 'string') errs.push(`cameras[${i}]: 'id' é obrigatório`);
          else {
            if (ids.has(c.id)) errs.push(`cameras: id duplicado '${c.id}'`);
            ids.add(c.id);
            if (c.position === undefined || c.lookAt === undefined) errs.push(`cameras[${i}]: 'position' e 'lookAt' são obrigatórios`);
          }
        });
      }
    }
    return errs;
  }

  /** Valida e compila. Lança StoryScriptError com todos os erros encontrados. */
  compile(raw: unknown, options: CompileOptions = {}): CompiledStory {
    const structural = this.validateStructure(raw);
    if (structural.length) throw new StoryScriptError(structural);
    const script = raw as StoryScript;

    const errors: string[] = [];
    const warnings: string[] = [];

    // Fila ordenada por tempo (estável). Macros (expand) inserem eventos derivados nela.
    interface QueueItem {
      ev: StoryEvent;
      index: number;
      seq: number;
      parent?: string;
    }
    let seq = 0;
    const queue: QueueItem[] = (script.timeline ?? [])
      .map((ev, index) => ({ ev, index, seq: 0 }))
      .sort((a, b) => (a.ev?.time ?? 0) - (b.ev?.time ?? 0) || a.index - b.index);
    queue.forEach((q) => (q.seq = seq++));
    const enqueue = (item: QueueItem) => {
      const time = item.ev.time;
      // Inserção binária após todos os itens com tempo <= time.
      let lo = 0;
      let hi = queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((queue[mid].ev?.time ?? 0) <= time) lo = mid + 1;
        else hi = mid;
      }
      queue.splice(lo, 0, item);
    };

    // 1ª passada: coleta definições de objetos (SPAWN_OBJECT).
    const objects = new Map<string, ObjectDef>();
    const firstSpawn = new Map<string, EventOf<'SPAWN_OBJECT'>>();
    for (const { ev, index } of queue) {
      if (!isObj(ev)) continue;
      if (ev.type !== 'SPAWN_OBJECT' || typeof ev.target !== 'string') continue;
      if (!objects.has(ev.target)) {
        // Sem 'object' (nem elenco) o erro é reportado pela validação do handler.
        const def = isObj(ev.object) ? ev.object : script.cast?.[ev.target];
        if (isObj(def)) {
          objects.set(ev.target, def);
          firstSpawn.set(ev.target, ev);
        }
      } else if (ev.object) {
        warnings.push(`evento #${index}: '${ev.target}' já foi definido; 'object' ignorado`);
      }
    }

    const lights = new Map<string, LightDef>((script.scene?.lights ?? []).map((l) => [l.id, l]));
    const shots = new Map<string, CameraShotDef>((script.cameras ?? []).map((c) => [c.id, c]));

    for (const [name, g] of Object.entries(script.gestures ?? {})) errors.push(...validateGestureDef(name, g));

    const base = this.buildBaseFrame(script, objects, firstSpawn, shots);
    const channels = new Map<string, Segment[]>();

    /** Valor de um canal no instante `time`, considerando o que já foi compilado. */
    const sample = <V>(channel: string, time: number, fallback: V): V => {
      const segs = channels.get(channel);
      return segs?.length && findLastStarted(segs, time) >= 0 ? (sampleSegments(segs, time) as V) : fallback;
    };
    const query: InteractionContext = {
      isActor: (id) => objects.get(id)?.kind === 'actor',
      isObject: (id) => objects.has(id),
      positionOf: (id, time) => sample<Vec3>(`object:${id}:position`, time, base.objects[id]?.position ?? [0, 0, 0]),
      yawOf: (id, time) => sample<Vec3>(`object:${id}:rotation`, time, base.objects[id]?.rotation ?? [0, 0, 0])[1],
      heightOf: (id) => {
        const def = objects.get(id);
        return def?.kind === 'actor' ? def.height ?? 1.75 : 1;
      },
      holderOf: (id, time) => {
        const a = sample<AttachValue | null>(`object:${id}:attach`, time, null);
        return a?.to?.actor ?? null;
      },
    };

    const ctx: CompileContext = {
      script,
      objects,
      lights,
      shots,
      index: 0,
      query,
      speechDuration: (ev) => {
        const obj = objects.get(ev.target);
        const def = obj?.kind === 'actor' ? obj : undefined;
        const known = options.speechDuration?.(ev, def);
        if (isNum(known) && known > 0) return known;
        return estimateSpeechDuration(ev.text, def?.voice?.rate ?? 1);
      },
      soundDuration: (src) => options.soundDuration?.(src),
    };

    const intervals: Interval[] = [];
    const markers: CompiledStory['markers'] = [];
    let end = 0;
    let expansions = 0;

    while (queue.length) {
      const { ev, index, parent } = queue.shift()!;
      const where = `evento #${index}${parent ? ` (${parent})` : ''}${isObj(ev) && ev.label ? ` [${String(ev.label)}]` : ''}`;
      if (!isObj(ev)) {
        errors.push(`${where}: deve ser um objeto`);
        continue;
      }
      const handler = this.handlers.get(String(ev.type));
      if (!handler) {
        errors.push(`${where}: tipo desconhecido '${String(ev.type)}'`);
        continue;
      }
      if (!isNum(ev.time) || ev.time < 0) {
        errors.push(`${where} (${ev.type}): 'time' deve ser um número >= 0`);
        continue;
      }
      if (ev.duration !== undefined && (!isNum(ev.duration) || ev.duration < 0)) {
        errors.push(`${where} (${ev.type}): 'duration' deve ser >= 0`);
        continue;
      }
      if (ev.easing !== undefined && !EASINGS.includes(ev.easing)) {
        errors.push(`${where} (${ev.type}): easing '${String(ev.easing)}' inválido`);
        continue;
      }

      ctx.index = index;
      try {
        const errs = handler.validate?.(ev, ctx) ?? [];
        if (errs.length) {
          errors.push(...errs.map((e) => `${where} (${ev.type}): ${e}`));
          continue;
        }

        for (const derived of handler.expand?.(ev, ctx) ?? []) {
          if (++expansions > 20000) throw new Error('expansão de macros excedeu o limite (recursão?)');
          if (!isNum(derived.time) || derived.time < ev.time) throw new Error(`evento derivado com tempo inválido (${derived.time})`);
          enqueue({ ev: derived, index, seq: seq++, parent: parent ?? ev.type });
        }

        const evDuration = ev.duration ?? handler.defaultDuration ?? 0;
        const ease = Easings[ev.easing ?? handler.defaultEasing ?? 'linear'];

        for (const write of handler.tracks?.(ev, ctx) ?? []) {
          const duration = write.duration ?? evDuration;
          const segs = channels.get(write.channel) ?? [];
          const from = segs.length ? sampleSegments(segs, ev.time) : write.get(base);
          segs.push({ start: ev.time, duration, ease, from, to: write.resolve(from), write });
          channels.set(write.channel, segs);
          end = Math.max(end, ev.time + duration);
        }

        const interval = handler.interval?.(ev, ctx);
        if (interval) {
          intervals.push({ start: ev.time, duration: interval.duration, write: interval });
          if (Number.isFinite(interval.duration)) end = Math.max(end, ev.time + interval.duration);
          else end = Math.max(end, ev.time);
        }
      } catch (err) {
        errors.push(`${where} (${ev.type}): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (ev.type === 'PLAY_AUDIO_WITH_LIPSYNC') {
        const name = objects.get(ev.target);
        markers.push({ time: ev.time, type: ev.type, label: `${name?.kind === 'actor' ? name.name : ev.target}: ${ev.text}` });
      } else if ((ev.type === 'CAMERA_CUT' || ev.type === 'CAMERA_TRANSITION') && !parent) {
        markers.push({ time: ev.time, type: ev.type, label: ev.shot ?? ev.preset ?? 'camera' });
      } else if (ev.type === 'INTERACT') {
        markers.push({ time: ev.time, type: ev.type, label: `${ev.target}: ${ev.interaction}${ev.with ? ` → ${ev.with}` : ''}` });
      }
    }

    if (errors.length) throw new StoryScriptError(errors);

    const duration = Math.max(end, script.meta.duration ?? 0, 0.1);
    return { script, duration, objects, lights, shots, warnings, markers, base, channels, intervals };
  }

  /** Estado completo da cena no instante `time`. Função pura (determinística). */
  evaluate(story: CompiledStory, time: number): FrameState {
    const frame = cloneFrame(story.base, time);

    for (const segs of story.channels.values()) {
      const idx = findLastStarted(segs, time);
      if (idx < 0) continue;
      const seg = segs[idx];
      seg.write.set(frame, valueOf(seg, time));
    }

    for (const it of story.intervals) {
      const local = time - it.start;
      if (local < 0 || local >= it.duration) continue;
      const progress = Number.isFinite(it.duration) && it.duration > 0 ? clamp01(local / it.duration) : 0;
      it.write.apply(frame, local, progress);
    }

    return frame;
  }

  private buildBaseFrame(
    script: StoryScript,
    objects: ReadonlyMap<string, ObjectDef>,
    firstSpawn: ReadonlyMap<string, EventOf<'SPAWN_OBJECT'>>,
    shots: ReadonlyMap<string, CameraShotDef>,
  ): FrameState {
    const frame: FrameState = {
      time: 0,
      objects: {},
      actors: {},
      lights: {},
      camera: { kind: 'shot', spec: shots.size ? { shot: shots.keys().next().value as string } : { preset: 'wide' } },
      shakes: [],
      fx: {
        retro: script.fx?.retro ?? true,
        settings: { ...DEFAULT_RETRO_SETTINGS, ...(script.fx?.settings ?? {}) },
        fade: 0,
        fadeColor: [0, 0, 0],
        flash: 0,
        flashColor: [1, 1, 1],
      },
      hour: typeof script.scene?.timeOfDay === 'number' ? script.scene.timeOfDay : null,
      dialogues: [],
      sounds: [],
    };

    for (const [id, def] of objects) {
      const spawn = firstSpawn.get(id);
      // Antes do spawn o objeto existe oculto, já na posição de spawn (reversível).
      frame.objects[id] = {
        position: spawn?.position ?? [0, 0, 0],
        rotation: spawn?.rotation ?? [0, 0, 0],
        scale: spawn?.scale ?? 1,
        visible: false,
        attach: { from: null, to: null, alpha: 1 },
      };
      if (def.kind === 'actor') {
        const freeHand: ReachFrame = { target: null, prev: null, blend: 1, weight: 0, shake: 0 };
        frame.actors[id] = {
          expression: neutralWeights(),
          lookAt: null,
          gesture: null,
          clip: null,
          pose: restPoseFrame(),
          reach: { left: freeHand, right: { ...freeHand } },
        };
      }
    }

    for (const l of script.scene?.lights ?? []) {
      frame.lights[l.id] = {
        color: hexToRgb(l.color, [1, 1, 1]),
        intensity: l.intensity ?? 1,
        position: l.position ?? [0, 5, 0],
      };
    }
    return frame;
  }
}

/* ---- Amostragem de segmentos ---- */

function findLastStarted(segs: Segment[], time: number): number {
  // Busca binária: último índice com start <= time (segmentos já ordenados por start).
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function valueOf(seg: Segment, time: number): unknown {
  const alpha = seg.duration > 0 ? clamp01((time - seg.start) / seg.duration) : 1;
  return seg.write.interpolate(seg.from, seg.to, seg.ease(alpha));
}

function sampleSegments(segs: Segment[], time: number): unknown {
  const idx = findLastStarted(segs, time);
  const seg = segs[Math.max(0, idx)];
  if (idx < 0) return seg.from;
  return valueOf(seg, time);
}

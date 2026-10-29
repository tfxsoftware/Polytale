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
  EXPRESSIONS,
  GESTURES,
  PROCEDURAL_SOUNDS,
  SOUND_BUSES,
  type ActorFrame,
  type AttachValue,
  type Hand,
  type PoseFrame,
  type ReachFrame,
  type ReachTarget,
  type SocketRef,
  type ActorObjectDef,
  type CameraShotSpec,
  type CameraValue,
  type ClipState,
  type EventOf,
  type EventType,
  type ExpressionWeights,
  type FrameState,
  type LookTarget,
  type ObjectFrame,
  type RGB,
  type RetroSettings,
  type Vec3,
} from './types';
import { hashString, hexToRgb, isHexColor, lerp } from '../utils/math';
import { poseFrameFrom, resolvePose, validatePoseDef } from './poses';
import { expandInteraction, validateInteraction } from './interactions';
import { Interp } from './easing';
import { track, type ActionHandler, type AnyTrack, type CompileContext } from './compileTypes';

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function neutralWeights(): ExpressionWeights {
  const w = {} as ExpressionWeights;
  for (const k of EXPRESSIONS) w[k] = 0;
  return w;
}

export function cloneFrame(f: FrameState, time: number): FrameState {
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
    titleCard: null,
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
  if (ev.drift !== undefined) {
    if (!isObj(ev.drift)) errs.push(`'drift' deve ser um objeto`);
    else {
      if (ev.drift.push !== undefined && !isNum(ev.drift.push)) errs.push(`'drift.push' deve ser um número`);
      if (ev.drift.pan !== undefined && !isNum(ev.drift.pan)) errs.push(`'drift.pan' deve ser um número`);
      if (ev.drift.duration !== undefined && (!isNum(ev.drift.duration) || ev.drift.duration < 0)) errs.push(`'drift.duration' deve ser >= 0`);
    }
  }
  return errs;
}

function shotSpecOf(ev: CameraShotSpec): CameraShotSpec {
  const { shot, preset, subject, over, side, fov, offset, handheld, drift } = ev;
  const spec: CameraShotSpec = {};
  if (shot !== undefined) spec.shot = shot;
  if (preset !== undefined) spec.preset = preset;
  if (subject !== undefined) spec.subject = subject;
  if (over !== undefined) spec.over = over;
  if (side !== undefined) spec.side = side;
  if (fov !== undefined) spec.fov = fov;
  if (offset !== undefined) spec.offset = offset;
  if (handheld !== undefined) spec.handheld = handheld;
  if (drift !== undefined) spec.drift = drift;
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

export function heightOf(ctx: CompileContext, id: string): number {
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

export function createDefaultHandlers(): HandlerMap {
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
          resolve: () => ({ kind: 'shot', spec: shotSpecOf(ev), start: ev.time }),
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
          resolve: () => ({ kind: 'shot', spec: shotSpecOf(ev), start: ev.time }),
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
        if (ev.bus !== undefined && !SOUND_BUSES.includes(ev.bus)) errs.push(`'bus' deve ser ${SOUND_BUSES.join(' ou ')}`);
        return errs;
      },
      interval(ev, ctx) {
        const known = ctx.soundDuration(ev.src);
        const loop = ev.loop ?? false;
        const duration = isNum(ev.duration) && ev.duration > 0 ? ev.duration : loop ? Infinity : known ?? 3;
        const key = `snd:${ctx.index}`;
        const bus = ev.bus ?? 'sfx';
        return {
          duration,
          apply(f, local) {
            f.sounds.push({ key, src: ev.src, volume: ev.volume ?? 1, loop, start: ev.time, duration, localTime: local, bus });
          },
        };
      },
    },

    SHOW_TITLE: {
      validate(ev) {
        const errs: string[] = [];
        if (typeof ev.title !== 'string' || !ev.title) errs.push(`'title' é obrigatório`);
        if (ev.subtitle !== undefined && typeof ev.subtitle !== 'string') errs.push(`'subtitle' deve ser uma string`);
        if (ev.duration !== undefined && (!isNum(ev.duration) || ev.duration <= 0)) errs.push(`'duration' deve ser > 0`);
        if (ev.overlay !== undefined && typeof ev.overlay !== 'boolean') errs.push(`'overlay' deve ser true ou false`);
        return errs;
      },
      interval(ev) {
        const duration = isNum(ev.duration) && ev.duration > 0 ? ev.duration : 3;
        return {
          duration,
          apply(f, _local, progress) {
            f.titleCard = { title: ev.title, subtitle: ev.subtitle ?? '', progress, overlay: ev.overlay ?? false };
          },
        };
      },
    },
  };
}

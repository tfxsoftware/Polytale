import {
  DEFAULT_RETRO_SETTINGS,
  EASINGS,
  estimateSpeechDuration,
  type AttachValue,
  type ReachFrame,
  type CameraShotDef,
  type EventOf,
  type EventType,
  type FrameState,
  type LightDef,
  type ObjectDef,
  type StoryEvent,
  type StoryScript,
  type Vec3,
} from './types';
import { clamp01, hexToRgb } from '../utils/math';
import { restPoseFrame, validateGestureDef } from './poses';
import type { InteractionContext } from './interactions';
import { Easings } from './easing';
import {
  StoryScriptError,
  type ActionHandler,
  type CompileContext,
  type CompileOptions,
  type CompiledStory,
  type Interval,
  type Segment,
} from './compileTypes';
import { cloneFrame, createDefaultHandlers, isNum, isObj, neutralWeights } from './handlers';

// Reexportações: quem importa daqui continua funcionando.
export { Easings, Interp, type EasingFn, type Interpolator } from './easing';
export {
  StoryScriptError,
  type ActionHandler,
  type CompileContext,
  type CompileOptions,
  type CompiledStory,
  type IntervalWrite,
  type TrackWrite,
} from './compileTypes';
export { neutralWeights } from './handlers';

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

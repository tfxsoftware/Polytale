import { INTERACTIONS, type InteractEvent, type ReachTarget, type StoryEvent, type Vec3 } from './types';
import { RAD2DEG } from '../utils/math';

/** Consultas ao estado já compilado (posições no tempo), fornecidas pelo ActionRegistry. */
export interface InteractionContext {
  isActor(id: string): boolean;
  isObject(id: string): boolean;
  positionOf(id: string, time: number): Vec3;
  yawOf(id: string, time: number): number;
  heightOf(id: string): number;
  /** Ator que segura o objeto no instante (null se solto). */
  holderOf(objectId: string, time: number): string | null;
}

/** Velocidade de caminhada usada nas aproximações automáticas (m/s). */
const WALK_SPEED = 1.2;

const HOLD_DEFAULT: Record<string, number> = {
  handshake: 1.2,
  highFive: 0.25,
  hug: 2.0,
  handOnShoulder: 2.0,
  pointAt: 1.4,
};

function yawTo(from: Vec3, to: Vec3): number {
  return Math.atan2(to[0] - from[0], to[2] - from[2]) * RAD2DEG;
}

function distXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

export function validateInteraction(ev: InteractEvent, ctx: InteractionContext): string[] {
  const errs: string[] = [];
  if (!ctx.isActor(ev.target)) errs.push(`'target' deve ser um ator criado por SPAWN_OBJECT`);
  if (!INTERACTIONS.includes(ev.interaction)) {
    errs.push(`'interaction' inválida (use ${INTERACTIONS.join(', ')})`);
    return errs;
  }
  const needsActor = ['handshake', 'highFive', 'hug', 'give', 'handOnShoulder', 'push'];
  if (needsActor.includes(ev.interaction)) {
    if (!ev.with || !ctx.isActor(ev.with)) errs.push(`'${ev.interaction}' exige 'with' = id de outro ator`);
    else if (ev.with === ev.target) errs.push(`'with' deve ser outro ator`);
  }
  if (ev.interaction === 'give' || ev.interaction === 'putDown') {
    if (!ev.object || !ctx.isObject(ev.object) || ctx.isActor(ev.object)) errs.push(`'${ev.interaction}' exige 'object' = id de um prop`);
  }
  if (ev.interaction === 'pickUp' && (!ev.with || !ctx.isObject(ev.with) || ctx.isActor(ev.with))) {
    errs.push(`'pickUp' exige 'with' = id de um prop`);
  }
  if (ev.interaction === 'pointAt' && !ev.with && !ev.position) errs.push(`'pointAt' exige 'with' ou 'position'`);
  if (ev.interaction === 'sit' && !ev.with && !ev.position) errs.push(`'sit' exige 'with' (assento) ou 'position'`);
  if (ev.with && !ctx.isObject(ev.with)) errs.push(`'with': objeto '${ev.with}' nunca é criado`);
  return errs;
}

/**
 * Expande uma interação de alto nível em eventos primitivos
 * (TRANSFORM_OBJECT, SET_LOOK_TARGET, REACH, SET_POSE, ATTACH/DETACH...).
 * As posições dos atores no instante do evento são lidas do estado compilado.
 */
export function expandInteraction(ev: InteractEvent, ctx: InteractionContext): StoryEvent[] {
  const out: StoryEvent[] = [];
  const label = `INTERACT:${ev.interaction}`;
  const A = ev.target;
  const B = ev.with;
  const t = ev.time;
  const hold = ev.duration ?? HOLD_DEFAULT[ev.interaction] ?? 1;
  const push = (e: StoryEvent) => out.push({ ...e, label } as StoryEvent);

  /** Caminha A até ficar a `stop` m de `dest`; retorna instante de chegada e posição final. */
  const approach = (dest: Vec3, stop: number, at: number): { time: number; pos: Vec3 } => {
    const pa = ctx.positionOf(A, at);
    const d = distXZ(pa, dest);
    if (ev.approach === false || d <= stop + 0.12) return { time: at, pos: pa };
    const k = (d - stop) / d;
    const pos: Vec3 = [pa[0] + (dest[0] - pa[0]) * k, pa[1], pa[2] + (dest[2] - pa[2]) * k];
    const walk = (d - stop) / WALK_SPEED;
    push({ time: at, type: 'TRANSFORM_OBJECT', target: A, rotation: [0, yawTo(pa, dest), 0], duration: 0.3, easing: 'easeOutQuad' });
    push({ time: at + 0.15, type: 'TRANSFORM_OBJECT', target: A, position: pos, duration: walk, easing: 'easeInOutSine' });
    return { time: at + 0.15 + walk, pos };
  };

  /** Vira A (e opcionalmente B) um para o outro. */
  const face = (pa: Vec3, at: number, other?: string) => {
    if (!other) return;
    const pb = ctx.positionOf(other, at);
    push({ time: at, type: 'TRANSFORM_OBJECT', target: A, rotation: [0, yawTo(pa, pb), 0], duration: 0.35, easing: 'easeOutQuad' });
    if (ctx.isActor(other)) {
      push({ time: at, type: 'TRANSFORM_OBJECT', target: other, rotation: [0, yawTo(pb, pa), 0], duration: 0.45, easing: 'easeOutQuad' });
    }
  };

  const look = (who: string, target: string | Vec3 | null, at: number) =>
    push({ time: at, type: 'SET_LOOK_TARGET', target: who, lookAt: target });

  const reach = (who: string, hand: 'left' | 'right' | 'both', to: ReachTarget | null, at: number, duration: number, extra: { shake?: number; easing?: StoryEvent['easing'] } = {}) =>
    push({ time: at, type: 'REACH', target: who, hand, to, duration, easing: extra.easing ?? 'easeInOutQuad', shake: extra.shake });

  const avgHeight = B && ctx.isActor(B) ? (ctx.heightOf(A) + ctx.heightOf(B)) / 2 : ctx.heightOf(A);

  switch (ev.interaction) {
    case 'handshake':
    case 'highFive': {
      const five = ev.interaction === 'highFive';
      const a = approach(ctx.positionOf(B!, t), five ? 0.85 : 0.9, t);
      face(a.pos, a.time, B);
      look(A, B!, a.time);
      look(B!, A, a.time);
      const mid: ReachTarget = { midpoint: [A, B!], height: avgHeight * (five ? 0.98 : 0.56) };
      const tIn = a.time + 0.25;
      const dIn = five ? 0.35 : 0.5;
      reach(A, 'right', mid, tIn, dIn, { shake: five ? 0 : 0.6, easing: five ? 'easeOutBack' : 'easeInOutQuad' });
      reach(B!, 'right', mid, tIn + 0.05, dIn, { shake: five ? 0 : 0.6, easing: five ? 'easeOutBack' : 'easeInOutQuad' });
      if (five) push({ time: tIn + dIn, type: 'CAMERA_SHAKE', intensity: 0.12, decay: 6 });
      const tOut = tIn + dIn + hold;
      reach(A, 'right', null, tOut, 0.5);
      reach(B!, 'right', null, tOut + 0.05, 0.5);
      push({ time: tIn, type: 'SET_EXPRESSION', target: A, expression: 'happy', intensity: 0.7, duration: 0.4 });
      push({ time: tIn, type: 'SET_EXPRESSION', target: B!, expression: 'happy', intensity: 0.7, duration: 0.4 });
      break;
    }

    case 'hug': {
      const a = approach(ctx.positionOf(B!, t), 0.42, t);
      face(a.pos, a.time, B);
      look(A, null, a.time);
      look(B!, null, a.time);
      const tIn = a.time + 0.3;
      // Frente a frente, a mão esquerda de A envolve o lado -X (local) de B, e vice-versa.
      // Alvo: flancos, um pouco atrás do centro do tronco (alcançável e por fora do corpo).
      const side = (other: string, x: number, y: number): ReachTarget => ({ target: other, part: 'back', offset: [x, y, 0.1], local: true });
      reach(A, 'left', side(B!, -0.25, 0), tIn, 0.7);
      reach(A, 'right', side(B!, 0.25, 0), tIn, 0.7);
      reach(B!, 'left', side(A, -0.25, -0.06), tIn + 0.15, 0.7);
      reach(B!, 'right', side(A, 0.25, -0.06), tIn + 0.15, 0.7);
      push({ time: tIn, type: 'SET_EXPRESSION', target: A, expression: 'happy', intensity: 0.8, duration: 0.5 });
      push({ time: tIn, type: 'SET_EXPRESSION', target: B!, expression: 'happy', intensity: 0.8, duration: 0.5 });
      const tOut = tIn + 0.85 + hold;
      reach(A, 'both', null, tOut, 0.6);
      reach(B!, 'both', null, tOut, 0.6);
      look(A, B!, tOut);
      look(B!, A, tOut);
      break;
    }

    case 'give': {
      const a = approach(ctx.positionOf(B!, t), 0.9, t);
      face(a.pos, a.time, B);
      look(A, B!, a.time);
      look(B!, ev.object!, a.time + 0.3);
      const mid: ReachTarget = { midpoint: [A, B!], height: avgHeight * 0.62 };
      const t0 = a.time + 0.2;
      reach(A, 'right', mid, t0, 0.6);
      reach(B!, 'right', { midpoint: [A, B!], height: avgHeight * 0.6, offset: [0, -0.04, 0] }, t0 + 0.3, 0.6);
      push({ time: t0 + 0.95, type: 'ATTACH_OBJECT', target: ev.object!, to: B!, socket: 'handR', duration: 0.2 });
      reach(A, 'right', null, t0 + 1.15, 0.5);
      reach(B!, 'right', null, t0 + 1.45, 0.7);
      look(B!, A, t0 + 1.6);
      break;
    }

    case 'pickUp': {
      const op = ctx.positionOf(B!, t);
      const a = approach(op, 0.5, t);
      push({ time: a.time, type: 'TRANSFORM_OBJECT', target: A, rotation: [0, yawTo(a.pos, op), 0], duration: 0.3 });
      look(A, B!, a.time);
      const low = op[1] < 0.75;
      if (low) push({ time: a.time + 0.1, type: 'SET_POSE', target: A, pose: 'crouch', duration: 0.55, easing: 'easeInOutQuad' });
      reach(A, 'right', B!, a.time + 0.3, 0.55);
      push({ time: a.time + 0.85, type: 'ATTACH_OBJECT', target: B!, to: A, socket: 'handR', duration: 0.15 });
      reach(A, 'right', null, a.time + 1.05, 0.55);
      if (low) push({ time: a.time + 1.05, type: 'SET_POSE', target: A, pose: 'rest', duration: 0.6, easing: 'easeInOutQuad' });
      look(A, null, a.time + 1.6);
      break;
    }

    case 'putDown': {
      const pa = ctx.positionOf(A, t);
      const yaw = ctx.yawOf(A, t) / RAD2DEG;
      const dest: Vec3 = ev.position ?? [pa[0] + Math.sin(yaw) * 0.55, 0, pa[2] + Math.cos(yaw) * 0.55];
      const a = approach(dest, 0.5, t);
      push({ time: a.time, type: 'TRANSFORM_OBJECT', target: A, rotation: [0, yawTo(a.pos, dest), 0], duration: 0.3 });
      look(A, dest, a.time);
      const low = dest[1] < 0.75;
      if (low) push({ time: a.time + 0.1, type: 'SET_POSE', target: A, pose: 'crouch', duration: 0.55, easing: 'easeInOutQuad' });
      reach(A, 'right', [dest[0], dest[1] + 0.1, dest[2]], a.time + 0.3, 0.55);
      push({ time: a.time + 0.85, type: 'DETACH_OBJECT', target: ev.object!, position: dest, duration: 0.15 });
      reach(A, 'right', null, a.time + 1.0, 0.55);
      if (low) push({ time: a.time + 1.0, type: 'SET_POSE', target: A, pose: 'rest', duration: 0.6, easing: 'easeInOutQuad' });
      look(A, null, a.time + 1.6);
      break;
    }

    case 'handOnShoulder': {
      const a = approach(ctx.positionOf(B!, t), 0.62, t);
      face(a.pos, a.time, B);
      look(A, B!, a.time);
      look(B!, A, a.time + 0.2);
      reach(A, 'right', { target: B!, part: 'shoulderL', offset: [0, 0.05, 0], local: true }, a.time + 0.25, 0.6);
      reach(A, 'right', null, a.time + 0.85 + hold, 0.6);
      break;
    }

    case 'push': {
      const pb = ctx.positionOf(B!, t);
      const a = approach(pb, 0.7, t);
      face(a.pos, a.time, B);
      const tHit = a.time + 0.35;
      reach(A, 'both', { target: B!, part: 'chest' }, tHit - 0.25, 0.25, { easing: 'easeOutQuad' });
      const dx = pb[0] - a.pos[0];
      const dz = pb[2] - a.pos[2];
      const len = Math.hypot(dx, dz) || 1;
      push({ time: tHit, type: 'TRANSFORM_OBJECT', target: B!, position: [pb[0] + (dx / len) * 0.8, pb[1], pb[2] + (dz / len) * 0.8], duration: 0.5, easing: 'easeOutCubic' });
      push({ time: tHit, type: 'SET_EXPRESSION', target: B!, expression: 'surprised', duration: 0.15 });
      push({ time: tHit, type: 'CAMERA_SHAKE', intensity: 0.25, decay: 5 });
      look(B!, A, tHit);
      reach(A, 'both', null, tHit + 0.3, 0.5);
      break;
    }

    case 'sit': {
      const seat = ev.position ?? ctx.positionOf(B!, t);
      const a = approach(seat, 0, t);
      const facing = ev.facing ?? ctx.yawOf(A, t);
      push({ time: a.time, type: 'TRANSFORM_OBJECT', target: A, rotation: [0, facing, 0], duration: 0.4, easing: 'easeOutQuad' });
      push({ time: a.time + 0.15, type: 'SET_POSE', target: A, pose: 'sit', seatHeight: ev.seatHeight ?? 0.45, duration: 0.65, easing: 'easeInOutQuad' });
      break;
    }

    case 'stand':
      push({ time: t, type: 'SET_POSE', target: A, pose: 'rest', duration: 0.6, easing: 'easeInOutQuad' });
      break;

    case 'kneel':
      if (ev.facing !== undefined) push({ time: t, type: 'TRANSFORM_OBJECT', target: A, rotation: [0, ev.facing, 0], duration: 0.4 });
      push({ time: t, type: 'SET_POSE', target: A, pose: 'kneel', duration: 0.7, easing: 'easeInOutQuad' });
      break;

    case 'pointAt': {
      const pa = ctx.positionOf(A, t);
      const dest = ev.position ?? ctx.positionOf(B!, t);
      const to: ReachTarget = ev.position ?? (ctx.isActor(B!) ? { target: B!, part: 'head' } : B!);
      push({ time: t, type: 'TRANSFORM_OBJECT', target: A, rotation: [0, yawTo(pa, dest), 0], duration: 0.4, easing: 'easeOutQuad' });
      look(A, ev.position ?? B!, t);
      reach(A, 'right', to, t + 0.2, 0.45, { easing: 'easeOutQuad' });
      reach(A, 'right', null, t + 0.65 + hold, 0.5);
      break;
    }
  }
  return out;
}

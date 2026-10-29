import {
  EXPRESSIONS,
  type AttachValue,
  type PoseFrame,
  type ReachFrame,
  type CameraValue,
  type EasingName,
  type ExpressionWeights,
  type RGB,
  type RetroSettings,
  type Vec3,
} from './types';
import { lerp, shortestAngleDeltaDeg } from '../utils/math';
import { interpolatePose } from './poses';

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

import {
  JOINTS,
  POSE_PRESETS,
  PROCEDURAL_RIG,
  type GestureDef,
  type Joint,
  type PoseDef,
  type PoseFrame,
  type PosePreset,
  type Vec3,
} from './types';
import { clamp01, lerp, smoothstep } from '../utils/math';

/**
 * Poses prontas (graus). Convenções do rig procedural (personagem olhando para +Z):
 * - ombro/quadril X negativo = membro para frente; Z = abrir para o lado
 *   (positivo no lado esquerdo/+X, negativo no direito);
 * - cotovelo X negativo = dobra para frente; joelho X positivo = dobra para trás;
 * - Y no ombro = torção do braço (muda o plano em que o cotovelo dobra).
 * `crouch` é calculado por ator em `resolvePose` (depende da altura).
 */
const PRESETS: Record<PosePreset, PoseDef> = {
  rest: {},
  sit: {
    hipL: [-88, 0, 5],
    hipR: [-88, 0, -5],
    kneeL: [88, 0, 0],
    kneeR: [88, 0, 0],
    chest: [-4, 0, 0],
    shoulderL: [-22, 0, 10],
    shoulderR: [-22, 0, -10],
    elbowL: [-55, 0, 0],
    elbowR: [-55, 0, 0],
  },
  kneel: {
    hipL: [-88, 0, 6],
    kneeL: [88, 0, 0],
    hipR: [2, 0, -4],
    kneeR: [92, 0, 0],
    chest: [8, 0, 0],
    neck: [6, 0, 0],
  },
  crouch: {
    hipL: [-72, 0, 8],
    hipR: [-72, 0, -8],
    kneeL: [122, 0, 0],
    kneeR: [122, 0, 0],
    chest: [28, 0, 0],
    neck: [-10, 0, 0],
  },
  armsCrossed: {
    shoulderL: [-28, -62, 8],
    elbowL: [-108, 0, 0],
    shoulderR: [-24, 62, -8],
    elbowR: [-112, 0, 0],
    chest: [-3, 0, 0],
  },
  handsOnHips: {
    shoulderL: [6, -88, 42],
    elbowL: [-82, 0, 0],
    shoulderR: [6, 88, -42],
    elbowR: [-82, 0, 0],
    chest: [-4, 0, 0],
  },
  handOnChin: {
    shoulderR: [-38, 42, -8],
    elbowR: [-142, 0, 0],
    shoulderL: [-26, -60, 8],
    elbowL: [-95, 0, 0],
    head: [8, 0, 6],
  },
  armsUp: {
    shoulderL: [0, 0, 158],
    shoulderR: [0, 0, -158],
    elbowL: [-12, 0, 0],
    elbowR: [-12, 0, 0],
    chest: [-8, 0, 0],
    head: [-14, 0, 0],
  },
};

export function isPosePreset(v: unknown): v is PosePreset {
  return typeof v === 'string' && (POSE_PRESETS as readonly string[]).includes(v);
}

/** Converte preset/pose explícita em PoseDef concreta para um ator de altura `height`. */
export function resolvePose(pose: PosePreset | PoseDef, height: number, seatHeight = 0.45): PoseDef {
  const k = height / PROCEDURAL_RIG.baseHeight;
  if (!isPosePreset(pose)) return pose;
  const def: PoseDef = { ...PRESETS[pose] };
  const hip = PROCEDURAL_RIG.hipHeight * k;
  switch (pose) {
    case 'sit':
      // Base da pelve (~6% da altura do quadril) apoiada no assento.
      def.crouch = Math.max(0, hip - 0.065 * k - seatHeight);
      break;
    case 'kneel':
      def.crouch = Math.max(0, hip - (PROCEDURAL_RIG.thigh + 0.06) * k);
      break;
    case 'crouch':
      def.crouch = 0.45 * k;
      break;
  }
  return def;
}

export function restPoseFrame(): PoseFrame {
  const joints = {} as PoseFrame['joints'];
  for (const j of JOINTS) joints[j] = { rot: [0, 0, 0], w: 0 };
  return { joints, crouch: 0 };
}

/** PoseDef -> PoseFrame. Articulações omitidas voltam ao procedural (w = 0), salvo `merge`. */
export function poseFrameFrom(def: PoseDef, from: PoseFrame, merge: boolean): PoseFrame {
  const joints = {} as PoseFrame['joints'];
  for (const j of JOINTS) {
    const r = def[j];
    if (r) joints[j] = { rot: r, w: 1 };
    else if (merge) joints[j] = from.joints[j];
    else joints[j] = { rot: from.joints[j].rot, w: 0 };
  }
  return { joints, crouch: def.crouch ?? (merge ? from.crouch : 0) };
}

export function interpolatePose(a: PoseFrame, b: PoseFrame, t: number): PoseFrame {
  const joints = {} as PoseFrame['joints'];
  for (const j of JOINTS) {
    const ja = a.joints[j];
    const jb = b.joints[j];
    // Se a articulação estava solta, parte direto da rotação alvo (evita "varrer" de [0,0,0]).
    const ra = ja.w > 0 ? ja.rot : jb.rot;
    joints[j] = {
      rot: [lerp(ra[0], jb.rot[0], t), lerp(ra[1], jb.rot[1], t), lerp(ra[2], jb.rot[2], t)],
      w: lerp(ja.w, jb.w, t),
    };
  }
  return { joints, crouch: lerp(a.crouch, b.crouch, t) };
}

export function validatePoseDef(pose: unknown): string[] {
  if (isPosePreset(pose)) return [];
  if (typeof pose === 'string') return [`pose '${pose}' desconhecida (use ${POSE_PRESETS.join(', ')} ou um objeto)`];
  if (typeof pose !== 'object' || pose === null || Array.isArray(pose)) return [`'pose' deve ser preset ou objeto`];
  const errs: string[] = [];
  for (const [k, v] of Object.entries(pose)) {
    if (k === 'crouch') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1.5) errs.push(`'pose.crouch' deve estar entre 0 e 1.5`);
    } else if (!(JOINTS as readonly string[]).includes(k)) {
      errs.push(`articulação '${k}' desconhecida (use ${JOINTS.join(', ')})`);
    } else if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      errs.push(`'pose.${k}' deve ser [x, y, z] em graus`);
    }
  }
  return errs;
}

export function validateGestureDef(name: string, g: unknown): string[] {
  const errs: string[] = [];
  const def = g as GestureDef;
  if (typeof g !== 'object' || g === null) return [`gestures.${name}: deve ser um objeto`];
  if (typeof def.duration !== 'number' || def.duration <= 0) errs.push(`gestures.${name}: 'duration' deve ser > 0`);
  if (!Array.isArray(def.keyframes) || def.keyframes.length === 0) errs.push(`gestures.${name}: 'keyframes' é obrigatório`);
  else
    def.keyframes.forEach((k, i) => {
      if (typeof k?.t !== 'number' || k.t < 0 || k.t > 1) errs.push(`gestures.${name}.keyframes[${i}]: 't' deve estar entre 0 e 1`);
      errs.push(...validatePoseDef(k?.pose).map((e) => `gestures.${name}.keyframes[${i}]: ${e}`));
    });
  return errs;
}

/**
 * Amostra um gesto por keyframes no progresso `p` (0..1). Retorna rotações e um
 * peso de envelope (entra/sai suavemente) — articulações ausentes não são afetadas.
 */
export function sampleGesture(g: GestureDef, p: number): { joints: Partial<Record<Joint, Vec3>>; crouch: number; weight: number } {
  const keys = [...g.keyframes].sort((a, b) => a.t - b.t);
  const used = new Set<Joint>();
  for (const k of keys) for (const j of JOINTS) if (k.pose[j]) used.add(j);

  const joints: Partial<Record<Joint, Vec3>> = {};
  for (const j of used) {
    const withJ = keys.filter((k) => k.pose[j]);
    let a = withJ[0];
    let b = withJ[withJ.length - 1];
    for (let i = 0; i < withJ.length - 1; i++) {
      if (p >= withJ[i].t && p <= withJ[i + 1].t) {
        a = withJ[i];
        b = withJ[i + 1];
        break;
      }
    }
    const span = b.t - a.t;
    const u = span > 0 ? smoothstep(0, 1, clamp01((p - a.t) / span)) : p < a.t ? 0 : 1;
    const ra = a.pose[j]!;
    const rb = b.pose[j]!;
    joints[j] = [lerp(ra[0], rb[0], u), lerp(ra[1], rb[1], u), lerp(ra[2], rb[2], u)];
  }

  const crouchKeys = keys.filter((k) => k.pose.crouch !== undefined);
  let crouch = 0;
  if (crouchKeys.length) {
    let a = crouchKeys[0];
    let b = crouchKeys[crouchKeys.length - 1];
    for (let i = 0; i < crouchKeys.length - 1; i++) {
      if (p >= crouchKeys[i].t && p <= crouchKeys[i + 1].t) {
        a = crouchKeys[i];
        b = crouchKeys[i + 1];
        break;
      }
    }
    const span = b.t - a.t;
    crouch = lerp(a.pose.crouch!, b.pose.crouch!, span > 0 ? clamp01((p - a.t) / span) : 1);
  }

  const weight = smoothstep(0, 0.12, p) * (1 - smoothstep(0.88, 1, p));
  return { joints, crouch, weight };
}

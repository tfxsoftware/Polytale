import * as THREE from 'three';
import type { Expression } from '../timeline/types';
import { clamp01 } from '../utils/math';


/* ========================================================================== */
/*  Morph targets                                                             */
/* ========================================================================== */

export const MORPH_NAMES = [
  'jawOpen',
  'mouthSmile',
  'mouthFrown',
  'mouthPucker',
  'mouthWide',
  'eyeBlink',
  'eyeSquint',
  'eyeWide',
  'browInnerUp',
  'browDown',
  'browOuterUp',
] as const;
export type MorphName = (typeof MORPH_NAMES)[number];
export type MorphWeights = Record<MorphName, number>;

/** Nomes alternativos (ARKit / Ready Player Me / Mixamo) para modelos GLTF. */
const MORPH_ALIASES: Record<MorphName, string[]> = {
  jawOpen: ['jawOpen', 'mouthOpen', 'MouthOpen', 'viseme_aa', 'A'],
  mouthSmile: ['mouthSmile', 'mouthSmileLeft', 'mouthSmileRight', 'smile', 'Smile'],
  mouthFrown: ['mouthFrown', 'mouthFrownLeft', 'mouthFrownRight', 'frown', 'Frown'],
  mouthPucker: ['mouthPucker', 'viseme_O', 'viseme_U', 'O'],
  mouthWide: ['mouthWide', 'mouthStretchLeft', 'mouthStretchRight', 'viseme_E', 'viseme_I', 'E'],
  eyeBlink: ['eyeBlink', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyesClosed', 'blink', 'Blink'],
  eyeSquint: ['eyeSquint', 'eyeSquintLeft', 'eyeSquintRight'],
  eyeWide: ['eyeWide', 'eyeWideLeft', 'eyeWideRight'],
  browInnerUp: ['browInnerUp'],
  browDown: ['browDown', 'browDownLeft', 'browDownRight'],
  browOuterUp: ['browOuterUp', 'browOuterUpLeft', 'browOuterUpRight'],
};

export function zeroMorphs(): MorphWeights {
  const w = {} as MorphWeights;
  for (const n of MORPH_NAMES) w[n] = 0;
  return w;
}

/** Endereça morph targets por nome lógico em todas as malhas de um objeto. */
export class MorphController {
  private readonly bindings = new Map<MorphName, { influences: number[]; index: number }[]>();

  constructor(root: THREE.Object3D) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      for (const name of MORPH_NAMES) {
        for (const alias of MORPH_ALIASES[name]) {
          const index = mesh.morphTargetDictionary[alias];
          if (index === undefined) continue;
          const list = this.bindings.get(name) ?? [];
          list.push({ influences: mesh.morphTargetInfluences, index });
          this.bindings.set(name, list);
        }
      }
    });
  }

  has(name: MorphName): boolean {
    return this.bindings.has(name);
  }

  set(name: MorphName, value: number): void {
    const list = this.bindings.get(name);
    if (!list) return;
    const v = clamp01(value);
    for (const b of list) b.influences[b.index] = v;
  }
}

/* ========================================================================== */
/*  Expressões                                                                */
/* ========================================================================== */

interface ExpressionPreset {
  morphs: Partial<MorphWeights>;
  /** Radianos: + olha para baixo. */
  headPitch?: number;
  headRoll?: number;
  /** Ombros caídos (+) / tensos (-). */
  slump?: number;
  /** Deslocamento do olhar (pupilas) quando sem alvo. */
  gazeUp?: number;
}

export const EXPRESSION_PRESETS: Record<Expression, ExpressionPreset> = {
  neutral: { morphs: {} },
  happy: { morphs: { mouthSmile: 1, eyeSquint: 0.3, browOuterUp: 0.25 }, headPitch: -0.04 },
  sad: { morphs: { mouthFrown: 0.9, browInnerUp: 1, eyeSquint: 0.2 }, headPitch: 0.18, slump: 1 },
  angry: { morphs: { mouthFrown: 0.55, browDown: 1, eyeSquint: 0.5, mouthWide: 0.2 }, headPitch: 0.06, slump: -0.6 },
  surprised: { morphs: { jawOpen: 0.45, mouthPucker: 0.35, browInnerUp: 0.8, browOuterUp: 1, eyeWide: 1 }, headPitch: -0.1, slump: -0.4 },
  thinking: { morphs: { mouthPucker: 0.25, mouthFrown: 0.2, browDown: 0.35, eyeSquint: 0.2 }, headRoll: 0.14, gazeUp: 1 },
};

/* ========================================================================== */
/*  Geometria procedural do rosto (com morph targets)                          */
/* ========================================================================== */

function morphGeometry(base: number[], index: number[], targets: Record<string, number[]>): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
  geo.setIndex(index);
  geo.morphTargetsRelative = true;
  geo.morphAttributes.position = Object.entries(targets).map(([name, target]) => {
    const delta = target.map((v, i) => v - base[i]);
    const attr = new THREE.Float32BufferAttribute(delta, 3);
    attr.name = name;
    return attr;
  });
  geo.computeVertexNormals();
  return geo;
}

/** Boca: leque elíptico. Base = boca fechada (linha fina). */
export function createMouthGeometry(): THREE.BufferGeometry {
  const N = 16;
  const W = 0.13;
  const shape = (fn: (c: number, s: number) => [number, number]): number[] => {
    const ring: number[] = [];
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const [x, y] = fn(Math.cos(a), Math.sin(a));
      ring.push(x, y, 0);
      cx += x;
      cy += y;
    }
    return [cx / N, cy / N, 0, ...ring];
  };
  const bend = (k: number) => (c: number, s: number): [number, number] => {
    const x = (c * W) / 2;
    return [x * 1.05, (s * 0.012) / 2 + k * (x / (W / 2)) ** 2];
  };

  const base = shape((c, s) => [(c * W) / 2, (s * 0.012) / 2]);
  const index: number[] = [];
  for (let i = 0; i < N; i++) index.push(0, 1 + i, 1 + ((i + 1) % N));

  return morphGeometry(base, index, {
    jawOpen: shape((c, s) => [(c * 0.11) / 2, s > 0 ? s * 0.012 : s * 0.095]),
    mouthWide: shape((c, s) => [(c * 0.18) / 2, (s * 0.03) / 2]),
    mouthPucker: shape((c, s) => [(c * 0.055) / 2, (s * 0.05) / 2]),
    mouthSmile: shape(bend(0.032)),
    mouthFrown: shape(bend(-0.028)),
  });
}

/** Pálpebra superior: faixa acima do olho; `eyeBlink` desce a borda inferior cobrindo o olho. */
export function createEyelidGeometry(): THREE.BufferGeometry {
  const COLS = 6;
  const W = 0.13;
  const top = 0.07;
  const rest = 0.052;
  const base: number[] = [];
  const blink: number[] = [];
  const squint: number[] = [];
  const wide: number[] = [];
  for (let i = 0; i <= COLS; i++) {
    const u = i / COLS;
    const x = (u - 0.5) * W;
    const curve = 1 - (2 * u - 1) ** 2; // borda curva
    // linha superior (fixa)
    base.push(x, top, 0);
    blink.push(x, top, 0);
    squint.push(x, top, 0);
    wide.push(x, top, 0);
    // linha inferior (móvel)
    base.push(x, rest + curve * 0.004, 0);
    blink.push(x, -0.056 - curve * 0.006, 0);
    squint.push(x, 0.012 + curve * 0.004, 0);
    wide.push(x, rest + 0.012 + curve * 0.004, 0);
  }
  const index: number[] = [];
  for (let i = 0; i < COLS; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    index.push(a, b, c, b, d, c);
  }
  return morphGeometry(base, index, { eyeBlink: blink, eyeSquint: squint, eyeWide: wide });
}

/** Sobrancelha: quad. `side` = +1 (esquerda, +x) ou -1 (direita). */
export function createBrowGeometry(side: 1 | -1): THREE.BufferGeometry {
  const W = 0.095;
  const H = 0.02;
  // inner = lado voltado para x = 0.
  const innerX = side > 0 ? -W / 2 : W / 2;
  const outerX = -innerX;
  const base = [innerX, H / 2, 0, innerX, -H / 2, 0, outerX, H / 2, 0, outerX, -H / 2, 0];
  const index = side > 0 ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3];
  const move = (inner: number, outer: number) =>
    base.map((v, i) => (i % 3 === 1 ? v + (i < 6 ? inner : outer) : v));
  return morphGeometry(base, index, {
    browInnerUp: move(0.03, 0.004),
    browDown: move(-0.026, 0.004),
    browOuterUp: move(0.006, 0.03),
  });
}

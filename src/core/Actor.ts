import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  JOINTS,
  PROCEDURAL_RIG,
  type ActorFrame,
  type ActorObjectDef,
  type BodyPart,
  type Expression,
  type GestureDef,
  type Hand,
  type Joint,
  type ObjectFrame,
  type PoseFrame,
  type Socket,
} from '../timeline/types';
import { restPoseFrame, sampleGesture } from '../timeline/poses';
import { addAccessories, addHair, addOutfit, buildProportions, createHeadGeometry } from './CharacterStyle';
import type { LipsyncState } from '../systems/AudioLipsync';
import { applyPS1VertexSnap } from '../systems/PostProcessing';
import { DEG2RAD, clamp, clamp01, damp, fbm1D, hashString, lerp, seededRandom, smoothstep } from '../utils/math';

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
type MorphWeights = Record<MorphName, number>;

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

function zeroMorphs(): MorphWeights {
  const w = {} as MorphWeights;
  for (const n of MORPH_NAMES) w[n] = 0;
  return w;
}

/** Endereça morph targets por nome lógico em todas as malhas de um objeto. */
class MorphController {
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

const EXPRESSION_PRESETS: Record<Expression, ExpressionPreset> = {
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
function createMouthGeometry(): THREE.BufferGeometry {
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
function createEyelidGeometry(): THREE.BufferGeometry {
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
function createBrowGeometry(side: 1 | -1): THREE.BufferGeometry {
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

/* ========================================================================== */
/*  Rig procedural                                                            */
/* ========================================================================== */

interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
}

/** Cadeia de dois ossos para IK (ombro -> cotovelo -> mão). */
interface ArmChain {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  end: THREE.Object3D;
}

/** Partes comuns aos dois tipos de rig (procedural e GLTF). */
interface RigCommon {
  body: THREE.Group;
  headCenter: THREE.Object3D;
  chestCenter: THREE.Object3D;
  /** Articulações controláveis por SET_POSE / gestos customizados. */
  joints: Partial<Record<Joint, THREE.Object3D>>;
  arms: Partial<Record<Hand, ArmChain>>;
  sockets: Record<Socket, THREE.Object3D>;
}

interface ProceduralRig extends RigCommon {
  kind: 'procedural';
  hips: THREE.Group;
  chest: THREE.Group;
  neck: THREE.Group;
  head: THREE.Group;
  eyes: THREE.Group[];
  pupils: THREE.Object3D[];
  armL: Limb;
  armR: Limb;
  legL: Limb;
  legR: Limb;
  chestBaseY: number;
  /** Pivô da capa (acessório), animado pela caminhada. */
  cape: THREE.Object3D | null;
}

interface GltfRig extends RigCommon {
  kind: 'gltf';
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  headBone: THREE.Object3D | null;
  neckBone: THREE.Object3D | null;
  spineBone: THREE.Object3D | null;
  /** Rotação de repouso dos ossos manipulados (reaplicada a cada quadro antes do mixer). */
  rest: Map<THREE.Object3D, THREE.Quaternion>;
}

type Rig = ProceduralRig | GltfRig;

const BASE_HEIGHT = PROCEDURAL_RIG.baseHeight;

/** Articulações aplicadas de forma aditiva (preservam olhar/respiração); as demais sobrescrevem. */
const ADDITIVE_JOINTS = new Set<Joint>(['hips', 'chest', 'neck', 'head']);

function socket(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = `socket:${name}`;
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

function lambert(color: THREE.ColorRepresentation): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
  applyPS1VertexSnap(m);
  return m;
}

/** Traços do rosto: iluminados como a pele, com polygonOffset para não "brigar" com a face. */
function faceMaterial(color: THREE.ColorRepresentation, offset: number): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -offset,
    polygonOffsetUnits: -offset,
  });
  applyPS1VertexSnap(m);
  return m;
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, y = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = y;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Cilindro "pendurado" no pivô (topo em y = 0). */
function hangingCylinder(rTop: number, rBottom: number, length: number, mat: THREE.Material, segments = 6): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, length, segments);
  geo.translate(0, -length / 2, 0);
  return part(geo, mat);
}

function buildLimb(
  parent: THREE.Object3D,
  pos: THREE.Vector3,
  upperLen: number,
  lowerLen: number,
  rUpper: number,
  rLower: number,
  matUpper: THREE.Material,
  matLower: THREE.Material,
  end: THREE.Mesh,
): Limb {
  const upper = new THREE.Group();
  upper.position.copy(pos);
  upper.add(hangingCylinder(rUpper, rUpper * 0.9, upperLen, matUpper));
  const lower = new THREE.Group();
  lower.position.y = -upperLen;
  lower.add(hangingCylinder(rLower, rLower * 0.85, lowerLen, matLower));
  end.position.y += -lowerLen;
  lower.add(end);
  upper.add(lower);
  parent.add(upper);
  return { upper, lower };
}

function buildProceduralRig(def: ActorObjectDef): ProceduralRig {
  const p = def.palette ?? {};
  const skin = new THREE.Color(p.skin ?? '#e0ac69');
  const mSkin = lambert(skin);
  const mHair = lambert(p.hair ?? '#3b2a1a');
  const mShirt = lambert(p.shirt ?? '#3f6fb5');
  const mPants = lambert(p.pants ?? '#2d2d3a');
  const mShoes = lambert(p.shoes ?? '#1c1410');
  const accentColor = p.accent ?? '#8a2b2b';
  const mAccent = lambert(accentColor);
  const mAccentDouble = lambert(accentColor);
  mAccentDouble.side = THREE.DoubleSide;
  const pr = buildProportions(def.build);

  const body = new THREE.Group();
  body.name = 'body';

  // Quadril + pernas
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  body.add(hips);
  hips.add(part(new THREE.BoxGeometry(0.34 * pr.hipWidth, 0.16, 0.21 * pr.depth), mPants, 0.02));

  const foot = () => {
    const g = new THREE.BoxGeometry(0.11, 0.07, 0.2);
    g.translate(0, -0.035, 0.04);
    return part(g, mShoes);
  };
  const { thigh, shin, upperArm, forearm } = PROCEDURAL_RIG;
  const legX = 0.09 * pr.hipWidth;
  const legL = buildLimb(hips, new THREE.Vector3(legX, -0.03, 0), thigh, shin, 0.068 * pr.limb, 0.058 * pr.limb, mPants, mPants, foot());
  const legR = buildLimb(hips, new THREE.Vector3(-legX, -0.03, 0), thigh, shin, 0.068 * pr.limb, 0.058 * pr.limb, mPants, mPants, foot());

  // Tronco (peito respira)
  const chest = new THREE.Group();
  const chestBaseY = 0.08;
  chest.position.y = chestBaseY;
  hips.add(chest);
  chest.add(part(new THREE.CylinderGeometry(pr.chestTop, pr.chestBottom, 0.52, 6).translate(0, 0.26, 0).scale(1, 1, pr.depth), mShirt));
  const chestCenter = new THREE.Object3D();
  chestCenter.position.y = 0.3;
  chest.add(chestCenter);

  const hand = () => part(new THREE.BoxGeometry(0.075, 0.09, 0.06).translate(0, -0.045, 0), mSkin);
  const shoulderX = (pr.chestTop + 0.05) * pr.shoulders;
  const armL = buildLimb(chest, new THREE.Vector3(shoulderX, 0.47, 0), upperArm, forearm, 0.052 * pr.limb, 0.046 * pr.limb, mShirt, mSkin, hand());
  const armR = buildLimb(chest, new THREE.Vector3(-shoulderX, 0.47, 0), upperArm, forearm, 0.052 * pr.limb, 0.046 * pr.limb, mShirt, mSkin, hand());
  // Centro da mão: efetor do IK e encaixe para objetos segurados.
  const handL = socket(armL.lower, 'handL', 0, -(forearm + 0.045), 0.01);
  const handR = socket(armR.lower, 'handR', 0, -(forearm + 0.045), 0.01);
  // Ordem ZXY no ombro: torção (Y) no eixo do próprio braço, depois flexão (X), depois abertura (Z).
  armL.upper.rotation.set(0, 0, 0.1, 'ZXY');
  armR.upper.rotation.set(0, 0, -0.1, 'ZXY');

  // Pescoço + cabeça
  const neck = new THREE.Group();
  neck.position.y = 0.52;
  chest.add(neck);
  neck.add(part(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 6).translate(0, 0.04, 0), mSkin));

  const head = new THREE.Group();
  head.position.y = 0.07;
  neck.add(head);
  const HC = 0.21; // centro da cabeça acima do pivô
  const shape = createHeadGeometry(def.headShape);
  const FRONT = shape.surfaceZ(0, 0); // face frontal (z)
  /** z (relativo ao rosto) que deixa um traço por cima da superfície em (x ± hw, y ± hh). */
  const faceZ = (x: number, y: number, hw: number, hh: number) => shape.surfaceZ(x, y, hw, hh) - FRONT;
  head.add(part(shape.geometry, mSkin, HC));
  // Nariz
  const nose = part(new THREE.BoxGeometry(0.04, 0.06, 0.035), mSkin, HC - 0.03);
  nose.position.z = shape.surfaceZ(0, -0.03, 0.02, 0.03) + 0.015;
  head.add(nose);

  const headCenter = new THREE.Object3D();
  headCenter.position.set(0, HC + 0.03, FRONT);
  head.add(headCenter);

  // Rosto
  const face = new THREE.Group();
  face.position.set(0, HC, FRONT);
  head.add(face);

  const eyes: THREE.Group[] = [];
  const pupils: THREE.Object3D[] = [];
  const lidColor = skin.clone().multiplyScalar(0.82);
  for (const side of [1, -1] as const) {
    // Olho + pálpebra (que cobre de -0.056 a +0.07 em torno do olho) ficam por cima da superfície.
    const eyeZ = faceZ(side * 0.088, 0.035, 0.065, 0.07);
    const eye = new THREE.Group();
    eye.position.set(side * 0.088, 0.035, eyeZ + 0.002);
    face.add(eye);
    eye.add(new THREE.Mesh(new THREE.CircleGeometry(0.05, 10), faceMaterial('#f4f1e8', 1)));
    const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.024, 8), faceMaterial(p.eyes ?? '#1d1a2a', 2));
    pupil.position.z = 0.001;
    eye.add(pupil);
    eyes.push(eye);
    pupils.push(pupil);

    const lid = new THREE.Mesh(createEyelidGeometry(), faceMaterial(lidColor, 3));
    lid.position.set(side * 0.088, 0.035, eyeZ + 0.004);
    lid.name = 'eyelid';
    face.add(lid);

    const brow = new THREE.Mesh(createBrowGeometry(side), faceMaterial(p.hair ?? '#3b2a1a', 3));
    brow.position.set(side * 0.088, 0.115, faceZ(side * 0.088, 0.115, 0.05, 0.035) + 0.004);
    brow.rotation.z = side * -0.06;
    face.add(brow);
  }

  const mouth = new THREE.Mesh(createMouthGeometry(), faceMaterial('#4a1218', 2));
  // Aberta, a boca desce até ~-0.2 e alarga até ±0.09.
  mouth.position.set(0, -0.105, faceZ(0, -0.13, 0.09, 0.07) + 0.003);
  mouth.name = 'mouth';
  face.add(mouth);

  // Visual: cabelo, roupa e acessórios.
  const fitted = (fit: { y: number; scaleX: number; scaleZ: number }) => {
    const g = new THREE.Group();
    g.position.y = fit.y;
    g.scale.set(fit.scaleX, 1, fit.scaleZ);
    head.add(g);
    return g;
  };
  const style = {
    crown: fitted(shape.crown),
    jaw: fitted(shape.jaw),
    face,
    faceZ,
    neck,
    chest,
    hips,
    headCenter: HC,
    front: 0.19,
    proportions: pr,
    materials: { hair: mHair, shirt: mShirt, accent: mAccent, accentDouble: mAccentDouble, metal: lambert('#d4a93a'), dark: lambert('#2a2420') },
    part: (geo: THREE.BufferGeometry, mat: THREE.Material, y = 0) => part(geo, mat, y),
    faceMaterial,
  };
  addHair(style, def.hair);
  addOutfit(style, def.outfit);
  const { cape } = addAccessories(style, def.accessories);

  const sockets: Record<Socket, THREE.Object3D> = {
    handL,
    handR,
    head: socket(head, 'head', 0, HC + shape.top + 0.05, 0),
    back: socket(chest, 'back', 0, 0.3, -0.2),
    chest: socket(chest, 'chest', 0, 0.3, 0.2),
  };
  const joints: Partial<Record<Joint, THREE.Object3D>> = {
    hips,
    chest,
    neck,
    head,
    shoulderL: armL.upper,
    elbowL: armL.lower,
    shoulderR: armR.upper,
    elbowR: armR.lower,
    hipL: legL.upper,
    kneeL: legL.lower,
    hipR: legR.upper,
    kneeR: legR.lower,
  };
  return {
    kind: 'procedural',
    body,
    hips,
    chest,
    neck,
    head,
    eyes,
    pupils,
    armL,
    armR,
    legL,
    legR,
    headCenter,
    chestCenter,
    chestBaseY,
    cape,
    joints,
    arms: { left: { upper: armL.upper, lower: armL.lower, end: handL }, right: { upper: armR.upper, lower: armR.lower, end: handR } },
    sockets,
  };
}

function buildGltfRig(gltf: GLTF): GltfRig {
  const body = new THREE.Group();
  body.name = 'body';
  const model = cloneSkinned(gltf.scene);
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => applyPS1VertexSnap(m));
  });
  body.add(model);

  const find = (re: RegExp): THREE.Object3D | null => {
    let found: THREE.Object3D | null = null;
    model.traverse((o) => {
      if (!found && (o as THREE.Bone).isBone && re.test(o.name)) found = o;
    });
    return found;
  };
  const headBone = find(/head(?!top|_end)/i);
  const neckBone = find(/neck/i);
  const spineBone = find(/spine2|chest|upperchest/i) ?? find(/spine/i);

  const bbox = new THREE.Box3().setFromObject(model);
  const height = bbox.max.y - bbox.min.y;
  const headCenter = new THREE.Object3D();
  const chestCenter = new THREE.Object3D();
  if (headBone) {
    headBone.add(headCenter);
    headCenter.position.set(0, height * 0.05, 0);
  } else {
    body.add(headCenter);
    headCenter.position.set(0, bbox.max.y - height * 0.08, 0);
  }
  if (spineBone) spineBone.add(chestCenter);
  else {
    body.add(chestCenter);
    chestCenter.position.y = bbox.min.y + height * 0.7;
  }

  // Nomes no padrão Mixamo / Ready Player Me (com ou sem prefixo "mixamorig").
  const side = (s: 'Left' | 'Right', re: string) => find(new RegExp(`${s}_?${re}$`, 'i'));
  const joints: Partial<Record<Joint, THREE.Object3D>> = {};
  const assign = (j: Joint, o: THREE.Object3D | null) => {
    if (o) joints[j] = o;
  };
  assign('hips', find(/hips$/i));
  assign('chest', spineBone);
  assign('neck', neckBone);
  assign('head', headBone);
  assign('shoulderL', side('Left', 'arm'));
  assign('elbowL', side('Left', 'fore_?arm'));
  assign('shoulderR', side('Right', 'arm'));
  assign('elbowR', side('Right', 'fore_?arm'));
  assign('hipL', side('Left', 'up_?leg'));
  assign('kneeL', side('Left', 'leg'));
  assign('hipR', side('Right', 'up_?leg'));
  assign('kneeR', side('Right', 'leg'));
  const handBoneL = side('Left', 'hand');
  const handBoneR = side('Right', 'hand');

  const arms: Partial<Record<Hand, ArmChain>> = {};
  if (joints.shoulderL && joints.elbowL && handBoneL) arms.left = { upper: joints.shoulderL, lower: joints.elbowL, end: handBoneL };
  if (joints.shoulderR && joints.elbowR && handBoneR) arms.right = { upper: joints.shoulderR, lower: joints.elbowR, end: handBoneR };

  const anchor = (parent: THREE.Object3D | null, name: string, fallback: THREE.Vector3) =>
    parent ? socket(parent, name, 0, 0, 0) : socket(body, name, fallback.x, fallback.y, fallback.z);
  const sockets: Record<Socket, THREE.Object3D> = {
    handL: anchor(handBoneL, 'handL', new THREE.Vector3(height * 0.25, height * 0.45, 0)),
    handR: anchor(handBoneR, 'handR', new THREE.Vector3(-height * 0.25, height * 0.45, 0)),
    head: anchor(headBone, 'head', new THREE.Vector3(0, bbox.max.y, 0)),
    back: socket(chestCenter, 'back', 0, 0, -height * 0.08),
    chest: socket(chestCenter, 'chest', 0, 0, height * 0.08),
  };

  const rest = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const o of [headBone, neckBone, spineBone, ...Object.values(joints)]) if (o) rest.set(o, o.quaternion.clone());

  return {
    kind: 'gltf',
    body,
    mixer: new THREE.AnimationMixer(model),
    clips: gltf.animations,
    headBone,
    neckBone,
    spineBone,
    headCenter,
    chestCenter,
    joints,
    arms,
    sockets,
    rest,
  };
}

/* ========================================================================== */
/*  IK de dois ossos                                                          */
/* ========================================================================== */

const _ikA = new THREE.Vector3();
const _ikB = new THREE.Vector3();
const _ikC = new THREE.Vector3();
const _ikT = new THREE.Vector3();
const _ikP = new THREE.Vector3();
const _ikE = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
const _ikTmp = new THREE.Vector3();
const _ikCur = new THREE.Vector3();
const _ikDes = new THREE.Vector3();
const _ikQ1 = new THREE.Quaternion();
const _ikQ2 = new THREE.Quaternion();
const _ikQ3 = new THREE.Quaternion();

/** Gira `bone` (em espaço de mundo) para que o filho em `childWorld` aponte para `desiredWorld`. */
function aimBone(bone: THREE.Object3D, childWorld: THREE.Vector3, desiredWorld: THREE.Vector3): void {
  bone.getWorldPosition(_ikTmp);
  _ikCur.subVectors(childWorld, _ikTmp);
  _ikDes.subVectors(desiredWorld, _ikTmp);
  if (_ikCur.lengthSq() < 1e-10 || _ikDes.lengthSq() < 1e-10) return;
  const delta = _ikQ1.setFromUnitVectors(_ikCur.normalize(), _ikDes.normalize());
  const world = bone.getWorldQuaternion(_ikQ2).premultiply(delta);
  const parent = bone.parent ? bone.parent.getWorldQuaternion(_ikQ3) : _ikQ3.identity();
  bone.quaternion.copy(parent.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/**
 * IK analítico de dois ossos (lei dos cossenos) independente dos eixos do rig:
 * funciona no personagem procedural e em esqueletos GLTF (Mixamo/RPM).
 * `pole` (ponto no mundo) define para onde o cotovelo aponta. `weight` mistura
 * suavemente a pose atual (0) com a solução (1) — sem "estalos" ao ligar/desligar.
 */
export function solveTwoBoneIK(chain: ArmChain, target: THREE.Vector3, pole: THREE.Vector3, weight: number): void {
  const { upper, lower, end } = chain;
  upper.getWorldPosition(_ikA);
  lower.getWorldPosition(_ikB);
  end.getWorldPosition(_ikC);
  const l1 = _ikA.distanceTo(_ikB);
  const l2 = _ikB.distanceTo(_ikC);
  if (l1 < 1e-5 || l2 < 1e-5) return;

  _ikT.copy(_ikC).lerp(target, weight);
  _ikP.copy(_ikB).lerp(pole, weight);

  _ikDir.subVectors(_ikT, _ikA);
  const raw = _ikDir.length();
  if (raw < 1e-5) return;
  _ikDir.divideScalar(raw);
  const dist = clamp(raw, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);

  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);

  // Direção do cotovelo: componente do pole perpendicular ao eixo ombro->alvo.
  const bend = _ikP.sub(_ikA);
  bend.addScaledVector(_ikDir, -bend.dot(_ikDir));
  if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0).addScaledVector(_ikDir, _ikDir.y);
  bend.normalize();

  _ikE.copy(_ikA)
    .addScaledVector(_ikDir, cosA * l1)
    .addScaledVector(bend, sinA * l1);
  const wrist = _ikTmp.copy(_ikA).addScaledVector(_ikDir, dist).clone();

  aimBone(upper, _ikB, _ikE);
  lower.getWorldPosition(_ikB);
  end.getWorldPosition(_ikC);
  aimBone(lower, _ikC, wrist);
}

/* ========================================================================== */
/*  Actor                                                                     */
/* ========================================================================== */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _pole = new THREE.Vector3();

/**
 * Personagem: encapsula malha 3D, morph targets (rosto) e a "vida" procedural.
 *
 * Fluxo por quadro:
 *  1. `applyFrame()` — estado vindo da timeline (transform, expressão, gesto, clipe).
 *  2. `setLipsync()` / `setLookTarget()` — entradas de áudio e olhar.
 *  3. `update(deltaTime)` — respiração, piscar, sacadas, caminhada, gestos e morphs.
 */
export class Actor {
  readonly root = new THREE.Group();
  private readonly rig: Rig;
  private readonly morphs: MorphController;
  private readonly rand: () => number;
  private readonly seed: number;

  // Estado vindo da timeline
  private expression: ActorFrame['expression'] | null = null;
  private gesture: { name: string; progress: number } | null = null;
  private pose: PoseFrame = restPoseFrame();
  private gestureLibrary: Readonly<Record<string, GestureDef>> = {};
  private readonly reach: Record<Hand, { point: THREE.Vector3; weight: number; shake: number }> = {
    left: { point: new THREE.Vector3(), weight: 0, shake: 0 },
    right: { point: new THREE.Vector3(), weight: 0, shake: 0 },
  };
  private readonly bodyScale: number;
  private clip: ActorFrame['clip'] = null;
  private timelineTime = 0;
  private lipsync: LipsyncState = { jawOpen: 0, mouthWide: 0, mouthPucker: 0, energy: 0, speaking: false };
  private lookTarget: THREE.Vector3 | null = null;

  // Vida procedural
  private clock = 0;
  private readonly breathPeriod: number;
  private blinkTimer: number;
  private blinkT = -1;
  private doubleBlink = false;
  private saccadeTimer = 0;
  private readonly saccadeOffset = new THREE.Vector3();
  private readonly gazeLocal = new THREE.Vector2();
  private headYaw = 0;
  private headPitch = 0;
  private talkAmount = 0;

  // Locomoção
  private readonly lastWorldPos = new THREE.Vector3();
  private hasLastPos = false;
  private speed = 0;
  private walkPhase = 0;
  private walkAmount = 0;

  // Mixer GLTF
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private idleAction: THREE.AnimationAction | null = null;

  constructor(
    readonly id: string,
    readonly def: ActorObjectDef,
    gltf?: GLTF,
  ) {
    this.seed = hashString(id);
    this.rand = seededRandom(this.seed);
    this.breathPeriod = 3.4 + this.rand() * 1.2;
    this.blinkTimer = 1 + this.rand() * 3;

    this.rig = gltf ? buildGltfRig(gltf) : buildProceduralRig(def);
    const scale = gltf ? 1 : (def.height ?? 1.75) / BASE_HEIGHT;
    this.bodyScale = scale;
    this.rig.body.scale.setScalar(scale);
    this.root.add(this.rig.body);
    this.root.name = `actor:${id}`;
    this.root.visible = false;
    this.morphs = new MorphController(this.rig.body);

    if (this.rig.kind === 'gltf' && def.idleClip) {
      const clip = THREE.AnimationClip.findByName(this.rig.clips, def.idleClip);
      if (clip) {
        this.idleAction = this.rig.mixer.clipAction(clip);
        this.idleAction.play();
      } else console.warn(`[Actor:${id}] clipe idle '${def.idleClip}' não encontrado`);
    }
  }

  get name(): string {
    return this.def.name;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** Aplica o estado determinístico da timeline. */
  applyFrame(obj: ObjectFrame, actor: ActorFrame, timelineTime: number): void {
    const wasVisible = this.root.visible;
    this.root.visible = obj.visible;
    this.root.position.set(obj.position[0], obj.position[1], obj.position[2]);
    this.root.rotation.set(obj.rotation[0] * DEG2RAD, obj.rotation[1] * DEG2RAD, obj.rotation[2] * DEG2RAD, 'YXZ');
    this.root.scale.setScalar(obj.scale);
    this.expression = actor.expression;
    this.gesture = actor.gesture;
    this.clip = actor.clip;
    this.pose = actor.pose;
    this.timelineTime = timelineTime;
    if (!wasVisible && obj.visible) this.hasLastPos = false;
  }

  /** Gestos customizados (keyframes) disponíveis para PLAY_GESTURE. */
  setGestureLibrary(library: Readonly<Record<string, GestureDef>>): void {
    this.gestureLibrary = library;
  }

  /** Alvo da mão (IK) no mundo; `weight` 0 = braço livre. */
  setReach(hand: Hand, point: THREE.Vector3 | null, weight: number, shake = 0): void {
    const r = this.reach[hand];
    r.weight = point ? clamp01(weight) : 0;
    r.shake = shake;
    if (point) r.point.copy(point);
  }

  /** Transformação de mundo de um encaixe (mão, cabeça, costas, peito). */
  getSocketWorld(socketName: Socket, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const s = this.rig.sockets[socketName];
    s.getWorldPosition(outPos);
    s.getWorldQuaternion(outQuat);
  }

  /** Posição de mundo de uma parte do corpo (alvos de REACH). */
  getPartWorldPosition(part: BodyPart, out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    switch (part) {
      case 'head':
        return this.rig.headCenter.getWorldPosition(out);
      case 'chest':
        return this.rig.sockets.chest.getWorldPosition(out);
      case 'back':
        return this.rig.sockets.back.getWorldPosition(out);
      case 'handL':
        return this.rig.sockets.handL.getWorldPosition(out);
      case 'handR':
        return this.rig.sockets.handR.getWorldPosition(out);
      case 'shoulderL':
      case 'shoulderR': {
        const j = this.rig.joints[part];
        if (j) return j.getWorldPosition(out);
        return this.rig.chestCenter.getWorldPosition(out);
      }
      case 'root':
      default:
        return out.copy(this.root.position);
    }
  }

  setLipsync(state: LipsyncState): void {
    this.lipsync = state;
  }

  /** Alvo do olhar no mundo (null = olhar livre para frente). */
  setLookTarget(target: THREE.Vector3 | null): void {
    if (!target) this.lookTarget = null;
    else (this.lookTarget ??= new THREE.Vector3()).copy(target);
  }

  getHeadWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.rig.headCenter.getWorldPosition(out);
  }

  getChestWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.rig.chestCenter.getWorldPosition(out);
  }

  /** Direção para onde o corpo está voltado (plano XZ). */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.root.quaternion).setY(0).normalize();
  }

  /** Vida procedural — roda sempre, independentemente da timeline estar pausada. */
  update(deltaTime: number): void {
    const dt = Math.min(deltaTime, 0.1);
    this.clock += dt;

    this.updateLocomotion(dt);
    this.updateBlink(dt);
    this.updateSaccades(dt);
    this.talkAmount = damp(this.talkAmount, this.lipsync.speaking ? clamp01(this.lipsync.energy * 1.6) : 0, 6, dt);

    if (this.rig.kind === 'procedural') this.updateProceduralBody(this.rig, dt);
    else this.updateGltfBody(this.rig, dt);

    this.applyPoseLayers();
    this.applyReachIK();
    this.updateFace();
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => m.dispose());
    });
    if (this.rig.kind === 'gltf') this.rig.mixer.stopAllAction();
    this.root.removeFromParent();
  }

  /* ---------------------------------------------------------------------- */
  /*  Lógicas procedurais                                                   */
  /* ---------------------------------------------------------------------- */

  /** Velocidade estimada a partir do deslocamento real (alimenta o ciclo de caminhada). */
  private updateLocomotion(dt: number): void {
    const pos = _v.copy(this.root.position);
    if (this.hasLastPos && dt > 0) {
      const dist = Math.hypot(pos.x - this.lastWorldPos.x, pos.z - this.lastWorldPos.z);
      // Saltos grandes (seek) não contam como caminhada.
      const instant = dist > 0.5 ? 0 : dist / dt;
      this.speed = damp(this.speed, instant, 10, dt);
    }
    this.lastWorldPos.copy(pos);
    this.hasLastPos = true;
    const STRIDE = 1.15;
    this.walkPhase += (this.speed / STRIDE) * Math.PI * 2 * dt;
    this.walkAmount = damp(this.walkAmount, clamp01(this.speed / 1.1), 8, dt);
  }

  /** Piscar aleatório: timer 2–5s dispara um tween de ida-e-volta de 0.15s no morph eyeBlink. */
  private updateBlink(dt: number): void {
    const BLINK = 0.15;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      if (this.blinkT >= BLINK) {
        this.blinkT = -1;
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.blinkTimer = 0.12;
        } else this.blinkTimer = 2 + this.rand() * 3;
      }
    } else {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkT = 0;
        this.doubleBlink = this.rand() < 0.15;
      }
    }
  }

  private blinkValue(): number {
    if (this.blinkT < 0) return 0;
    return Math.sin(Math.PI * clamp01(this.blinkT / 0.15));
  }

  /** Micro-saltos do olhar: a cada 0.25–1.4s o alvo recebe um deslocamento aleatório milimétrico. */
  private updateSaccades(dt: number): void {
    this.saccadeTimer -= dt;
    if (this.saccadeTimer <= 0) {
      this.saccadeTimer = 0.25 + this.rand() * 1.15;
      const r = 0.035;
      this.saccadeOffset.set((this.rand() - 0.5) * 2 * r, (this.rand() - 0.5) * 2 * r * 0.6, (this.rand() - 0.5) * 2 * r);
    }
  }

  /** Alvo do olhar com ruído contínuo (fbm) + sacada; null se olhar livre. */
  private noisyLookTarget(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.lookTarget) return null;
    const t = this.clock * 0.6;
    out.copy(this.lookTarget).add(this.saccadeOffset);
    out.x += fbm1D(t, this.seed % 97) * 0.05;
    out.y += fbm1D(t + 31, this.seed % 89) * 0.03;
    out.z += fbm1D(t + 77, this.seed % 83) * 0.05;
    return out;
  }

  private expressionPose(): { morphs: MorphWeights; headPitch: number; headRoll: number; slump: number; gazeUp: number } {
    const morphs = zeroMorphs();
    let headPitch = 0;
    let headRoll = 0;
    let slump = 0;
    let gazeUp = 0;
    if (this.expression) {
      for (const [name, w] of Object.entries(this.expression) as [Expression, number][]) {
        if (w <= 0) continue;
        const p = EXPRESSION_PRESETS[name];
        for (const [m, v] of Object.entries(p.morphs) as [MorphName, number][]) morphs[m] += v * w;
        headPitch += (p.headPitch ?? 0) * w;
        headRoll += (p.headRoll ?? 0) * w;
        slump += (p.slump ?? 0) * w;
        gazeUp += (p.gazeUp ?? 0) * w;
      }
    }
    return { morphs, headPitch, headRoll, slump, gazeUp };
  }

  private gestureEnvelope(): number {
    if (!this.gesture) return 0;
    const p = this.gesture.progress;
    return smoothstep(0, 0.18, p) * (1 - smoothstep(0.82, 1, p));
  }

  /** Yaw/pitch (rad) do alvo no espaço local do corpo, a partir de um ponto de referência. */
  private localAngles(from: THREE.Vector3, target: THREE.Vector3): { yaw: number; pitch: number } {
    this.root.updateMatrixWorld();
    const inv = _m.copy(this.root.matrixWorld).invert();
    const a = _v2.copy(target).applyMatrix4(inv);
    const b = from.clone().applyMatrix4(inv);
    a.sub(b);
    const yaw = Math.atan2(a.x, a.z);
    const pitch = -Math.atan2(a.y, Math.hypot(a.x, a.z));
    return { yaw, pitch };
  }

  private updateProceduralBody(rig: ProceduralRig, dt: number): void {
    const t = this.clock;
    const expr = this.expressionPose();
    const env = this.gestureEnvelope();
    const g = this.gesture;
    const gp = g?.progress ?? 0;

    // ---- Respiração: senoide lenta transladando/rotacionando o peito ----
    const breath = Math.sin((t * Math.PI * 2) / this.breathPeriod);
    rig.chest.position.y = rig.chestBaseY + breath * 0.006;
    rig.chest.rotation.set(breath * -0.012 + expr.slump * 0.12, 0, 0);
    rig.hips.rotation.set(0, 0, 0);
    rig.chest.scale.set(1 + breath * 0.012, 1, 1 + breath * 0.018);

    // ---- Balanço idle / transferência de peso ----
    const sway = fbm1D(t * 0.25, this.seed % 53);
    rig.body.rotation.z = sway * 0.02;
    rig.hips.position.x = sway * 0.015;

    // ---- Caminhada ----
    const w = this.walkAmount;
    const ph = this.walkPhase;
    rig.hips.position.y = 0.92 + Math.abs(Math.sin(ph)) * 0.035 * w - 0.015 * w;
    // Rotações sempre definidas por completo: a camada de pose/IK do quadro anterior não "vaza".
    rig.legL.upper.rotation.set(Math.sin(ph) * 0.6 * w, 0, 0);
    rig.legR.upper.rotation.set(-Math.sin(ph) * 0.6 * w, 0, 0);
    rig.legL.lower.rotation.set(Math.max(0, Math.sin(ph + Math.PI * 0.5)) * 0.9 * w, 0, 0);
    rig.legR.lower.rotation.set(Math.max(0, Math.sin(ph - Math.PI * 0.5)) * 0.9 * w, 0, 0);

    // ---- Braços: repouso + caminhada + fala + gestos ----
    const talk = this.talkAmount;
    const talkL = fbm1D(t * 1.3, (this.seed % 41) + 1) * talk;
    const talkR = fbm1D(t * 1.3, (this.seed % 37) + 9) * talk;

    let lShX = -Math.sin(ph) * 0.45 * w + talkL * 0.25 - talk * 0.15;
    let lShZ = 0.1 + breath * 0.01 + expr.slump * -0.04;
    let lEl = -0.15 - talk * 0.5 + talkL * 0.3 - w * 0.25;
    let rShX = Math.sin(ph) * 0.45 * w + talkR * 0.25 - talk * 0.15;
    let rShZ = -0.1 - breath * 0.01 + expr.slump * 0.04;
    let rEl = -0.15 - talk * 0.5 + talkR * 0.3 - w * 0.25;
    let shoulderLift = expr.slump * -0.015;
    let headPitchG = 0;
    let headYawG = 0;
    let spineBow = 0;

    if (g) {
      switch (g.name) {
        case 'wave':
          rShZ = lerp(rShZ, -2.55, env);
          rShX = lerp(rShX, -0.2, env);
          rEl = lerp(rEl, Math.sin(gp * Math.PI * 9) * 0.45, env);
          break;
        case 'point':
          rShX = lerp(rShX, -1.45, env);
          rShZ = lerp(rShZ, -0.12, env);
          rEl = lerp(rEl, -0.05, env);
          break;
        case 'shrug':
          shoulderLift += 0.045 * env;
          lShZ = lerp(lShZ, 0.35, env);
          rShZ = lerp(rShZ, -0.35, env);
          lEl = lerp(lEl, -1.3, env);
          rEl = lerp(rEl, -1.3, env);
          headPitchG = -0.04 * env;
          break;
        case 'nod':
          headPitchG = Math.sin(gp * Math.PI * 4) * 0.22 * env;
          break;
        case 'headShake':
          headYawG = Math.sin(gp * Math.PI * 6) * 0.35 * env;
          break;
        case 'bow': {
          const bell = Math.sin(Math.PI * gp);
          spineBow = 0.65 * bell;
          headPitchG = 0.2 * bell;
          lShX = lerp(lShX, 0.25, bell);
          rShX = lerp(rShX, 0.25, bell);
          break;
        }
      }
    }

    rig.armL.upper.rotation.set(lShX, 0, lShZ);
    rig.armR.upper.rotation.set(rShX, 0, rShZ);
    rig.armL.lower.rotation.set(lEl, 0, 0);
    rig.armR.lower.rotation.set(g?.name === 'wave' ? -0.3 * env + rEl * (1 - env) : rEl, 0, g?.name === 'wave' ? rEl * env : 0);
    rig.armL.upper.position.y = 0.47 + shoulderLift + breath * 0.004;
    rig.armR.upper.position.y = 0.47 + shoulderLift + breath * 0.004;
    rig.chest.rotation.x += spineBow;
    if (rig.cape) rig.cape.rotation.set(0.1 + w * 0.55 + fbm1D(t * 0.9, (this.seed % 19) + 2) * 0.06 - expr.slump * 0.05, 0, 0);

    // ---- Cabeça: LookAt amortecido com ruído + gestos + fala ----
    let targetYaw = fbm1D(t * 0.15, (this.seed % 29) + 3) * 0.15;
    let targetPitch = fbm1D(t * 0.12, (this.seed % 31) + 5) * 0.05 - expr.gazeUp * 0.08;
    const look = this.noisyLookTarget(_v);
    if (look) {
      // Origem na altura dos olhos (pivô da cabeça + meia cabeça), independente da rotação atual.
      rig.head.updateMatrixWorld();
      const from = rig.head.getWorldPosition(new THREE.Vector3());
      from.y += 0.24 * this.bodyScale;
      const a = this.localAngles(from, look);
      targetYaw = clamp(a.yaw, -1.2, 1.2);
      targetPitch = clamp(a.pitch, -0.6, 0.6);
    }
    this.headYaw = damp(this.headYaw, targetYaw, 5, dt);
    this.headPitch = damp(this.headPitch, targetPitch, 5, dt);

    const talkNod = Math.sin(t * 7.3) * 0.04 * talk;
    const pitch = this.headPitch + expr.headPitch + headPitchG + talkNod - spineBow * 0.5;
    const yaw = this.headYaw + headYawG;
    rig.neck.rotation.set(pitch * 0.4, yaw * 0.4, expr.headRoll * 0.4, 'YXZ');
    rig.head.rotation.set(pitch * 0.6, yaw * 0.6, expr.headRoll * 0.6 + sway * 0.03, 'YXZ');

    // ---- Olhos: pupilas seguem o alvo (com sacadas) ----
    let gx = fbm1D(t * 0.4, (this.seed % 23) + 11) * 0.3;
    let gy = expr.gazeUp * 0.6;
    if (look) {
      // Ângulo residual não coberto pela cabeça.
      rig.head.updateMatrixWorld();
      const eyePos = rig.headCenter.getWorldPosition(new THREE.Vector3());
      const inv = _m.copy(rig.head.matrixWorld).invert();
      const dir = look.clone().applyMatrix4(inv).sub(eyePos.applyMatrix4(inv));
      gx = clamp(Math.atan2(dir.x, dir.z) * 1.6, -1, 1);
      gy = clamp(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) * 1.6, -1, 1);
    }
    // Sacadas são rápidas (lambda alto) — micro-saltos visíveis nas pupilas.
    this.gazeLocal.x = damp(this.gazeLocal.x, gx, 35, dt);
    this.gazeLocal.y = damp(this.gazeLocal.y, gy, 35, dt);
    for (const p of rig.pupils) p.position.set(this.gazeLocal.x * 0.02, this.gazeLocal.y * 0.017, 0.001);

    const wide = expr.morphs.eyeWide;
    for (const e of rig.eyes) e.scale.setScalar(1 + wide * 0.18);
  }

  private updateGltfBody(rig: GltfRig, dt: number): void {
    // Ossos voltam ao repouso antes do mixer: camadas aditivas não acumulam entre quadros.
    for (const [bone, q] of rig.rest) bone.quaternion.copy(q);
    rig.body.position.y = 0;
    this.updateMixer(rig, dt);
    const t = this.clock;
    const expr = this.expressionPose();
    const breath = Math.sin((t * Math.PI * 2) / this.breathPeriod);

    if (rig.spineBone) {
      _q.setFromEuler(_e.set(breath * -0.015 + expr.slump * 0.1, 0, 0));
      rig.spineBone.quaternion.multiply(_q);
      rig.spineBone.position.y += breath * 0.002;
    }

    let targetYaw = fbm1D(t * 0.15, (this.seed % 29) + 3) * 0.15;
    let targetPitch = fbm1D(t * 0.12, (this.seed % 31) + 5) * 0.05;
    const look = this.noisyLookTarget(_v);
    if (look) {
      const from = this.getHeadWorldPosition(new THREE.Vector3());
      const a = this.localAngles(from, look);
      targetYaw = clamp(a.yaw, -1.1, 1.1);
      targetPitch = clamp(a.pitch, -0.5, 0.5);
    }
    this.headYaw = damp(this.headYaw, targetYaw, 5, dt);
    this.headPitch = damp(this.headPitch, targetPitch, 5, dt);

    const g = this.gesture;
    const env = this.gestureEnvelope();
    let gPitch = 0;
    let gYaw = 0;
    if (g?.name === 'nod') gPitch = Math.sin(g.progress * Math.PI * 4) * 0.22 * env;
    if (g?.name === 'headShake') gYaw = Math.sin(g.progress * Math.PI * 6) * 0.35 * env;
    const talkNod = Math.sin(t * 7.3) * 0.04 * this.talkAmount;

    const pitch = this.headPitch + expr.headPitch + gPitch + talkNod;
    const yaw = this.headYaw + gYaw;
    if (rig.neckBone) rig.neckBone.quaternion.multiply(_q.setFromEuler(_e.set(pitch * 0.4, yaw * 0.4, expr.headRoll * 0.4, 'YXZ')));
    if (rig.headBone) {
      const k = rig.neckBone ? 0.6 : 1;
      rig.headBone.quaternion.multiply(_q.setFromEuler(_e.set(pitch * k, yaw * k, expr.headRoll * k, 'YXZ')));
    }
  }

  /** Clipes GLTF amostrados deterministicamente pelo tempo da timeline (seek-safe). */
  private updateMixer(rig: GltfRig, dt: number): void {
    const clipState = this.clip;
    const action = (name: string): THREE.AnimationAction | null => {
      let a = this.actions.get(name);
      if (!a) {
        const clip = THREE.AnimationClip.findByName(rig.clips, name);
        if (!clip) return null;
        a = rig.mixer.clipAction(clip);
        this.actions.set(name, a);
      }
      return a;
    };
    const place = (a: THREE.AnimationAction, startAt: number, loop: boolean, weight: number) => {
      const d = a.getClip().duration;
      let local = Math.max(0, this.timelineTime - startAt);
      local = loop ? local % d : Math.min(local, d - 1e-4);
      a.enabled = true;
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = true;
      a.paused = true; // tempo controlado manualmente
      a.time = local;
      a.setEffectiveWeight(weight);
      if (!a.isRunning()) a.play();
    };

    for (const a of this.actions.values()) a.setEffectiveWeight(0);
    if (clipState) {
      const cur = action(clipState.name);
      const w = clipState.fade > 0 ? clamp01((this.timelineTime - clipState.startAt) / clipState.fade) : 1;
      if (cur) place(cur, clipState.startAt, clipState.loop, w);
      if (clipState.prev && w < 1) {
        const prev = action(clipState.prev.name);
        if (prev) place(prev, clipState.prev.startAt, clipState.prev.loop, 1 - w);
      }
      if (this.idleAction) this.idleAction.setEffectiveWeight(cur ? 0 : 1);
    } else if (this.idleAction) {
      this.idleAction.setEffectiveWeight(1);
    }
    if (this.idleAction) this.idleAction.paused = false;
    rig.mixer.update(dt);
  }

  /** Camadas de pose: SET_POSE e gestos customizados (keyframes), sobre a animação procedural. */
  private applyPoseLayers(): void {
    const rig = this.rig;
    const custom = this.gesture ? this.gestureLibrary[this.gesture.name] : undefined;
    const g = custom && this.gesture ? sampleGesture(custom, this.gesture.progress) : null;

    for (const j of JOINTS) {
      const obj = rig.joints[j];
      if (!obj) continue;
      const pj = this.pose.joints[j];
      if (pj.w > 0.001) this.applyJoint(obj, j, pj.rot, pj.w);
      const gr = g?.joints[j];
      if (g && gr && g.weight > 0.001) this.applyJoint(obj, j, gr, g.weight);
    }

    const crouch = this.pose.crouch + (g ? g.crouch * g.weight : 0);
    if (rig.kind === 'procedural') rig.hips.position.y -= crouch / this.bodyScale;
    else rig.body.position.y = -crouch;
  }

  private applyJoint(obj: THREE.Object3D, joint: Joint, rotDeg: readonly number[], w: number): void {
    const x = rotDeg[0] * DEG2RAD;
    const y = rotDeg[1] * DEG2RAD;
    const z = rotDeg[2] * DEG2RAD;
    if (this.rig.kind === 'gltf' || ADDITIVE_JOINTS.has(joint)) {
      obj.quaternion.multiply(_q.setFromEuler(_e.set(x * w, y * w, z * w)));
    } else {
      obj.rotation.x = lerp(obj.rotation.x, x, w);
      obj.rotation.y = lerp(obj.rotation.y, y, w);
      obj.rotation.z = lerp(obj.rotation.z, z, w);
    }
  }

  /** Alcance: IK de dois ossos em cada braço com alvo ativo. */
  private applyReachIK(): void {
    let dirty = true;
    for (const hand of ['left', 'right'] as const) {
      const r = this.reach[hand];
      const chain = this.rig.arms[hand];
      if (!chain || r.weight < 0.001) continue;
      if (dirty) {
        this.root.updateMatrixWorld(true);
        dirty = false;
      }
      const target = _v.copy(r.point);
      if (r.shake > 0) target.y += Math.sin(this.clock * Math.PI * 2 * 3.2) * 0.035 * r.shake;
      // Cotovelo aponta para baixo, para trás e para fora.
      const side = hand === 'left' ? 1 : -1;
      const pole = chain.upper.getWorldPosition(_v2).add(_pole.set(side * 0.35, -0.45, -0.6).applyQuaternion(this.root.quaternion));
      solveTwoBoneIK(chain, target, pole, r.weight);
    }
  }

  private updateFace(): void {
    const expr = this.expressionPose();
    const m = expr.morphs;
    const lip = this.lipsync;
    const blink = this.blinkValue();

    // Volume (RMS) -> jawOpen. Distribuição espectral -> boca larga / arredondada.
    this.morphs.set('jawOpen', Math.max(m.jawOpen, lip.jawOpen * 0.9 + m.jawOpen * 0.3));
    this.morphs.set('mouthWide', m.mouthWide + lip.mouthWide * 0.8);
    this.morphs.set('mouthPucker', m.mouthPucker * (1 - lip.jawOpen) + lip.mouthPucker * 0.8);
    this.morphs.set('mouthSmile', m.mouthSmile);
    this.morphs.set('mouthFrown', m.mouthFrown);
    this.morphs.set('eyeBlink', blink);
    this.morphs.set('eyeSquint', m.eyeSquint * (1 - blink));
    this.morphs.set('eyeWide', m.eyeWide * (1 - blink));
    this.morphs.set('browInnerUp', m.browInnerUp + lip.energy * 0.15);
    this.morphs.set('browDown', m.browDown);
    this.morphs.set('browOuterUp', m.browOuterUp);
  }
}

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PROCEDURAL_RIG, type ActorObjectDef, type Hand, type Joint, type Socket } from '../timeline/types';
import { addAccessories, addHair, addOutfit, buildProportions, createHeadGeometry } from './CharacterStyle';
import { applyStyleShader } from '../systems/PostProcessing';
import { createMouthGeometry, createEyelidGeometry, createBrowGeometry } from './ActorFace';
import type { AssetLoader } from './AssetLoader';

/* ========================================================================== */
/*  Rig procedural                                                            */
/* ========================================================================== */

interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
}

/** Cadeia de dois ossos para IK (ombro -> cotovelo -> mão). */
export interface ArmChain {
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

/** Rosto-tela (headShape 'screen'): olhos/boca desenhados num canvas emissivo, sem morphs. */
export interface ScreenFaceRig {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
}

export interface ProceduralRig extends RigCommon {
  kind: 'procedural';
  hips: THREE.Group;
  chest: THREE.Group;
  neck: THREE.Group;
  head: THREE.Group;
  eyes: THREE.Group[];
  pupils: THREE.Object3D[];
  /** Só quando headShape = 'screen'. */
  screenFace: ScreenFaceRig | null;
  armL: Limb;
  armR: Limb;
  legL: Limb;
  legR: Limb;
  chestBaseY: number;
  /** Pivô da capa (acessório), animado pela caminhada. */
  cape: THREE.Object3D | null;
}

export interface GltfRig extends RigCommon {
  kind: 'gltf';
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  headBone: THREE.Object3D | null;
  neckBone: THREE.Object3D | null;
  spineBone: THREE.Object3D | null;
  /** Rotação de repouso dos ossos manipulados (reaplicada a cada quadro antes do mixer). */
  rest: Map<THREE.Object3D, THREE.Quaternion>;
}

export type Rig = ProceduralRig | GltfRig;

export const BASE_HEIGHT = PROCEDURAL_RIG.baseHeight;

/** Articulações aplicadas de forma aditiva (preservam olhar/respiração); as demais sobrescrevem. */
export const ADDITIVE_JOINTS = new Set<Joint>(['hips', 'chest', 'neck', 'head']);

function socket(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = `socket:${name}`;
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

function lambert(color: THREE.ColorRepresentation): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
  applyStyleShader(m);
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
  applyStyleShader(m);
  return m;
}

/** Visor emissivo no lugar de olhos/boca procedurais; Actor redesenha o canvas a cada quadro. */
function buildScreenFace(face: THREE.Object3D, faceZ: (x: number, y: number, hw: number, hh: number) => number): ScreenFaceRig {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 112;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const visor = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.26),
    // `toneMapped: false` mantém o brilho do visor independente da luz da cena.
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  visor.position.set(0, 0.015, faceZ(0, 0.015, 0.15, 0.13) + 0.002);
  visor.name = 'screenFace';
  face.add(visor);
  return { canvas, ctx, texture };
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

export function buildProceduralRig(def: ActorObjectDef, assets?: AssetLoader): ProceduralRig {
  const p = def.palette ?? {};
  const skin = new THREE.Color(p.skin ?? '#e0ac69');
  const mSkin = lambert(skin);
  const mHair = lambert(p.hair ?? '#3b2a1a');
  const mShirt = lambert(p.shirt ?? '#3f6fb5');
  const outfitTexture = assets?.getTexture(p.outfitTexture);
  if (outfitTexture) {
    outfitTexture.wrapS = outfitTexture.wrapT = THREE.RepeatWrapping;
    outfitTexture.needsUpdate = true;
    mShirt.map = outfitTexture;
    mShirt.color.set('#ffffff');
  }
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
  let screenFace: ScreenFaceRig | null = null;

  if (def.headShape === 'screen') {
    screenFace = buildScreenFace(face, faceZ);
  } else {
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

    // Rosto pintado (opcional): atrás dos olhos/boca procedurais, que continuam na frente e animando.
    const faceTexture = assets?.getTexture(p.faceTexture);
    if (faceTexture) {
      const paint = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.32),
        new THREE.MeshLambertMaterial({ map: faceTexture, transparent: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      );
      paint.position.set(0, -0.01, faceZ(0, -0.01, 0.17, 0.16) + 0.001);
      paint.name = 'facePaint';
      face.add(paint);
    }
  }

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
    screenFace,
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

export function buildGltfRig(gltf: GLTF): GltfRig {
  const body = new THREE.Group();
  body.name = 'body';
  const model = cloneSkinned(gltf.scene);
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => applyStyleShader(m));
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

import * as THREE from 'three';
import type { Accessory, BodyBuild, HairStyle, HeadShape, Outfit } from '../timeline/types';

/**
 * Peças de visual do personagem procedural: proporções por tipo de corpo,
 * estilos de cabelo, roupas e acessórios. Tudo em unidades do modelo
 * (altura base 1.95), na mesma convenção do rig de Actor.ts (frente = +Z).
 */

export interface BuildProportions {
  /** Raio do tronco no topo / na base e profundidade relativa. */
  chestTop: number;
  chestBottom: number;
  depth: number;
  /** Escala da largura do quadril e afastamento das pernas. */
  hipWidth: number;
  /** Afastamento dos ombros. */
  shoulders: number;
  /** Espessura dos membros. */
  limb: number;
}

const BUILDS: Record<BodyBuild, BuildProportions> = {
  slim: { chestTop: 0.18, chestBottom: 0.15, depth: 0.9, hipWidth: 0.88, shoulders: 0.9, limb: 0.82 },
  average: { chestTop: 0.21, chestBottom: 0.17, depth: 1, hipWidth: 1, shoulders: 1, limb: 1 },
  athletic: { chestTop: 0.25, chestBottom: 0.17, depth: 1.05, hipWidth: 1, shoulders: 1.14, limb: 1.18 },
  heavy: { chestTop: 0.25, chestBottom: 0.27, depth: 1.25, hipWidth: 1.25, shoulders: 1.12, limb: 1.22 },
};

export function buildProportions(build: BodyBuild | undefined): BuildProportions {
  return BUILDS[build ?? 'average'] ?? BUILDS.average;
}

/** Cabeça de referência (caixa 0.40 × 0.42 × 0.38): cabelo e chapéus são modelados sobre ela. */
const REF_HALF_WIDTH = 0.2;
const REF_HALF_HEIGHT = 0.21;
const REF_FRONT = 0.19;

export interface HeadGeometry {
  /** Malha centrada na origem (centro da cabeça). */
  geometry: THREE.BufferGeometry;
  top: number;
  bottom: number;
  /** Maior z da superfície dentro do retângulo (x ± hw, y ± hh), em coordenadas da cabeça. */
  surfaceZ(x: number, y: number, hw?: number, hh?: number): number;
  /** Encaixes para cabelo/chapéus (topo) e barba (queixo): a cabeça de referência ajustada a este formato. */
  crown: { y: number; scaleX: number; scaleZ: number };
  jaw: { y: number; scaleX: number; scaleZ: number };
}

/** Sólido de revolução com uma face plana voltada para +Z. Perfil: pares [raio, y] de baixo para cima. */
function lathe(profile: [number, number][], segments: number): THREE.BufferGeometry {
  const points = profile.map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(points, segments, Math.PI / segments);
}

function headGeometry(shape: HeadShape): THREE.BufferGeometry {
  switch (shape) {
    case 'box':
      return new THREE.BoxGeometry(0.4, 0.42, 0.38);
    case 'round':
      return new THREE.IcosahedronGeometry(0.24, 1);
    case 'egg':
      return lathe([[0, -0.24], [0.13, -0.21], [0.2, -0.12], [0.215, 0], [0.205, 0.12], [0.17, 0.24], [0.1, 0.33], [0, 0.36]], 8);
    case 'bulb':
      return lathe([[0, -0.21], [0.09, -0.19], [0.14, -0.1], [0.19, 0.02], [0.215, 0.12], [0.29, 0.22], [0.31, 0.32], [0.26, 0.42], [0.14, 0.49], [0, 0.51]], 9);
    case 'pear':
      return lathe([[0, -0.24], [0.19, -0.23], [0.26, -0.13], [0.245, 0], [0.19, 0.12], [0.13, 0.2], [0.06, 0.25], [0, 0.26]], 7);
    case 'cone':
      return lathe([[0, -0.22], [0.19, -0.2], [0.22, -0.05], [0.19, 0.12], [0.11, 0.32], [0.04, 0.5], [0, 0.56]], 6);
    case 'can':
      return new THREE.CylinderGeometry(0.2, 0.22, 0.48, 7, 1, false, Math.PI / 7);
    case 'wide':
      return new THREE.SphereGeometry(0.22, 8, 5).scale(1.5, 0.82, 1);
  }
}

export function createHeadGeometry(shape: HeadShape | undefined): HeadGeometry {
  const geometry = headGeometry(shape ?? 'box') ?? headGeometry('box');
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;

  // Sonda por raycast: funciona para qualquer formato sem conhecer a fórmula da superfície.
  const probe = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  probe.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const hitZ = (x: number, y: number) => {
    ray.set(origin.set(x, y, bbox.max.z + 1), dir.set(0, 0, -1));
    return ray.intersectObject(probe, false)[0]?.point.z ?? -Infinity;
  };
  const halfWidthAt = (y: number) => {
    ray.set(origin.set(bbox.max.x + 1, y, 0), dir.set(-1, 0, 0));
    return ray.intersectObject(probe, false)[0]?.point.x ?? REF_HALF_WIDTH;
  };
  const surfaceZ = (x: number, y: number, hw = 0, hh = 0) => {
    let z = -Infinity;
    for (const dx of [-hw, 0, hw]) for (const dy of [-hh, 0, hh]) z = Math.max(z, hitZ(x + dx, y + dy));
    return Number.isFinite(z) ? z : bbox.max.z;
  };
  const fit = (y: number) => {
    const front = surfaceZ(0, y);
    return {
      scaleX: THREE.MathUtils.clamp(halfWidthAt(y) / REF_HALF_WIDTH, 0.6, 1.6),
      scaleZ: THREE.MathUtils.clamp(front / REF_FRONT, 0.6, 1.6),
    };
  };

  return {
    geometry,
    top: bbox.max.y,
    bottom: bbox.min.y,
    surfaceZ,
    crown: { y: bbox.max.y - REF_HALF_HEIGHT, ...fit(bbox.max.y - 0.12) },
    jaw: { y: bbox.min.y + REF_HALF_HEIGHT, ...fit(bbox.min.y + 0.1) },
  };
}

export interface StyleContext {
  /** Cabeça de referência alinhada ao topo (cabelo, chapéus) e ao queixo (barba). */
  crown: THREE.Object3D;
  jaw: THREE.Object3D;
  face: THREE.Object3D;
  /** Deslocamento em z (relativo ao plano do rosto) para um traço cobrir a superfície em (x ± hw, y ± hh). */
  faceZ(x: number, y: number, hw: number, hh: number): number;
  neck: THREE.Object3D;
  chest: THREE.Object3D;
  hips: THREE.Object3D;
  /** Centro da cabeça acima do pivô e posição (z) da face frontal — da cabeça de referência (crown/jaw). */
  headCenter: number;
  front: number;
  proportions: BuildProportions;
  materials: {
    hair: THREE.Material;
    shirt: THREE.Material;
    accent: THREE.Material;
    /** Versão dupla-face do accent (capa). */
    accentDouble: THREE.Material;
    metal: THREE.Material;
    dark: THREE.Material;
  };
  part(geo: THREE.BufferGeometry, mat: THREE.Material, y?: number): THREE.Mesh;
  faceMaterial(color: THREE.ColorRepresentation, offset: number): THREE.Material;
}

function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T {
  o.position.set(x, y, z);
  return o;
}

/** Cabelo preso à cabeça. */
export function addHair(ctx: StyleContext, style: HairStyle | undefined): void {
  const { crown: head, part, headCenter: HC } = ctx;
  const m = ctx.materials.hair;
  const cap = () => head.add(part(new THREE.BoxGeometry(0.43, 0.11, 0.41), m, HC + 0.2));
  const backShort = () => head.add(at(part(new THREE.BoxGeometry(0.43, 0.3, 0.08), m), 0, HC + 0.06, -0.175));

  switch (style ?? 'short') {
    case 'bald':
      return;
    case 'short':
      cap();
      backShort();
      return;
    case 'long':
      cap();
      head.add(at(part(new THREE.BoxGeometry(0.44, 0.62, 0.08), m), 0, HC - 0.08, -0.18));
      for (const side of [1, -1]) head.add(at(part(new THREE.BoxGeometry(0.05, 0.5, 0.3), m), side * 0.215, HC - 0.02, -0.04));
      return;
    case 'ponytail': {
      cap();
      backShort();
      const tail = part(new THREE.BoxGeometry(0.1, 0.34, 0.1).translate(0, -0.17, 0), m);
      at(tail, 0, HC + 0.14, -0.23).rotation.x = 0.35;
      head.add(tail);
      return;
    }
    case 'bun':
      cap();
      backShort();
      head.add(at(part(new THREE.IcosahedronGeometry(0.1, 0), m), 0, HC + 0.29, -0.1));
      return;
    case 'spiky':
      backShort();
      head.add(part(new THREE.BoxGeometry(0.42, 0.06, 0.4), m, HC + 0.22));
      for (let i = 0; i < 7; i++) {
        const spike = part(new THREE.ConeGeometry(0.07, 0.2, 4), m);
        const x = ((i % 4) - 1.5) * 0.11;
        const z = i < 4 ? 0.06 : -0.08;
        at(spike, x + (i < 4 ? 0 : 0.055), HC + 0.31, z).rotation.set(z * 2, 0, -x * 1.6);
        head.add(spike);
      }
      return;
    case 'mohawk':
      head.add(part(new THREE.BoxGeometry(0.08, 0.16, 0.44), m, HC + 0.28));
      return;
  }
}

/** Roupa por cima das pernas (túnica / vestido). */
export function addOutfit(ctx: StyleContext, outfit: Outfit | undefined): void {
  if (!outfit || outfit === 'casual') return;
  const { hips, part, proportions: pr } = ctx;
  const length = outfit === 'robe' ? 0.86 : 0.5;
  const skirt = new THREE.CylinderGeometry(0.2 * pr.hipWidth, (outfit === 'robe' ? 0.34 : 0.3) * pr.hipWidth, length, 7);
  skirt.translate(0, 0.06 - length / 2, 0);
  skirt.scale(1, 1, pr.depth);
  hips.add(part(skirt, ctx.materials.shirt));
}

/** Acessórios. Retorna a capa (se houver) para ser animada. */
export function addAccessories(ctx: StyleContext, accessories: Accessory[] | undefined): { cape: THREE.Object3D | null } {
  const { crown: head, jaw, face, neck, chest, part, headCenter: HC, front: FRONT, proportions: pr } = ctx;
  const { accent, metal, dark } = ctx.materials;
  let cape: THREE.Object3D | null = null;

  for (const acc of new Set(accessories ?? [])) {
    switch (acc) {
      case 'hat':
        head.add(part(new THREE.CylinderGeometry(0.34, 0.34, 0.03, 10), accent, HC + 0.25));
        head.add(part(new THREE.CylinderGeometry(0.2, 0.22, 0.2, 10), accent, HC + 0.36));
        break;
      case 'wizardHat': {
        head.add(part(new THREE.CylinderGeometry(0.36, 0.36, 0.03, 10), accent, HC + 0.25));
        const cone = part(new THREE.ConeGeometry(0.22, 0.55, 8).translate(0, 0.275, 0), accent, HC + 0.26);
        cone.rotation.x = -0.18;
        head.add(cone);
        break;
      }
      case 'cap': {
        head.add(part(new THREE.BoxGeometry(0.44, 0.12, 0.42), accent, HC + 0.24));
        head.add(at(part(new THREE.BoxGeometry(0.4, 0.025, 0.18), accent), 0, HC + 0.19, FRONT + 0.08));
        break;
      }
      case 'crown':
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const tooth = part(new THREE.BoxGeometry(0.08, i % 2 ? 0.08 : 0.13, 0.03), metal);
          tooth.position.set(Math.sin(a) * 0.2, HC + 0.3, Math.cos(a) * 0.19);
          tooth.rotation.y = a;
          head.add(tooth);
        }
        break;
      case 'glasses': {
        const mat = ctx.faceMaterial('#1a1a1a', 4);
        for (const side of [1, -1]) {
          const frame = new THREE.Mesh(new THREE.RingGeometry(0.052, 0.064, 8), mat);
          frame.position.set(side * 0.088, 0.035, ctx.faceZ(side * 0.088, 0.035, 0.065, 0.07) + 0.008);
          face.add(frame);
        }
        const bridge = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.012), mat);
        bridge.position.set(0, 0.045, ctx.faceZ(0, 0.045, 0.025, 0.006) + 0.008);
        face.add(bridge);
        break;
      }
      case 'beard':
        // Abaixo da boca (que vai até ~HC-0.15 aberta) + queixo e costeletas.
        jaw.add(at(part(new THREE.BoxGeometry(0.36, 0.08, 0.08), ctx.materials.hair), 0, HC - 0.2, FRONT - 0.01));
        jaw.add(at(part(new THREE.BoxGeometry(0.22, 0.09, 0.07), ctx.materials.hair), 0, HC - 0.27, FRONT - 0.03));
        for (const side of [1, -1]) jaw.add(at(part(new THREE.BoxGeometry(0.05, 0.2, 0.12), ctx.materials.hair), side * 0.19, HC - 0.1, FRONT - 0.06));
        break;
      case 'mustache': {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.03), ctx.faceMaterial((ctx.materials.hair as THREE.MeshLambertMaterial).color, 4));
        m.position.set(0, -0.07, ctx.faceZ(0, -0.07, 0.08, 0.015) + 0.007);
        face.add(m);
        break;
      }
      case 'scarf': {
        const ring = part(new THREE.TorusGeometry(0.1, 0.045, 5, 8), accent);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.04;
        neck.add(ring);
        const tail = part(new THREE.BoxGeometry(0.07, 0.24, 0.03).translate(0, -0.12, 0), accent);
        tail.position.set(0.07, 0.03, 0.12);
        tail.rotation.z = 0.15;
        neck.add(tail);
        break;
      }
      case 'backpack':
        chest.add(at(part(new THREE.BoxGeometry(0.32 * pr.shoulders, 0.36, 0.16), accent), 0, 0.27, -0.2 * pr.depth - 0.06));
        chest.add(at(part(new THREE.BoxGeometry(0.26 * pr.shoulders, 0.04, 0.17), dark), 0, 0.44, -0.2 * pr.depth - 0.06));
        break;
      case 'cape': {
        const mat = ctx.materials.accentDouble;
        const pivot = new THREE.Group();
        pivot.position.set(0, 0.5, -0.19 * pr.depth);
        const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.56 * pr.shoulders, 1.1, 1, 3).translate(0, -0.55, 0), mat);
        cloth.castShadow = true;
        pivot.add(cloth);
        chest.add(pivot);
        cape = pivot;
        break;
      }
    }
  }
  return { cape };
}

import * as THREE from 'three';
import type { PropType, RoomDef, WallOpening, WallSide } from '../timeline/types';
import { applyStyleShader } from '../systems/PostProcessing';
import { clamp01, hashString, lerp, seededRandom, smoothstep } from '../utils/math';

/**
 * Ambiente: ciclo dia/noite (céu, névoa, sol/lua, estrelas), cômodos internos
 * e mobília procedural. Tudo low-poly com texturas "pixel art" sem filtragem.
 */

function lambert(color: THREE.ColorRepresentation, map?: THREE.Texture, side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true, map: map ?? null, side });
  applyStyleShader(m);
  return m;
}

export function pixelTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/* ========================================================================== */
/*  Ciclo dia/noite                                                            */
/* ========================================================================== */

interface SkyKey {
  h: number;
  top: string;
  bottom: string;
  sun: string;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  stars: number;
}

/** Paleta por hora (interpolada). */
const SKY_KEYS: SkyKey[] = [
  { h: 0, top: '#03050f', bottom: '#111a33', sun: '#8fa6ff', sunI: 0.5, hemiSky: '#5a6aa8', hemiGround: '#14100c', hemiI: 0.6, stars: 1 },
  { h: 4.8, top: '#070b1f', bottom: '#1d2546', sun: '#8fa6ff', sunI: 0.4, hemiSky: '#5f6fae', hemiGround: '#161210', hemiI: 0.65, stars: 0.9 },
  { h: 6, top: '#2b3a6e', bottom: '#f08a5d', sun: '#ffb070', sunI: 0.9, hemiSky: '#9aa6d8', hemiGround: '#3a2a20', hemiI: 0.8, stars: 0.15 },
  { h: 7.5, top: '#4f86c9', bottom: '#f6c99a', sun: '#ffe2b8', sunI: 1.8, hemiSky: '#bcd0ff', hemiGround: '#4a3a2a', hemiI: 1.0, stars: 0 },
  { h: 12, top: '#3f7fd6', bottom: '#b9dcff', sun: '#fff6e8', sunI: 2.6, hemiSky: '#d6e6ff', hemiGround: '#5a4a3a', hemiI: 1.2, stars: 0 },
  { h: 16.5, top: '#4a80c8', bottom: '#d9e4f0', sun: '#ffe7c4', sunI: 2.2, hemiSky: '#cddcff', hemiGround: '#54443a', hemiI: 1.1, stars: 0 },
  { h: 18.3, top: '#3b4f8f', bottom: '#ff9a5c', sun: '#ff8a4a', sunI: 1.2, hemiSky: '#a59ad0', hemiGround: '#3e2a22', hemiI: 0.85, stars: 0.1 },
  { h: 19.6, top: '#141c40', bottom: '#5a3a6a', sun: '#9a8acc', sunI: 0.55, hemiSky: '#6a6aa8', hemiGround: '#1c1612', hemiI: 0.7, stars: 0.6 },
  { h: 24, top: '#03050f', bottom: '#111a33', sun: '#8fa6ff', sunI: 0.5, hemiSky: '#5a6aa8', hemiGround: '#14100c', hemiI: 0.6, stars: 1 },
];

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

export interface DayNightState {
  top: THREE.Color;
  bottom: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** Direção da luz principal (sol de dia, lua à noite), apontando DO astro para a origem. */
  sunPosition: THREE.Vector3;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  stars: number;
}

/** Estado do céu numa hora (0–24, valores maiores são reduzidos módulo 24). */
export function skyAt(hourRaw: number): DayNightState {
  const h = ((hourRaw % 24) + 24) % 24;
  let i = 0;
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1].h <= h) i++;
  const a = SKY_KEYS[i];
  const b = SKY_KEYS[i + 1];
  const t = smoothstep(0, 1, clamp01((h - a.h) / (b.h - a.h)));
  const mix = (x: string, y: string) => new THREE.Color(x).lerp(_c2.set(y), t);

  // Sol nasce a leste (+X) às 6h, a pino às 12h, põe-se a oeste às 18h. À noite, a lua faz o arco.
  const day = h >= 6 && h <= 18;
  const phase = day ? (h - 6) / 12 : ((h + 6) % 24) / 12; // 0..1 ao longo do arco
  const angle = phase * Math.PI;
  const elevation = Math.max(0.12, Math.sin(angle));
  const sunPosition = new THREE.Vector3(Math.cos(angle) * 30, elevation * 30, -12);

  return {
    top: mix(a.top, b.top),
    bottom: mix(a.bottom, b.bottom),
    sunColor: mix(a.sun, b.sun),
    sunIntensity: lerp(a.sunI, b.sunI, t),
    sunPosition,
    hemiSky: mix(a.hemiSky, b.hemiSky),
    hemiGround: mix(a.hemiGround, b.hemiGround),
    hemiIntensity: lerp(a.hemiI, b.hemiI, t),
    stars: lerp(a.stars, b.stars, t),
  };
}

/**
 * Céu dinâmico: domo com gradiente por vértice, estrelas, sol/lua direcional
 * com sombra e luz hemisférica. A névoa/fundo acompanham a cor do horizonte.
 */
export class DayNightCycle {
  readonly group = new THREE.Group();
  private readonly dome: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly sun = new THREE.DirectionalLight('#ffffff', 1);
  private readonly hemi = new THREE.HemisphereLight('#ffffff', '#333333', 1);
  private readonly heights: Float32Array;
  private lastHour = Number.NaN;

  constructor(private readonly scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(180, 16, 10);
    const pos = geo.getAttribute('position');
    this.heights = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) this.heights[i] = THREE.MathUtils.clamp(pos.getY(i) / 180, -1, 1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3));
    this.dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.dome.renderOrder = -2;
    this.dome.name = 'sky';

    const rand = seededRandom(1234);
    const starPos: number[] = [];
    for (let i = 0; i < 260; i++) {
      const theta = rand() * Math.PI * 2;
      const y = 0.15 + rand() * 0.85;
      const r = Math.sqrt(1 - y * y);
      starPos.push(Math.cos(theta) * r * 170, y * 170, Math.sin(theta) * r * 170);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }),
    );
    this.stars.renderOrder = -1;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -16;
    cam.right = cam.top = 16;
    cam.near = 1;
    cam.far = 90;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.sun.name = 'light:__sun';
    this.hemi.name = 'light:__sky';

    this.group.add(this.dome, this.stars, this.sun, this.sun.target, this.hemi);
  }

  apply(hour: number): void {
    if (Math.abs(hour - this.lastHour) < 1e-4) return;
    this.lastHour = hour;
    const s = skyAt(hour);

    const colors = this.dome.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < this.heights.length; i++) {
      _c1.copy(s.bottom).lerp(s.top, Math.pow(Math.max(0, this.heights[i]), 0.55));
      colors.setXYZ(i, _c1.r, _c1.g, _c1.b);
    }
    colors.needsUpdate = true;
    this.stars.material.opacity = s.stars;
    this.stars.visible = s.stars > 0.01;

    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.sun.position.copy(s.sunPosition);
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;

    // Horizonte invisível: névoa e fundo com a cor da base do céu.
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(s.bottom);
    else this.scene.background = s.bottom.clone();
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(s.bottom);
  }
}

/* ========================================================================== */
/*  Cômodos                                                                   */
/* ========================================================================== */

interface Opening {
  center: number;
  width: number;
  bottom: number;
  top: number;
  door: boolean;
}

function floorTexture(kind: RoomDef['floor'], color: string): THREE.CanvasTexture {
  return pixelTexture(64, (ctx, s) => {
    const base = new THREE.Color(color);
    const shade = (k: number) => `#${base.clone().multiplyScalar(k).getHexString()}`;
    const rand = seededRandom(hashString(color + (kind ?? 'wood')));
    ctx.fillStyle = shade(1);
    ctx.fillRect(0, 0, s, s);
    if ((kind ?? 'wood') === 'wood') {
      for (let y = 0; y < s; y += 8) {
        ctx.fillStyle = shade(0.82 + rand() * 0.22);
        ctx.fillRect(0, y, s, 8);
        ctx.fillStyle = shade(0.6);
        ctx.fillRect(0, y, s, 1);
        ctx.fillRect(Math.floor(rand() * s), y, 1, 8);
      }
    } else if (kind === 'tiles') {
      for (let y = 0; y < s; y += 16)
        for (let x = 0; x < s; x += 16) {
          ctx.fillStyle = shade((x + y) % 32 === 0 ? 1 : 0.8);
          ctx.fillRect(x, y, 16, 16);
          ctx.fillStyle = shade(0.55);
          ctx.fillRect(x, y, 16, 1);
          ctx.fillRect(x, y, 1, 16);
        }
    } else {
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = shade(0.75 + rand() * 0.3);
        ctx.fillRect(Math.floor(rand() * 4) * 16, Math.floor(rand() * 4) * 16, 16, 16);
      }
      ctx.fillStyle = shade(0.5);
      for (let i = 0; i <= s; i += 16) {
        ctx.fillRect(0, i, s, 1);
        ctx.fillRect(i, 0, 1, s);
      }
    }
  });
}

function wallTexture(color: string): THREE.CanvasTexture {
  return pixelTexture(32, (ctx, s) => {
    const base = new THREE.Color(color);
    const rand = seededRandom(hashString(color));
    ctx.fillStyle = `#${base.getHexString()}`;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = `#${base.clone().multiplyScalar(0.88 + rand() * 0.2).getHexString()}`;
      ctx.fillRect(Math.floor(rand() * 16) * 2, Math.floor(rand() * 16) * 2, 2, 2);
    }
  });
}

/** Constrói um cômodo: piso, paredes (visíveis só por dentro), teto opcional, portas e janelas. */
export function buildRoom(def: RoomDef): THREE.Group {
  const group = new THREE.Group();
  group.name = 'room';
  const W = Math.max(1, def.width);
  const D = Math.max(1, def.depth);
  const H = def.height ?? 2.8;

  const floorTex = floorTexture(def.floor, def.floorColor ?? '#8a6a48');
  floorTex.repeat.set(W / 2, D / 2);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), lambert('#ffffff', floorTex));
  floor.receiveShadow = true;
  floor.position.y = 0.002;
  group.add(floor);

  const wallTex = wallTexture(def.wallColor ?? '#c9b99a');
  const wallMat = lambert('#ffffff', wallTex);
  const frameMat = lambert('#5b3b22');

  const openings: Record<WallSide, Opening[]> = { north: [], south: [], east: [], west: [] };
  const add = (o: WallOpening, door: boolean) =>
    openings[o.wall]?.push({
      center: o.offset ?? 0,
      width: o.width ?? (door ? 1 : 1.2),
      bottom: door ? 0 : 0.9,
      top: door ? 2.1 : 2.0,
      door,
    });
  def.doors?.forEach((o) => add(o, true));
  def.windows?.forEach((o) => add(o, false));

  const sides: { side: WallSide; length: number; pos: THREE.Vector3; rotY: number }[] = [
    { side: 'north', length: W, pos: new THREE.Vector3(0, 0, -D / 2), rotY: 0 },
    { side: 'south', length: W, pos: new THREE.Vector3(0, 0, D / 2), rotY: Math.PI },
    { side: 'east', length: D, pos: new THREE.Vector3(W / 2, 0, 0), rotY: -Math.PI / 2 },
    { side: 'west', length: D, pos: new THREE.Vector3(-W / 2, 0, 0), rotY: Math.PI / 2 },
  ];

  for (const { side, length, pos, rotY } of sides) {
    const wall = new THREE.Group();
    wall.position.copy(pos);
    wall.rotation.y = rotY;
    const piece = (x0: number, x1: number, y0: number, y1: number) => {
      if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
      const geo = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
      // UV em metros para a textura não esticar.
      const uv = geo.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (x0 + uv.getX(i) * (x1 - x0)) / 1.5, (y0 + uv.getY(i) * (y1 - y0)) / 1.5);
      const m = new THREE.Mesh(geo, wallMat);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
      m.receiveShadow = true;
      wall.add(m);
    };

    // Ao longo da parede (x local): da esquerda (-L/2) para a direita (+L/2), vista de dentro.
    const list = [...openings[side]].sort((a, b) => a.center - b.center);
    let cursor = -length / 2;
    for (const o of list) {
      const x0 = Math.max(-length / 2, o.center - o.width / 2);
      const x1 = Math.min(length / 2, o.center + o.width / 2);
      piece(cursor, x0, 0, H);
      piece(x0, x1, 0, o.bottom);
      piece(x0, x1, o.top, H);
      // Moldura
      const t = 0.07;
      const frame = (w: number, h: number, x: number, y: number) => {
        const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.14), frameMat);
        f.position.set(x, y, 0);
        f.castShadow = true;
        wall.add(f);
      };
      frame(t, o.top - o.bottom, x0, (o.top + o.bottom) / 2);
      frame(t, o.top - o.bottom, x1, (o.top + o.bottom) / 2);
      frame(x1 - x0 + t, t, (x0 + x1) / 2, o.top);
      if (!o.door) {
        frame(x1 - x0 + t, t, (x0 + x1) / 2, o.bottom);
        const glass = new THREE.Mesh(
          new THREE.PlaneGeometry(x1 - x0, o.top - o.bottom),
          new THREE.MeshBasicMaterial({ color: '#bfe3ff', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
        );
        glass.position.set((x0 + x1) / 2, (o.top + o.bottom) / 2, 0);
        wall.add(glass);
      } else {
        // Porta entreaberta, presa na dobradiça esquerda.
        const hinge = new THREE.Group();
        hinge.position.set(x0 + t / 2, 0, 0);
        hinge.rotation.y = -1.2;
        const panel = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - t, o.top - 0.02, 0.05).translate((x1 - x0 - t) / 2, (o.top - 0.02) / 2, 0), lambert('#6e4526'));
        panel.castShadow = true;
        hinge.add(panel);
        wall.add(hinge);
      }
      cursor = x1;
    }
    piece(cursor, length / 2, 0, H);

    // Rodapé
    const base = new THREE.Mesh(new THREE.PlaneGeometry(length, 0.12), frameMat);
    base.position.set(0, 0.06, 0.005);
    wall.add(base);
    group.add(wall);
  }

  if (def.ceiling ?? true) {
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2), lambert(def.wallColor ?? '#c9b99a'));
    ceiling.position.y = H;
    group.add(ceiling);
  }
  return group;
}

/* ========================================================================== */
/*  Mobília                                                                   */
/* ========================================================================== */

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Móveis e objetos de interior. Retorna null para tipos que não são mobília. */
export function buildFurniture(type: PropType, color: string | undefined, seed: number): THREE.Group | null {
  const g = new THREE.Group();
  const rand = seededRandom(seed);
  switch (type) {
    case 'table': {
      const wood = lambert(color ?? '#7a5233');
      g.add(box(1.2, 0.06, 0.7, wood, 0, 0.75, 0));
      for (const [x, z] of [[-0.54, -0.29], [0.54, -0.29], [-0.54, 0.29], [0.54, 0.29]]) g.add(box(0.06, 0.72, 0.06, wood, x, 0.36, z));
      return g;
    }
    case 'chair': {
      const wood = lambert(color ?? '#6a4529');
      g.add(box(0.46, 0.05, 0.46, wood, 0, 0.45, 0));
      g.add(box(0.46, 0.5, 0.05, wood, 0, 0.72, -0.21));
      for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) g.add(box(0.045, 0.45, 0.045, wood, x, 0.225, z));
      return g;
    }
    case 'bookshelf': {
      const wood = lambert(color ?? '#5b3b22');
      g.add(box(1.0, 1.9, 0.04, wood, 0, 0.95, -0.16));
      g.add(box(0.04, 1.9, 0.36, wood, -0.48, 0.95, 0));
      g.add(box(0.04, 1.9, 0.36, wood, 0.48, 0.95, 0));
      const colors = ['#8a2b2b', '#2b4f8a', '#2f7a3f', '#c49a2b', '#5b2b7a', '#2b7a7a', '#a0522d'];
      for (let shelf = 0; shelf < 5; shelf++) {
        const y = 0.02 + shelf * 0.46;
        g.add(box(0.92, 0.03, 0.34, wood, 0, y, 0));
        if (shelf === 4) break;
        let x = -0.42;
        while (x < 0.4) {
          const w = 0.04 + rand() * 0.05;
          const h = 0.24 + rand() * 0.14;
          if (rand() < 0.12) {
            x += w + 0.04;
            continue;
          }
          g.add(box(w, h, 0.24, lambert(colors[Math.floor(rand() * colors.length)]), x + w / 2, y + 0.015 + h / 2, 0.02));
          x += w + 0.005;
        }
      }
      return g;
    }
    case 'bed': {
      const wood = lambert(color ?? '#6a4529');
      g.add(box(1.05, 0.3, 2.05, wood, 0, 0.2, 0));
      g.add(box(1.05, 0.7, 0.08, wood, 0, 0.35, -1.0));
      g.add(box(0.98, 0.16, 1.95, lambert('#e8e2d4'), 0, 0.42, 0.02));
      g.add(box(0.98, 0.06, 1.2, lambert('#3f6f8f'), 0, 0.52, 0.4));
      g.add(box(0.6, 0.12, 0.32, lambert('#f4f0e6'), 0, 0.56, -0.72));
      return g;
    }
    case 'rug': {
      const base = new THREE.Color(color ?? '#8a2b2b');
      const tex = pixelTexture(32, (ctx, s) => {
        ctx.fillStyle = `#${base.getHexString()}`;
        ctx.fillRect(0, 0, s, s);
        ctx.strokeStyle = `#${base.clone().multiplyScalar(1.5).getHexString()}`;
        ctx.lineWidth = 2;
        ctx.strokeRect(3, 3, s - 6, s - 6);
        ctx.fillStyle = `#${base.clone().multiplyScalar(0.6).getHexString()}`;
        ctx.fillRect(12, 12, 8, 8);
      });
      const rug = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.4).rotateX(-Math.PI / 2), lambert('#ffffff', tex));
      rug.position.y = 0.006;
      rug.receiveShadow = true;
      g.add(rug);
      return g;
    }
    case 'door': {
      const frame = lambert('#5b3b22');
      g.add(box(0.07, 2.1, 0.14, frame, -0.5, 1.05, 0));
      g.add(box(0.07, 2.1, 0.14, frame, 0.5, 1.05, 0));
      g.add(box(1.07, 0.07, 0.14, frame, 0, 2.1, 0));
      g.add(box(0.93, 2.06, 0.05, lambert(color ?? '#6e4526'), 0, 1.03, 0));
      g.add(box(0.05, 0.05, 0.06, lambert('#d4a93a'), 0.36, 1.0, 0.04));
      return g;
    }
    default:
      return null;
  }
}

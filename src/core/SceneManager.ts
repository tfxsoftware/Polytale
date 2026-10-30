import * as THREE from 'three';
import type { CompiledStory } from '../timeline/ActionRegistry';
import type {
  AttachValue,
  FrameState,
  GroundDef,
  LightDef,
  LookTarget,
  ObjectFrame,
  ParticlePreset,
  PropDef,
  ReachTarget,
  SceneDef,
  ScreenEffect,
  SkyDef,
  SocketRef,
} from '../timeline/types';
import { isVideoSrc } from '../timeline/types';
import type { AssetLoader } from './AssetLoader';
import type { ActorProvider, CameraDirector } from '../systems/CameraDirector';
import type { LipsyncState } from '../systems/AudioLipsync';
import { applyPS1VertexSnap } from '../systems/PostProcessing';
import { Actor } from './Actor';
import { DayNightCycle, buildFurniture, buildRoom } from './Environment';
import { DEG2RAD, fbm1D, hashString, lerp, seededRandom } from '../utils/math';

type Animated = (time: number) => void;

interface SceneLight {
  def: LightDef;
  light: THREE.Light;
  flickerSeed: number;
}

interface SpawnedProp {
  id: string;
  object: THREE.Object3D;
}

function lambert(color: THREE.ColorRepresentation, map?: THREE.Texture): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true, map: map ?? null });
  applyPS1VertexSnap(m);
  return m;
}

function emissive(color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color });
  applyPS1VertexSnap(m);
  return m;
}

function shadowed<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  return o;
}

/** Textura "pixel art" gerada em canvas, sem filtragem (estética PS1). */
function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ========================================================================== */
/*  Padrão projetado (cookie / gobo) de luzes spot                           */
/* ========================================================================== */

const cookieCache = new Map<string, THREE.Texture>();

/** Persiana: faixas horizontais escuras, levemente inclinadas. */
function drawBlinds(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#000';
  const n = 9;
  for (let i = 0; i < n; i++) {
    const y = (i / n) * s;
    ctx.fillRect(0, y, s, (s / n) * 0.55);
  }
}

/** Vidraça: caixilho escuro em cruz, vidraças claras. */
function drawWindow(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#fff';
  const m = s * 0.08;
  const half = s * 0.46;
  ctx.fillRect(m, m, half - m, half - m);
  ctx.fillRect(s - half, m, half - m, half - m);
  ctx.fillRect(m, s - half, half - m, half - m);
  ctx.fillRect(s - half, s - half, half - m, half - m);
}

/** Folhagem: manchas irregulares, como luz coada por árvores. */
function drawLeaves(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#000';
  const rand = seededRandom(hashString('leaves'));
  for (let i = 0; i < 46; i++) {
    const x = rand() * s;
    const y = rand() * s;
    const r = s * (0.06 + rand() * 0.12);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

const COOKIE_DRAWERS: Record<string, (ctx: CanvasRenderingContext2D, s: number) => void> = {
  blinds: drawBlinds,
  window: drawWindow,
  leaves: drawLeaves,
};

/** Textura de spot.map: um preset procedural (cacheado) ou a URL de uma imagem própria. */
function cookieTexture(cookie: string, assets: AssetLoader): THREE.Texture | null {
  const draw = COOKIE_DRAWERS[cookie];
  if (draw) {
    let tex = cookieCache.get(cookie);
    if (!tex) {
      tex = canvasTexture(64, draw);
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      cookieCache.set(cookie, tex);
    }
    return tex;
  }
  const custom = assets.getTexture(cookie);
  if (!custom) console.warn(`[SceneManager] cookie '${cookie}' não é um preset nem uma textura carregada.`);
  return custom ?? null;
}

/* ========================================================================== */
/*  Telas (prop 'screen')                                                    */
/* ========================================================================== */

/** Distância (s) do tempo da história que faz um vídeo de tela ser reposicionado: tocando e parado. */
const SCREEN_VIDEO_DRIFT = 0.15;
const SCREEN_VIDEO_SEEK = 0.04;

/** Linhas da imagem de uma tela com câmera ao vivo: baixa para custar pouco e combinar com o estilo. */
const SCREEN_FEED_HEIGHT = 180;

interface ScreenFeed {
  shot: string;
  object: THREE.Object3D;
  panel: THREE.Mesh;
  camera: THREE.PerspectiveCamera;
  target: THREE.WebGLRenderTarget;
}

/** Linhas da grade de cada efeito: fixas, para o efeito ter a mesma cara em qualquer tamanho de tela. */
const SCREEN_EFFECT_ROWS: Record<ScreenEffect, number> = { lcd: 140, dots: 48, crt: 180 };

/** GLSL de cada efeito: a UV amostrada e a máscara multiplicada sobre a cor. */
const SCREEN_EFFECT_GLSL: Record<ScreenEffect, { uv: string; mask: string }> = {
  // Subpixels RGB verticais, com uma linha escura entre as fileiras.
  lcd: {
    uv: '(floor(screenCell) + 0.5) / uScreenCells',
    mask: 'step(0.12, fract(screenCell.y)) * (vec3(lessThan(abs(fract(screenCell.x) - vec3(0.167, 0.5, 0.833)), vec3(0.167))) * 2.2 + 0.1)',
  },
  // Cada célula vira um LED redondo com a cor do centro dela.
  dots: {
    uv: '(floor(screenCell) + 0.5) / uScreenCells',
    mask: 'vec3((1.0 - smoothstep(0.38, 0.48, length(fract(screenCell) - 0.5))) * 1.6)',
  },
  // Scanlines + vinheta de tubo.
  crt: {
    uv: 'vMapUv',
    mask: 'vec3((0.72 + 0.28 * sin(screenCell.y * 6.2832)) * (1.0 - 1.1 * dot(vMapUv - 0.5, vMapUv - 0.5)))',
  },
};

/** Aplica o efeito na própria amostragem da imagem. Reaproveita o map_fragment do Three (que decodifica vídeo). */
function applyScreenEffect(material: THREE.MeshBasicMaterial, effect: ScreenEffect, aspect: number): void {
  const rows = SCREEN_EFFECT_ROWS[effect];
  const cells = new THREE.Vector2(Math.max(1, Math.round(rows * aspect)), rows);
  const { uv, mask } = SCREEN_EFFECT_GLSL[effect];
  const code = `
    vec2 screenCell = vMapUv * uScreenCells;
    vec2 screenUv = ${uv};
    ${THREE.ShaderChunk.map_fragment.replaceAll('vMapUv', 'screenUv')}
    diffuseColor.rgb *= ${mask};
  `;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uScreenCells = { value: cells };
    shader.fragmentShader = `uniform vec2 uScreenCells;\n${shader.fragmentShader.replace('#include <map_fragment>', code)}`;
  };
  material.customProgramCacheKey = () => `screen-${effect}`;
}

/* ========================================================================== */
/*  Partículas (steam / smoke / dust / sparks)                                */
/* ========================================================================== */

interface ParticleSpec {
  count: number;
  color: string;
  size: number;
  /** Altura percorrida num ciclo (m). */
  height: number;
  /** Deriva horizontal máxima (m). */
  spread: number;
  /** Duração de um ciclo (s). */
  period: number;
  /** Frequência do ruído de deriva. */
  drift: number;
  additive: boolean;
}

const PARTICLE_SPECS: Record<ParticlePreset, ParticleSpec> = {
  steam: { count: 14, color: '#e8eef5', size: 0.22, height: 1.6, spread: 0.35, period: 3.2, drift: 0.6, additive: false },
  smoke: { count: 12, color: '#55585e', size: 0.32, height: 2.2, spread: 0.5, period: 4, drift: 0.4, additive: false },
  dust: { count: 18, color: '#cbbfa0', size: 0.05, height: 0.6, spread: 0.8, period: 6, drift: 0.25, additive: false },
  sparks: { count: 16, color: '#ffb23f', size: 0.045, height: 0.9, spread: 0.3, period: 1.1, drift: 2, additive: true },
};

/** Textura de disco suave compartilhada por todos os sistemas de partículas. */
let particleTexture: THREE.CanvasTexture | null = null;
function softDiscTexture(): THREE.CanvasTexture {
  if (particleTexture) return particleTexture;
  particleTexture = canvasTexture(32, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  particleTexture.magFilter = THREE.LinearFilter;
  particleTexture.minFilter = THREE.LinearFilter;
  return particleTexture;
}

/**
 * Gerencia a cena: céu, névoa, chão, luzes, cenografia e todos os objetos
 * instanciados por SPAWN_OBJECT (atores e props). Aplica o FrameState da
 * timeline aos objetos e roda a "vida" procedural dos atores.
 */
export class SceneManager implements ActorProvider {
  readonly scene = new THREE.Scene();
  private readonly actors = new Map<string, Actor>();
  private readonly props = new Map<string, SpawnedProp>();
  private readonly lights = new Map<string, SceneLight>();
  private readonly animated: Animated[] = [];
  /** Animações puras de `frame.time` (ex.: partículas) — diferente de `animated` (tempo real), ficam reversíveis no seek. */
  private readonly frameAnimated: Animated[] = [];
  /** Vídeos de tela (prop 'screen'): acompanham o relógio da história em `syncScreenVideos`. */
  private readonly screenVideos: HTMLVideoElement[] = [];
  /** Telas com câmera ao vivo: função pura do quadro, então entram no seek e na exportação. */
  private readonly screenFeeds: ScreenFeed[] = [];
  /** Imagem de `scene.backdrop`, recortada para cobrir o quadro. */
  private backdrop: THREE.Texture | null = null;
  private frameAspect = 16 / 9;
  /** Tudo que é recriado a cada história. */
  private readonly world = new THREE.Group();
  private dayNight: DayNightCycle | null = null;
  private elapsed = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly tmpReach = new THREE.Vector3();
  private readonly tmpPrev = new THREE.Vector3();
  private readonly attachA = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private readonly attachB = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };

  constructor() {
    this.scene.add(this.world);
    this.scene.background = new THREE.Color('#10121c');
  }

  /* ---------------------------------------------------------------------- */
  /*  ActorProvider                                                          */
  /* ---------------------------------------------------------------------- */

  getActor(id: string): Actor | undefined {
    return this.actors.get(id);
  }

  visibleActors(): Actor[] {
    return [...this.actors.values()].filter((a) => a.visible);
  }

  allActors(): Actor[] {
    return [...this.actors.values()];
  }

  /** Posição no mundo de um prop (planos de inserção/B-roll). null se o id não for um prop da cena. */
  propPosition(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const prop = this.props.get(id);
    return prop ? prop.object.getWorldPosition(out) : null;
  }

  /* ---------------------------------------------------------------------- */
  /*  Construção                                                            */
  /* ---------------------------------------------------------------------- */

  /** (Re)constrói a cena para uma história compilada. */
  build(story: CompiledStory, assets: AssetLoader): void {
    this.clear();
    const scene = story.script.scene ?? {};
    this.buildEnvironment(scene, assets);
    // Com ciclo dia/noite o sol e o céu são automáticos; luzes do script somam a eles.
    this.buildLights(scene.lights ?? (this.dayNight ? [] : defaultLights()), assets);
    for (const p of scene.props ?? []) {
      const obj = this.createProp(p, assets, hashString(JSON.stringify(p)));
      obj.position.set(p.position[0], p.position[1], p.position[2]);
      obj.rotation.y = (p.rotation ?? 0) * DEG2RAD;
      obj.scale.setScalar(p.scale ?? 1);
      this.world.add(obj);
    }

    // Objetos da timeline: criados agora (ocultos) para que o seek seja instantâneo.
    for (const [id, def] of story.objects) {
      if (def.kind === 'actor') {
        const gltf = assets.getGLTF(def.model);
        if (def.model && !gltf) console.warn(`[SceneManager] modelo '${def.model}' indisponível; '${id}' usará personagem procedural.`);
        const actor = new Actor(id, def, gltf, assets);
        actor.setGestureLibrary(story.script.gestures ?? {});
        this.actors.set(id, actor);
        this.world.add(actor.root);
      } else {
        const object = this.createProp(def, assets, hashString(id));
        object.name = `prop:${id}`;
        object.visible = false;
        this.props.set(id, { id, object });
        this.world.add(object);
      }
    }
  }

  /**
   * Pré-compila os shaders de tudo que a história pode mostrar (inclusive objetos
   * ainda ocultos), evitando travadas quando algo aparece pela primeira vez.
   */
  prewarm(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const hidden: THREE.Object3D[] = [];
    this.world.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    renderer.compile(this.scene, camera);
    for (const o of hidden) o.visible = false;
  }

  /**
   * Luz que acompanha um objeto. Fica na raiz do mundo (sempre "visível" para o
   * renderer) e só tem a intensidade zerada quando o dono está oculto: o número de
   * luzes da cena não muda, então os shaders não são recompilados.
   */
  private followLight<L extends THREE.Light>(light: L, owner: THREE.Object3D, offset: THREE.Vector3): L {
    light.userData.baseIntensity = light.intensity;
    this.world.add(light);
    this.animated.push(() => {
      owner.updateWorldMatrix(true, false);
      light.position.copy(offset).applyMatrix4(owner.matrixWorld);
      light.intensity = this.isShown(owner) && owner.parent ? (light.userData.baseIntensity as number) : 0;
    });
    return light;
  }

  private isShown(o: THREE.Object3D | null): boolean {
    for (let n = o; n && n !== this.world; n = n.parent) if (!n.visible) return false;
    return true;
  }

  clear(): void {
    for (const a of this.actors.values()) a.dispose();
    this.actors.clear();
    this.props.clear();
    this.lights.clear();
    this.animated.length = 0;
    this.frameAnimated.length = 0;
    for (const v of this.screenVideos) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    this.screenVideos.length = 0;
    for (const f of this.screenFeeds) f.target.dispose();
    this.screenFeeds.length = 0;
    this.backdrop = null;
    this.world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          (m as THREE.MeshLambertMaterial).map?.dispose();
          m.dispose();
        });
      }
      const light = o as THREE.DirectionalLight;
      if (light.isLight) light.shadow?.map?.dispose();
    });
    this.world.clear();
    this.scene.fog = null;
    this.dayNight = null;
  }

  /* ---------------------------------------------------------------------- */
  /*  Por quadro                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Mantém os vídeos de tela no tempo da história, como o áudio: tocam e pausam com a timeline e
   * voltam ao ponto certo quando se afastam dele (seek, gravação).
   */
  syncScreenVideos(time: number, playing: boolean, rate: number): void {
    for (const video of this.screenVideos) {
      const { duration } = video;
      if (!Number.isFinite(duration) || duration <= 0) continue;
      const expected = video.loop ? time % duration : Math.min(time, duration);
      if (video.playbackRate !== rate && rate > 0) video.playbackRate = rate;
      const shouldPlay = playing && (video.loop || time < duration);
      if (shouldPlay && video.paused) {
        video.play().catch(() => {
          /* autoplay pode exigir gesto do usuário; a tela fica parada até lá */
        });
      } else if (!shouldPlay && !video.paused) video.pause();
      let off = Math.abs(video.currentTime - expected);
      if (video.loop) off = Math.min(off, duration - off);
      if (off > (shouldPlay ? SCREEN_VIDEO_DRIFT : SCREEN_VIDEO_SEEK) && !video.seeking) video.currentTime = expected;
    }
  }

  /** Proporção do quadro de saída: `scene.backdrop` é recortado para cobri-lo sem distorcer. */
  setFrameAspect(aspect: number): void {
    this.frameAspect = aspect;
    this.fitBackdrop();
  }

  private fitBackdrop(): void {
    const image = this.backdrop?.image as { width: number; height: number } | undefined;
    if (!this.backdrop || !image?.height) return;
    const ratio = image.width / image.height / this.frameAspect;
    if (ratio > 1) {
      this.backdrop.repeat.set(1 / ratio, 1);
      this.backdrop.offset.set((1 - 1 / ratio) / 2, 0);
    } else {
      this.backdrop.repeat.set(1, ratio);
      this.backdrop.offset.set(0, (1 - ratio) / 2);
    }
  }

  /**
   * Renderiza as telas com câmera ao vivo. Roda depois do quadro principal: reaproveita os mapas
   * de sombra dele, e cada tela aparece com um quadro de atraso (imperceptível).
   */
  renderScreenFeeds(renderer: THREE.WebGLRenderer, director: CameraDirector, time: number): void {
    if (!this.screenFeeds.length) return;
    const autoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    for (const feed of this.screenFeeds) {
      if (!this.isShown(feed.object) || !director.poseShot(feed.shot, time, feed.camera)) continue;
      // A tela não pode amostrar a própria imagem enquanto ela é desenhada.
      feed.panel.visible = false;
      renderer.setRenderTarget(feed.target);
      renderer.render(this.scene, feed.camera);
      feed.panel.visible = true;
    }
    renderer.setRenderTarget(null);
    renderer.shadowMap.autoUpdate = autoUpdate;
  }

  /** Aplica o estado determinístico da timeline. */
  applyFrame(frame: FrameState): void {
    if (this.dayNight && frame.hour !== null) this.dayNight.apply(frame.hour);

    for (const [id, obj] of Object.entries(frame.objects)) {
      const actor = this.actors.get(id);
      if (actor) {
        actor.applyFrame(obj, frame.actors[id], frame.time);
        continue;
      }
      const prop = this.props.get(id);
      if (!prop) continue;
      prop.object.visible = obj.visible;
      prop.object.position.set(obj.position[0], obj.position[1], obj.position[2]);
      prop.object.rotation.set(obj.rotation[0] * DEG2RAD, obj.rotation[1] * DEG2RAD, obj.rotation[2] * DEG2RAD, 'YXZ');
      prop.object.scale.setScalar(obj.scale);
    }

    for (const fn of this.frameAnimated) fn(frame.time);

    for (const [id, l] of Object.entries(frame.lights)) {
      const sl = this.lights.get(id);
      if (!sl) continue;
      sl.light.color.setRGB(l.color[0], l.color[1], l.color[2], THREE.SRGBColorSpace);
      sl.light.userData.baseIntensity = l.intensity;
      sl.light.position.set(l.position[0], l.position[1], l.position[2]);
    }
  }

  /**
   * Vida procedural e animações ambientes (rodam mesmo com a timeline pausada).
   * `lookTargets` vem do frame; `cameraPosition` resolve o alvo 'camera'.
   */
  update(
    deltaTime: number,
    frame: FrameState,
    lipsync: (actorId: string) => LipsyncState,
    cameraPosition: THREE.Vector3,
  ): void {
    this.elapsed += deltaTime;
    const t = this.elapsed;

    for (const sl of this.lights.values()) {
      const base = (sl.light.userData.baseIntensity as number | undefined) ?? sl.def.intensity ?? 1;
      const flicker = sl.def.flicker ?? 0;
      sl.light.intensity = flicker > 0 ? base * (1 + fbm1D(t * 6, sl.flickerSeed) * flicker) : base;
    }

    for (const actor of this.actors.values()) {
      const af = frame.actors[actor.id];
      actor.setLookTarget(af ? this.resolveLookTarget(af.lookAt, actor.id, cameraPosition) : null);
      actor.setLipsync(lipsync(actor.id));
      if (af) {
        for (const hand of ['left', 'right'] as const) {
          const r = af.reach[hand];
          if (r.weight < 0.001 || r.target === null) {
            actor.setReach(hand, null, 0);
            continue;
          }
          const point = this.resolveReachTarget(r.target, this.tmpReach);
          if (point && r.prev !== null && r.blend < 1) {
            const prev = this.resolveReachTarget(r.prev, this.tmpPrev);
            if (prev) point.lerpVectors(prev, point, r.blend);
          }
          actor.setReach(hand, point, r.weight, r.shake);
        }
      }
      actor.update(deltaTime);
    }

    // Objetos presos seguem os encaixes já atualizados neste quadro.
    for (const [id, prop] of this.props) {
      const obj = frame.objects[id];
      if (obj) this.applyAttachment(prop.object, obj, obj.attach);
    }

    // Animações ambientes por último: luzes que seguem objetos já veem a posição final.
    for (const fn of this.animated) fn(t);
  }

  /** Converte um alvo de alcance (REACH) em ponto no mundo. */
  resolveReachTarget(target: ReachTarget, out: THREE.Vector3): THREE.Vector3 | null {
    if (Array.isArray(target)) return out.set(target[0], target[1], target[2]);
    if (typeof target === 'string') return this.objectAnchor(target, 'chest', out);
    if ('midpoint' in target) {
      const a = this.objectAnchor(target.midpoint[0], 'chest', new THREE.Vector3());
      const b = this.objectAnchor(target.midpoint[1], 'chest', new THREE.Vector3());
      if (!a || !b) return null;
      out.addVectors(a, b).multiplyScalar(0.5);
      if (target.height !== undefined) out.y = target.height;
      if (target.offset) out.add(this.tmp.set(target.offset[0], target.offset[1], target.offset[2]));
      return out;
    }
    const p = this.objectAnchor(target.target, target.part ?? 'chest', out);
    if (!p) return null;
    if (target.offset) {
      const off = this.tmp.set(target.offset[0], target.offset[1], target.offset[2]);
      if (target.local) {
        const holder = this.actors.get(target.target)?.root ?? this.props.get(target.target)?.object;
        if (holder) off.applyQuaternion(holder.quaternion);
      }
      p.add(off);
    }
    return p;
  }

  /** Ponto logo acima da cabeça de um ator (balões de fala). null se o ator não está na cena. */
  actorHeadTop(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    actor.getPartWorldPosition('head', out);
    out.y += 0.3;
    return out;
  }

  /** Posição de um ator (parte do corpo) ou prop (posição de mundo atual, mesmo se seguro). */
  private objectAnchor(id: string, part: NonNullable<Extract<ReachTarget, { target: string }>['part']>, out: THREE.Vector3): THREE.Vector3 | null {
    const actor = this.actors.get(id);
    if (actor) return actor.getPartWorldPosition(part, out);
    const prop = this.props.get(id);
    if (prop) return prop.object.getWorldPosition(out);
    return null;
  }

  private socketTransform(ref: SocketRef | null, obj: ObjectFrame, out: { pos: THREE.Vector3; quat: THREE.Quaternion }): void {
    const actor = ref ? this.actors.get(ref.actor) : undefined;
    if (ref && actor) {
      actor.getSocketWorld(ref.socket, out.pos, out.quat);
      out.pos.add(this.tmp.set(ref.offset[0], ref.offset[1], ref.offset[2]).applyQuaternion(out.quat));
      out.quat.multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(ref.rotation[0] * DEG2RAD, ref.rotation[1] * DEG2RAD, ref.rotation[2] * DEG2RAD)),
      );
    } else {
      out.pos.set(obj.position[0], obj.position[1], obj.position[2]);
      out.quat.setFromEuler(new THREE.Euler(obj.rotation[0] * DEG2RAD, obj.rotation[1] * DEG2RAD, obj.rotation[2] * DEG2RAD, 'YXZ'));
    }
  }

  /** Mistura entre o encaixe anterior e o atual (mão -> mão, mão -> chão...). */
  private applyAttachment(object: THREE.Object3D, obj: ObjectFrame, attach: AttachValue): void {
    if (!attach.from && !attach.to) return;
    this.socketTransform(attach.from, obj, this.attachA);
    this.socketTransform(attach.to, obj, this.attachB);
    const t = attach.alpha;
    object.position.lerpVectors(this.attachA.pos, this.attachB.pos, t);
    object.quaternion.slerpQuaternions(this.attachA.quat, this.attachB.quat, t);
  }

  /** Converte o alvo de olhar do script em posição no mundo. */
  resolveLookTarget(target: LookTarget, selfId: string, cameraPosition: THREE.Vector3): THREE.Vector3 | null {
    if (target === null || target === undefined) return null;
    if (Array.isArray(target)) return this.tmp.set(target[0], target[1], target[2]);
    if (target === 'camera') return this.tmp.copy(cameraPosition);
    if (target === selfId) return null;
    const actor = this.actors.get(target);
    if (actor) return actor.getHeadWorldPosition(this.tmp);
    const prop = this.props.get(target);
    if (prop) return new THREE.Box3().setFromObject(prop.object).getCenter(this.tmp);
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /*  Ambiente                                                              */
  /* ---------------------------------------------------------------------- */

  private buildEnvironment(def: SceneDef, assets: AssetLoader): void {
    const bg = new THREE.Color(def.background ?? def.fog?.color ?? '#10121c');
    this.scene.background = bg;
    if (def.backdrop) {
      this.backdrop = assets.getTexture(def.backdrop) ?? null;
      if (this.backdrop) this.scene.background = this.backdrop;
      else console.warn(`[SceneManager] backdrop '${def.backdrop}' indisponível.`);
      this.fitBackdrop();
    }
    if (def.fog) this.scene.fog = new THREE.Fog(def.fog.color, def.fog.near, def.fog.far);
    else if (typeof def.timeOfDay === 'number' && !def.room) this.scene.fog = new THREE.Fog('#000000', 28, 95);

    if (typeof def.timeOfDay === 'number') {
      this.dayNight = new DayNightCycle(this.scene);
      this.world.add(this.dayNight.group);
      this.dayNight.apply(def.timeOfDay);
    } else if (def.sky) {
      this.world.add(this.createSky(def.sky));
    }
    if (def.room) this.world.add(buildRoom(def.room));
    // Em interiores o chão externo só aparece se for pedido (ex.: visto pela porta).
    if (!def.room || def.ground) this.world.add(this.createGround(def.ground ?? { color: '#3d5a32', color2: '#35502b' }));
  }

  private createSky(sky: SkyDef): THREE.Mesh {
    const geo = new THREE.SphereGeometry(180, 16, 10);
    const top = new THREE.Color(sky.top);
    const bottom = new THREE.Color(sky.bottom);
    const colors: number[] = [];
    const pos = geo.getAttribute('position');
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = THREE.MathUtils.clamp(pos.getY(i) / 180, -1, 1);
      c.copy(bottom).lerp(top, Math.pow(Math.max(0, h), 0.6));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    mesh.name = 'sky';
    return mesh;
  }

  private createGround(def: GroundDef): THREE.Mesh {
    const size = def.size ?? 160;
    const tiles = def.tiles ?? 24;
    const c1 = def.color;
    const c2 = def.color2 ?? def.color;
    const tex = canvasTexture(64, (ctx, s) => {
      const rand = seededRandom(hashString(c1 + c2));
      ctx.fillStyle = c1;
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = c2;
      ctx.fillRect(0, 0, s / 2, s / 2);
      ctx.fillRect(s / 2, s / 2, s / 2, s / 2);
      // Ruído de "grama" em blocos de 2px.
      for (let i = 0; i < 260; i++) {
        const v = Math.floor(rand() * 40) - 20;
        ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 200 : 0},${Math.abs(v) / 260})`;
        ctx.fillRect(Math.floor(rand() * 32) * 2, Math.floor(rand() * 32) * 2, 2, 2);
      }
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(tiles, tiles);
    const geo = new THREE.PlaneGeometry(size, size, 12, 12);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, lambert('#ffffff', tex));
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    return mesh;
  }

  private buildLights(defs: LightDef[], assets: AssetLoader): void {
    for (const def of defs) {
      const color = new THREE.Color(def.color ?? '#ffffff');
      const intensity = def.intensity ?? 1;
      let light: THREE.Light;
      switch (def.type) {
        case 'ambient':
          light = new THREE.AmbientLight(color, intensity);
          break;
        case 'hemisphere':
          light = new THREE.HemisphereLight(color, new THREE.Color(def.groundColor ?? '#2a2a2a'), intensity);
          break;
        case 'directional': {
          const d = new THREE.DirectionalLight(color, intensity);
          if (def.castShadow ?? true) {
            d.castShadow = true;
            d.shadow.mapSize.set(1024, 1024);
            const cam = d.shadow.camera;
            cam.left = cam.bottom = -14;
            cam.right = cam.top = 14;
            cam.near = 0.5;
            cam.far = 60;
            d.shadow.bias = -0.0006;
            d.shadow.normalBias = 0.02;
          }
          const tgt = def.target ?? [0, 0, 0];
          d.target.position.set(tgt[0], tgt[1], tgt[2]);
          this.world.add(d.target);
          light = d;
          break;
        }
        case 'spot': {
          const s = new THREE.SpotLight(color, intensity, def.distance ?? 0, (def.angle ?? 35) * DEG2RAD, 0.4, 1.5);
          s.castShadow = def.castShadow ?? false;
          const tgt = def.target ?? [0, 0, 0];
          s.target.position.set(tgt[0], tgt[1], tgt[2]);
          this.world.add(s.target);
          if (def.cookie) s.map = cookieTexture(def.cookie, assets);
          light = s;
          break;
        }
        case 'point':
        default: {
          const p = new THREE.PointLight(color, intensity, def.distance ?? 0, 1.6);
          p.castShadow = def.castShadow ?? false;
          if (p.castShadow) p.shadow.mapSize.set(512, 512);
          light = p;
          break;
        }
      }
      const pos = def.position ?? [0, 5, 0];
      light.position.set(pos[0], pos[1], pos[2]);
      light.name = `light:${def.id}`;
      light.userData.baseIntensity = intensity;
      this.world.add(light);
      this.lights.set(def.id, { def, light, flickerSeed: hashString(def.id) % 1000 });
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Props procedurais                                                     */
  /* ---------------------------------------------------------------------- */

  private createProp(def: PropDef, assets: AssetLoader, seed: number): THREE.Object3D {
    const rand = seededRandom(seed);
    const g = new THREE.Group();
    switch (def.prop) {
      case 'tree': {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 1.6, 5).translate(0, 0.8, 0), lambert('#5a3d24'));
        g.add(trunk);
        const leaf = lambert(def.color ?? '#3f7a3a');
        for (let i = 0; i < 3; i++) {
          const r = 0.9 - i * 0.18 + rand() * 0.15;
          const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), leaf);
          blob.position.set((rand() - 0.5) * 0.5, 1.7 + i * 0.55, (rand() - 0.5) * 0.5);
          blob.rotation.set(rand() * 3, rand() * 3, 0);
          g.add(blob);
        }
        break;
      }
      case 'pine': {
        g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 1, 5).translate(0, 0.5, 0), lambert('#4a3220')));
        const leaf = lambert(def.color ?? '#2c5a3a');
        for (let i = 0; i < 3; i++) {
          const cone = new THREE.Mesh(new THREE.ConeGeometry(1.1 - i * 0.28, 1.3, 6), leaf);
          cone.position.y = 1.3 + i * 0.75;
          cone.rotation.y = rand() * Math.PI;
          g.add(cone);
        }
        break;
      }
      case 'rock': {
        const geo = new THREE.DodecahedronGeometry(0.6, 0);
        const pos = geo.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(i, pos.getX(i) * (0.8 + rand() * 0.4), pos.getY(i) * (0.55 + rand() * 0.3), pos.getZ(i) * (0.8 + rand() * 0.4));
        }
        geo.computeVertexNormals();
        const rock = new THREE.Mesh(geo, lambert(def.color ?? '#7b7b84'));
        rock.position.y = 0.25;
        g.add(rock);
        break;
      }
      case 'crate': {
        const tex = canvasTexture(32, (ctx, s) => {
          ctx.fillStyle = def.color ?? '#8a5a2b';
          ctx.fillRect(0, 0, s, s);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          for (let y = 0; y < s; y += 8) ctx.fillRect(0, y, s, 1);
          ctx.strokeStyle = 'rgba(40,20,5,0.9)';
          ctx.lineWidth = 3;
          ctx.strokeRect(1, 1, s - 2, s - 2);
          ctx.beginPath();
          ctx.moveTo(2, 2);
          ctx.lineTo(s - 2, s - 2);
          ctx.stroke();
        });
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8).translate(0, 0.4, 0), lambert('#ffffff', tex)));
        break;
      }
      case 'campfire': {
        const log = lambert('#4b2e1a');
        for (let i = 0; i < 4; i++) {
          const l = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.75, 5), log);
          l.rotation.z = Math.PI / 2;
          l.rotation.y = (i / 4) * Math.PI;
          l.position.y = 0.07;
          g.add(l);
        }
        const stone = lambert('#5c5c62');
        for (let i = 0; i < 8; i++) {
          const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.1, 0), stone);
          const a = (i / 8) * Math.PI * 2;
          s.position.set(Math.cos(a) * 0.48, 0.06, Math.sin(a) * 0.48);
          g.add(s);
        }
        const flames: THREE.Mesh[] = [];
        const colors = ['#ff5a1f', '#ffa21f', '#ffe27a'];
        colors.forEach((c, i) => {
          const f = new THREE.Mesh(new THREE.ConeGeometry(0.26 - i * 0.07, 0.7 - i * 0.15, 5).translate(0, 0.35 - i * 0.07, 0), emissive(c));
          f.position.y = 0.08;
          f.castShadow = false;
          flames.push(f);
          g.add(f);
        });
        const fs = seed % 1000;
        this.animated.push((t) => {
          flames.forEach((f, i) => {
            const n = fbm1D(t * (4 + i), fs + i * 7);
            f.scale.set(1 + n * 0.15, 1 + n * 0.35, 1 + n * 0.15);
            f.rotation.y = t * (1.5 + i) + i;
          });
        });
        break;
      }
      case 'pillar': {
        const m = lambert(def.color ?? '#b8b0a0');
        g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 2.6, 8).translate(0, 1.4, 0), m));
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.15, 0.8).translate(0, 0.075, 0), m));
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.15, 0.8).translate(0, 2.775, 0), m));
        break;
      }
      case 'lamp': {
        g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.2, 6).translate(0, 1.1, 0), lambert('#2b2b30')));
        const bulb = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), emissive(def.color ?? '#ffd27a'));
        bulb.position.y = 2.3;
        bulb.castShadow = false;
        g.add(bulb);
        break;
      }
      case 'stool': {
        const wood = lambert(def.color ?? '#7a4a26');
        g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 8).translate(0, 0.42, 0), wood));
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.42, 5).translate(0, 0.21, 0), wood);
          leg.position.set(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15);
          leg.rotation.set(Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12);
          g.add(leg);
        }
        break;
      }
      case 'orb': {
        const color = def.color ?? '#5ff0e0';
        const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.085, 0), emissive(color));
        core.castShadow = false;
        const shell = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.12, 0),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }),
        );
        shell.castShadow = false;
        g.add(core, shell);
        const glow = this.followLight(new THREE.PointLight(color, 1.6, 3.5, 1.6), g, new THREE.Vector3());
        const fs = seed % 1000;
        this.animated.push((t) => {
          core.rotation.set(t * 0.9, t * 1.3, 0);
          shell.rotation.set(-t * 0.6, t * 0.4, t * 0.2);
          const pulse = 1 + fbm1D(t * 2.5, fs) * 0.12;
          shell.scale.setScalar(pulse);
          glow.userData.baseIntensity = 1.6 * pulse;
        });
        break;
      }
      case 'book': {
        const cover = lambert(def.color ?? '#7a2e3a');
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.22), cover));
        const pages = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.028, 0.205), lambert('#efe6cf'));
        pages.position.x = 0.006;
        g.add(pages);
        break;
      }
      case 'cup': {
        const m = lambert(def.color ?? '#c9c1b5');
        g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 0.1, 7), m));
        const handle = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.007, 4, 6), m);
        handle.position.x = 0.05;
        g.add(handle);
        break;
      }
      case 'candle': {
        g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.16, 6).translate(0, 0.08, 0), lambert(def.color ?? '#efe6cf')));
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.06, 4).translate(0, 0.03, 0), emissive('#ffcf6a'));
        flame.position.y = 0.17;
        flame.castShadow = false;
        g.add(flame);
        const light = this.followLight(new THREE.PointLight('#ffb35a', 2.2, 5, 1.6), g, new THREE.Vector3(0, 0.25, 0));
        const fs = seed % 1000;
        this.animated.push((t) => {
          const n = fbm1D(t * 7, fs);
          flame.scale.set(1, 1 + n * 0.35, 1);
          light.userData.baseIntensity = 2.2 * (1 + n * 0.25);
        });
        break;
      }
      case 'table':
      case 'chair':
      case 'bookshelf':
      case 'bed':
      case 'rug':
      case 'door': {
        const furniture = buildFurniture(def.prop, def.color, seed);
        if (furniture) g.add(furniture);
        break;
      }
      case 'model': {
        const gltf = assets.getGLTF(def.model);
        if (gltf) g.add(gltf.scene.clone(true));
        else g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5).translate(0, 0.25, 0), lambert('#ff00ff')));
        g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => applyPS1VertexSnap(m));
        });
        break;
      }
      case 'particles': {
        const spec = PARTICLE_SPECS[def.particles?.preset ?? 'steam'];
        const count = Math.max(1, Math.min(64, def.particles?.count ?? spec.count));
        const tex = softDiscTexture();
        // Deslocamento de fase fixo por partícula (sorteado uma vez na criação; a partir daí é puro em `t`).
        const phase = Array.from({ length: count }, () => rand());
        const sprites = Array.from({ length: count }, () => {
          const mat = new THREE.SpriteMaterial({
            map: tex,
            color: def.color ?? spec.color,
            transparent: true,
            depthWrite: false,
            opacity: 0,
            blending: spec.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
          });
          const sprite = new THREE.Sprite(mat);
          sprite.castShadow = false;
          g.add(sprite);
          return sprite;
        });
        this.frameAnimated.push((t) => {
          for (let i = 0; i < sprites.length; i++) {
            const s = seed + i * 131;
            const u = (t / spec.period + phase[i]) % 1;
            const x = fbm1D(t * spec.drift, s) * spec.spread * u;
            const z = fbm1D(t * spec.drift + 50, s) * spec.spread * u;
            sprites[i].position.set(x, u * spec.height, z);
            sprites[i].scale.setScalar(spec.size * lerp(0.6, 1.4, u));
            (sprites[i].material as THREE.SpriteMaterial).opacity = Math.sin(Math.PI * u);
          }
        });
        break;
      }
      case 'screen': {
        const screenDef = def.screen;
        const width = screenDef?.width ?? 1.6;
        const height = screenDef?.height ?? 0.9;
        const depth = Math.min(width, height) * 0.08;

        const framed = screenDef?.bezel ?? true;
        if (framed) {
          const bezel = new THREE.Mesh(new THREE.BoxGeometry(width + depth, height + depth, depth).translate(0, 0, -depth / 2), lambert('#141418'));
          g.add(bezel);
        }

        let map: THREE.Texture | null = null;
        let feedTarget: THREE.WebGLRenderTarget | null = null;
        if (screenDef?.camera) {
          // Cor linear em HDR, como o RenderPass: o tone mapping acontece uma vez só, no OutputPass.
          feedTarget = new THREE.WebGLRenderTarget(Math.max(1, Math.round((SCREEN_FEED_HEIGHT * width) / height)), SCREEN_FEED_HEIGHT, {
            type: THREE.HalfFloatType,
            magFilter: THREE.NearestFilter,
            minFilter: THREE.NearestFilter,
            generateMipmaps: false,
          });
          map = feedTarget.texture;
        } else if (screenDef?.src) {
          if (isVideoSrc(screenDef.src)) {
            const video = document.createElement('video');
            video.src = assets.resolve(screenDef.src);
            video.loop = screenDef.loop ?? true;
            video.muted = true;
            video.playsInline = true;
            video.crossOrigin = 'anonymous';
            this.screenVideos.push(video);
            const videoTex = new THREE.VideoTexture(video);
            videoTex.colorSpace = THREE.SRGBColorSpace;
            map = videoTex;
            this.animated.push(() => {
              videoTex.needsUpdate = true;
            });
          } else {
            map = assets.getTexture(screenDef.src) ?? null;
            if (!map) console.warn(`[SceneManager] tela: imagem '${screenDef.src}' indisponível.`);
          }
        }
        const screenMat = new THREE.MeshBasicMaterial({ map, color: map ? '#ffffff' : '#1a1a22', alphaTest: framed ? 0 : 0.5 });
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), screenMat);
        panel.position.z = 0.002;
        g.add(panel);
        if (screenDef?.effect && map) applyScreenEffect(screenMat, screenDef.effect, width / height);
        if (screenDef?.camera && feedTarget) {
          const camera = new THREE.PerspectiveCamera(50, width / height, 0.05, 400);
          this.screenFeeds.push({ shot: screenDef.camera, object: g, panel, camera, target: feedTarget });
        }
        break;
      }
    }
    return shadowed(g);
  }
}

function defaultLights(): LightDef[] {
  return [
    { id: 'ambient', type: 'hemisphere', color: '#bcd0ff', groundColor: '#3a2f25', intensity: 0.9 },
    { id: 'sun', type: 'directional', color: '#fff1d6', intensity: 2.2, position: [6, 10, 6], castShadow: true },
  ];
}

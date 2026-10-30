import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { isVideoSrc, LIGHT_COOKIE_PRESETS, type StoryScript } from '../timeline/types';

export interface AssetManifest {
  models: string[];
  audio: string[];
  textures: string[];
}

export interface LoadProgress {
  loaded: number;
  total: number;
  url: string;
  failed: string[];
}

/**
 * Carregador assíncrono com cache de GLTF/GLB, AudioBuffer e texturas.
 * Falhas não interrompem a história: o recurso é marcado como ausente
 * e o sistema consumidor usa seu fallback procedural.
 */
export class AssetLoader {
  private readonly gltfLoader = new GLTFLoader();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly gltfCache = new Map<string, Promise<GLTF>>();
  private readonly audioCache = new Map<string, Promise<AudioBuffer>>();
  private readonly textureCache = new Map<string, Promise<THREE.Texture>>();
  private readonly resolvedGltf = new Map<string, GLTF>();
  private readonly resolvedAudio = new Map<string, AudioBuffer>();
  private readonly resolvedTexture = new Map<string, THREE.Texture>();

  constructor(
    private readonly audioContext: BaseAudioContext,
    private readonly baseUrl: string = import.meta.env.BASE_URL,
  ) {}

  /** Coleta todas as URLs externas referenciadas por um StoryScript. */
  static manifestOf(script: StoryScript): AssetManifest {
    const models = new Set<string>();
    const audio = new Set<string>();
    const textures = new Set<string>();
    const addObject = (o: unknown) => {
      const def = o as
        | { kind?: string; model?: string; prop?: string; palette?: { faceTexture?: string; outfitTexture?: string }; screen?: { src?: string } }
        | undefined;
      if (!def || typeof def !== 'object') return;
      if (def.model && (def.kind === 'actor' || def.prop === 'model')) models.add(def.model);
      if (def.kind === 'actor' && def.palette?.faceTexture) textures.add(def.palette.faceTexture);
      if (def.kind === 'actor' && def.palette?.outfitTexture) textures.add(def.palette.outfitTexture);
      if (def.prop === 'screen' && def.screen?.src && !isVideoSrc(def.screen.src)) textures.add(def.screen.src);
    };
    const scenes = [script.scene, ...(script.chapters ?? []).map((c) => c?.scene)];
    for (const scene of scenes) {
      if (scene?.backdrop) textures.add(scene.backdrop);
      for (const p of scene?.props ?? []) addObject(p);
      for (const l of scene?.lights ?? []) {
        if (l.cookie && !(LIGHT_COOKIE_PRESETS as readonly string[]).includes(l.cookie)) textures.add(l.cookie);
      }
    }
    for (const def of Object.values(script.cast ?? {})) addObject(def);

    const timelines = [script.timeline ?? [], ...(script.chapters ?? []).map((c) => c?.timeline ?? [])];
    for (const timeline of timelines) {
      for (const ev of Array.isArray(timeline) ? timeline : []) {
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'SPAWN_OBJECT') addObject(ev.object);
        else if (ev.type === 'PLAY_AUDIO_WITH_LIPSYNC' && ev.audio) audio.add(ev.audio);
        else if (ev.type === 'PLAY_SOUND' && ev.src && !ev.src.startsWith('procedural:')) audio.add(ev.src);
      }
    }
    return { models: [...models], audio: [...audio], textures: [...textures] };
  }

  /** Carrega um manifesto inteiro em paralelo, reportando progresso. */
  async preload(manifest: AssetManifest, onProgress?: (p: LoadProgress) => void): Promise<LoadProgress> {
    const jobs: [string, () => Promise<unknown>][] = [
      ...manifest.models.map((u): [string, () => Promise<unknown>] => [u, () => this.loadGLTF(u)]),
      ...manifest.audio.map((u): [string, () => Promise<unknown>] => [u, () => this.loadAudio(u)]),
      ...manifest.textures.map((u): [string, () => Promise<unknown>] => [u, () => this.loadTexture(u)]),
    ];
    const progress: LoadProgress = { loaded: 0, total: jobs.length, url: '', failed: [] };
    onProgress?.({ ...progress });
    await Promise.all(
      jobs.map(async ([url, job]) => {
        try {
          await job();
        } catch (err) {
          progress.failed.push(url);
          console.warn(`[AssetLoader] falha ao carregar '${url}' — usando fallback procedural.`, err);
        } finally {
          progress.loaded++;
          progress.url = url;
          onProgress?.({ ...progress, failed: [...progress.failed] });
        }
      }),
    );
    return progress;
  }

  loadGLTF(url: string): Promise<GLTF> {
    let p = this.gltfCache.get(url);
    if (!p) {
      p = this.gltfLoader.loadAsync(this.resolve(url)).then((g) => {
        this.resolvedGltf.set(url, g);
        return g;
      });
      this.gltfCache.set(url, p);
      p.catch(() => this.gltfCache.delete(url));
    }
    return p;
  }

  loadAudio(url: string): Promise<AudioBuffer> {
    let p = this.audioCache.get(url);
    if (!p) {
      p = fetch(this.resolve(url))
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((data) => this.audioContext.decodeAudioData(data))
        .then((buf) => {
          this.resolvedAudio.set(url, buf);
          return buf;
        });
      this.audioCache.set(url, p);
      p.catch(() => this.audioCache.delete(url));
    }
    return p;
  }

  loadTexture(url: string): Promise<THREE.Texture> {
    let p = this.textureCache.get(url);
    if (!p) {
      p = this.textureLoader.loadAsync(this.resolve(url)).then((t) => {
        // Estética retrô: sem filtragem bilinear nem mipmaps.
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.colorSpace = THREE.SRGBColorSpace;
        this.resolvedTexture.set(url, t);
        return t;
      });
      this.textureCache.set(url, p);
      p.catch(() => this.textureCache.delete(url));
    }
    return p;
  }

  /** Acesso síncrono a recursos já carregados (undefined se ausente/falhou). */
  getGLTF(url: string | undefined): GLTF | undefined {
    return url ? this.resolvedGltf.get(url) : undefined;
  }

  getAudio(url: string | undefined): AudioBuffer | undefined {
    return url ? this.resolvedAudio.get(url) : undefined;
  }

  getTexture(url: string | undefined): THREE.Texture | undefined {
    return url ? this.resolvedTexture.get(url) : undefined;
  }

  loadedAudio(): IterableIterator<[string, AudioBuffer]> {
    return this.resolvedAudio.entries();
  }

  /** Resolve uma URL relativa à base do app (usado também por vídeos de tela, que não passam pelo preload). */
  resolve(url: string): string {
    if (/^(https?:|data:|blob:|\/)/.test(url)) return url;
    return `${this.baseUrl.replace(/\/?$/, '/')}${url.replace(/^\.\//, '')}`;
  }
}

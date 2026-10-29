import * as THREE from 'three';

export type UpdateFn = (deltaTime: number, elapsed: number) => void;
export type RenderFn = (deltaTime: number) => void;
export type ResizeFn = (width: number, height: number) => void;

export interface EngineOptions {
  /** Teto de pixel ratio (retrô não precisa de 3x). */
  maxPixelRatio?: number;
  /** Teto do delta time em segundos (evita saltos após aba inativa). */
  maxDeltaTime?: number;
}

/**
 * Loop principal: canvas, WebGLRenderer, resize e delta time.
 * Não conhece a narrativa — os sistemas se registram via `onUpdate`
 * (em ordem de prioridade) e um único `setRenderer` desenha o quadro.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private readonly updates: { fn: UpdateFn; priority: number }[] = [];
  private readonly resizes = new Set<ResizeFn>();
  private renderFn: RenderFn | null = null;
  private readonly resizeObserver: ResizeObserver;
  private lastTime = -1;
  private _elapsed = 0;
  private _running = false;
  private _fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private readonly maxDelta: number;
  private readonly maxPixelRatio: number;
  /** Resolução fixa do quadro (exportação); null = acompanha o container. */
  private renderSize: { width: number; height: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
    options: EngineOptions = {},
  ) {
    this.maxDelta = options.maxDeltaTime ?? 0.25;
    this.maxPixelRatio = options.maxPixelRatio ?? 1.5;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.canvas = this.renderer.domElement;
    this.canvas.classList.add('engine-canvas');
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 400);
    this.camera.position.set(0, 2, 8);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get elapsed(): number {
    return this._elapsed;
  }

  get running(): boolean {
    return this._running;
  }

  get fps(): number {
    return this._fps;
  }

  /** Registra um sistema. Prioridades menores rodam primeiro. */
  onUpdate(fn: UpdateFn, priority = 0): () => void {
    const entry = { fn, priority };
    this.updates.push(entry);
    this.updates.sort((a, b) => a.priority - b.priority);
    return () => {
      const i = this.updates.indexOf(entry);
      if (i >= 0) this.updates.splice(i, 1);
    };
  }

  onResize(fn: ResizeFn): () => void {
    this.resizes.add(fn);
    const { width, height } = this.renderSize ?? this.size();
    fn(width, height);
    return () => {
      this.resizes.delete(fn);
    };
  }

  /**
   * Fixa a resolução do quadro em pixels reais (pixel ratio 1), independente do
   * tamanho do container — o canvas continua esticado na tela. null volta ao normal.
   */
  setRenderSize(size: { width: number; height: number } | null): void {
    this.renderSize = size ? { ...size } : null;
    this.resize();
  }

  setRenderer(fn: RenderFn): void {
    this.renderFn = fn;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this.lastTime = -1;
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  stop(): void {
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
  }

  /** Executa um único quadro com delta fixo (útil para testes/captura). */
  tick(deltaTime: number): void {
    this.step(deltaTime);
  }

  private frame(now: number): void {
    const t = now / 1000;
    const dt = this.lastTime < 0 ? 0 : Math.min(t - this.lastTime, this.maxDelta);
    this.lastTime = t;
    this.step(dt);

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this._fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  }

  private step(dt: number): void {
    this._elapsed += dt;
    for (const u of this.updates) u.fn(dt, this._elapsed);
    if (this.renderFn) this.renderFn(dt);
    else this.renderer.render(new THREE.Scene(), this.camera);
  }

  private size(): { width: number; height: number } {
    return {
      width: Math.max(1, this.container.clientWidth),
      height: Math.max(1, this.container.clientHeight),
    };
  }

  private resize(): void {
    const { width, height } = this.renderSize ?? this.size();
    this.renderer.setPixelRatio(this.renderSize ? 1 : Math.min(window.devicePixelRatio, this.maxPixelRatio));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    for (const fn of this.resizes) fn(width, height);
  }
}

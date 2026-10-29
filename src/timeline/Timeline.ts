import { clamp } from '../utils/math';

export type TimelineEventType = 'play' | 'pause' | 'seek' | 'end' | 'rate' | 'duration';

export interface TimelineSnapshot {
  time: number;
  duration: number;
  playing: boolean;
  rate: number;
  loop: boolean;
}

/**
 * Relógio mestre da narrativa.
 *
 * Desacoplado da GPU: avança apenas pelo delta time real recebido em
 * `update(deltaTime)` (segundos medidos com relógio de alta resolução),
 * nunca por contagem de quadros — a narrativa dura o mesmo em 30 ou 144 FPS.
 * Não conhece Three.js: só fornece `time` para o ActionRegistry.
 */
export class Timeline {
  private _time = 0;
  private _duration = 0;
  private _rate = 1;
  private _playing = false;
  private _loop = false;
  /** Incrementa a cada descontinuidade (seek, loop) — usado pelo áudio para ressincronizar. */
  private _discontinuity = 0;

  private readonly listeners = new Map<TimelineEventType, Set<(s: TimelineSnapshot) => void>>();

  get time(): number {
    return this._time;
  }
  get duration(): number {
    return this._duration;
  }
  get playing(): boolean {
    return this._playing;
  }
  get rate(): number {
    return this._rate;
  }
  get loop(): boolean {
    return this._loop;
  }
  get discontinuity(): number {
    return this._discontinuity;
  }
  get progress(): number {
    return this._duration > 0 ? this._time / this._duration : 0;
  }

  snapshot(): TimelineSnapshot {
    return {
      time: this._time,
      duration: this._duration,
      playing: this._playing,
      rate: this._rate,
      loop: this._loop,
    };
  }

  setDuration(duration: number): void {
    this._duration = Math.max(0, duration);
    if (this._time > this._duration) this.seek(this._duration);
    this.emit('duration');
  }

  setLoop(loop: boolean): void {
    this._loop = loop;
  }

  play(): void {
    if (this._playing) return;
    if (this._duration > 0 && this._time >= this._duration) {
      this._time = 0;
      this._discontinuity++;
    }
    this._playing = true;
    this.emit('play');
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    this.emit('pause');
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  stop(): void {
    this.pause();
    this.seek(0);
  }

  /** Salta para qualquer instante (frente ou trás). O estado é recalculado pelo ActionRegistry. */
  seek(time: number): void {
    this._time = clamp(time, 0, this._duration);
    this._discontinuity++;
    this.emit('seek');
  }

  step(delta: number): void {
    this.seek(this._time + delta);
  }

  setRate(rate: number): void {
    this._rate = clamp(rate, 0.05, 8);
    this.emit('rate');
  }

  /**
   * Avança o relógio pelo delta time real (segundos).
   * Retorna o tempo atual da timeline.
   */
  update(deltaTime: number): number {
    if (!this._playing || deltaTime <= 0) return this._time;

    let t = this._time + deltaTime * this._rate;
    if (t >= this._duration) {
      if (this._loop && this._duration > 0) {
        t %= this._duration;
        this._discontinuity++;
      } else {
        this._time = this._duration;
        this._playing = false;
        this.emit('end');
        this.emit('pause');
        return this._time;
      }
    }
    this._time = t;
    return t;
  }

  on(type: TimelineEventType, fn: (s: TimelineSnapshot) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  private emit(type: TimelineEventType): void {
    const set = this.listeners.get(type);
    if (!set) return;
    const snap = this.snapshot();
    set.forEach((fn) => fn(snap));
  }
}

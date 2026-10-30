/**
 * Medidor de loudness integrado no estilo do ITU-R BS.1770: K-weighting em dois
 * estágios, energia somada entre os canais e gating em blocos de 400 ms (silêncio
 * não puxa a medida para baixo). Serve para levar o vídeo exportado ao alvo de
 * -14 LUFS, o mesmo usado por Spotify/YouTube/Instagram; não é medição certificada.
 */

export const LOUDNESS_TARGET = -14;
/** Dentro desta distância do alvo (LU) o vídeo já está bom: não vale refazer a gravação. */
const LOUDNESS_TOLERANCE = 1;
/** Limita o ganho de correção: mais que isso só evidenciaria ruído. */
const MAX_MAKEUP_DB = 18;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = 10;
/** Um bloco de 400 ms são quatro passos de 100 ms (sobreposição de 75%). */
const STEPS_PER_BLOCK = 4;

const blockLoudness = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

/** Ganho linear que leva `lufs` ao alvo; null se já está perto ou se não há o que corrigir (silêncio). */
export function makeupGain(lufs: number | null): number | null {
  if (lufs === null || !Number.isFinite(lufs) || lufs < ABSOLUTE_GATE) return null;
  const delta = LOUDNESS_TARGET - lufs;
  if (Math.abs(delta) <= LOUDNESS_TOLERANCE) return null;
  return 10 ** (Math.min(delta, MAX_MAKEUP_DB) / 20);
}

/** Biquad direto (Direct Form I), coeficientes já normalizados por a0. */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  /** Shelf agudo (RBJ cookbook) — estágio 1 do K-weighting: +4 dB acima de ~1.68 kHz. */
  highShelf(freq: number, dBgain: number, shelfSlope: number, sampleRate: number): void {
    const A = 10 ** (dBgain / 40);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cosw0 = Math.cos(w0);
    const alpha = (Math.sin(w0) / 2) * Math.sqrt((A + 1 / A) * (1 / shelfSlope - 1) + 2);
    const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
    const a0 = A + 1 - (A - 1) * cosw0 + sqrtA2alpha;
    this.b0 = (A * (A + 1 + (A - 1) * cosw0 + sqrtA2alpha)) / a0;
    this.b1 = (-2 * A * (A - 1 + (A + 1) * cosw0)) / a0;
    this.b2 = (A * (A + 1 + (A - 1) * cosw0 - sqrtA2alpha)) / a0;
    this.a1 = (2 * (A - 1 - (A + 1) * cosw0)) / a0;
    this.a2 = (A + 1 - (A - 1) * cosw0 - sqrtA2alpha) / a0;
  }

  /** Passa-altas (RBJ cookbook) — estágio 2 do K-weighting: ~38 Hz. */
  highPass(freq: number, q: number, sampleRate: number): void {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cosw0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cosw0) / 2 / a0;
    this.b1 = -(1 + cosw0) / a0;
    this.b2 = (1 + cosw0) / 2 / a0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export class LoudnessMeter {
  private readonly filters: { stage1: Biquad; stage2: Biquad }[] = [];
  private readonly stepLength: number;
  /** Energia média de cada passo de 100 ms completo. */
  private readonly steps: number[] = [];
  private stepEnergy = 0;
  private stepCount = 0;

  constructor(sampleRate: number, channels = 1) {
    this.stepLength = Math.round(sampleRate / 10);
    for (let c = 0; c < channels; c++) {
      const stage1 = new Biquad();
      const stage2 = new Biquad();
      // Parâmetros de referência do BS.1770 (pivot ~1681.97 Hz, +4 dB; passa-altas ~38.14 Hz, Q~0.5003).
      stage1.highShelf(1681.9744509555319, 3.999843853973347, 1, sampleRate);
      stage2.highPass(38.13547087602444, 0.5003270373238773, sampleRate);
      this.filters.push({ stage1, stage2 });
    }
  }

  /** Alimenta um bloco de amostras (-1..1), um array por canal, todos do mesmo tamanho. */
  feed(...channels: Float32Array[]): void {
    const length = channels[0]?.length ?? 0;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels.length; c++) {
        const { stage1, stage2 } = this.filters[c];
        const s = stage2.process(stage1.process(channels[c][i]));
        this.stepEnergy += s * s;
      }
      if (++this.stepCount === this.stepLength) {
        this.steps.push(this.stepEnergy / this.stepCount);
        this.stepEnergy = 0;
        this.stepCount = 0;
      }
    }
  }

  /** LUFS integrado. `null` se nada foi medido ou se é curto demais para um bloco; -Infinity se tudo ficou abaixo do gate. */
  get integrated(): number | null {
    if (this.steps.length < STEPS_PER_BLOCK) return null;
    const blocks: number[] = [];
    for (let i = 0; i + STEPS_PER_BLOCK <= this.steps.length; i++) {
      const block = this.steps.slice(i, i + STEPS_PER_BLOCK).reduce((s, v) => s + v, 0) / STEPS_PER_BLOCK;
      if (block > 0 && blockLoudness(block) > ABSOLUTE_GATE) blocks.push(block);
    }
    if (!blocks.length) return -Infinity;
    const mean = (list: number[]) => list.reduce((s, v) => s + v, 0) / list.length;
    const threshold = blockLoudness(mean(blocks)) - RELATIVE_GATE;
    const kept = blocks.filter((b) => blockLoudness(b) > threshold);
    return blockLoudness(mean(kept));
  }
}

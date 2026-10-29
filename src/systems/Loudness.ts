/**
 * Medidor de loudness integrado — aproximação do ITU-R BS.1770 (pré-filtro
 * K-weighting em dois estágios + RMS), sem o "gating" em blocos de 400 ms do
 * padrão completo. Serve para orientar o nível do vídeo exportado (alvo de
 * referência: -14 LUFS, o mesmo usado por Spotify/YouTube/Instagram), não
 * como medição certificada.
 */

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
  private readonly stage1 = new Biquad();
  private readonly stage2 = new Biquad();
  private sumSquares = 0;
  private count = 0;

  constructor(sampleRate: number) {
    // Parâmetros de referência do BS.1770 (pivot ~1681.97 Hz, +4 dB; passa-altas ~38.14 Hz, Q~0.5003).
    this.stage1.highShelf(1681.9744509555319, 3.999843853973347, 1, sampleRate);
    this.stage2.highPass(38.13547087602444, 0.5003270373238773, sampleRate);
  }

  /** Alimenta um bloco de amostras mono (-1..1). */
  feed(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const s = this.stage2.process(this.stage1.process(samples[i]));
      this.sumSquares += s * s;
      this.count++;
    }
  }

  /** LUFS integrado aproximado (sem gating). `null` se nada foi medido. */
  get integrated(): number | null {
    if (this.count === 0) return null;
    const meanSquare = this.sumSquares / this.count;
    if (meanSquare <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(meanSquare);
  }
}

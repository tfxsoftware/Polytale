import { describe, expect, it } from 'vitest';
import { LoudnessMeter } from './Loudness';

describe('LoudnessMeter', () => {
  it('reports null before anything is fed', () => {
    expect(new LoudnessMeter(48000).integrated).toBeNull();
  });

  it('a full-scale 1 kHz sine measures close to the known ~-3.7 LUFS reference', () => {
    const sampleRate = 48000;
    const meter = new LoudnessMeter(sampleRate);
    const seconds = 1;
    const samples = new Float32Array(sampleRate * seconds);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    meter.feed(samples);
    // K-weighting is ~unity gain at 1 kHz, so this should land near -0.691 + 10*log10(0.5) ≈ -3.70 LUFS.
    expect(meter.integrated).toBeGreaterThan(-5);
    expect(meter.integrated).toBeLessThan(-2.5);
  });

  it('a quieter signal measures lower than a louder one', () => {
    const sampleRate = 48000;
    const loud = new LoudnessMeter(sampleRate);
    const quiet = new LoudnessMeter(sampleRate);
    const n = sampleRate;
    const loudSamples = new Float32Array(n);
    const quietSamples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.sin((2 * Math.PI * 500 * i) / sampleRate);
      loudSamples[i] = s;
      quietSamples[i] = s * 0.1;
    }
    loud.feed(loudSamples);
    quiet.feed(quietSamples);
    expect(loud.integrated! > quiet.integrated!).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const sampleRate = 44100;
    const samples = new Float32Array(2000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 300 * i) / sampleRate) * 0.4;
    const a = new LoudnessMeter(sampleRate);
    const b = new LoudnessMeter(sampleRate);
    a.feed(samples);
    b.feed(samples);
    expect(a.integrated).toBe(b.integrated);
  });
});

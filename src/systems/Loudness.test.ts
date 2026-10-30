import { describe, expect, it } from 'vitest';
import { LOUDNESS_TARGET, LoudnessMeter, makeupGain } from './Loudness';

describe('LoudnessMeter', () => {
  it('reports null before anything is fed', () => {
    expect(new LoudnessMeter(48000).integrated).toBeNull();
  });

  const sine = (seconds: number, amplitude: number, sampleRate = 48000) =>
    Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * amplitude);

  it('stereo with the same signal on both channels reads ~3 LU above mono, as in BS.1770', () => {
    const mono = new LoudnessMeter(48000);
    const stereo = new LoudnessMeter(48000, 2);
    const samples = sine(1, 0.5);
    mono.feed(samples);
    stereo.feed(samples, samples);
    expect(stereo.integrated! - mono.integrated!).toBeCloseTo(3.01, 1);
  });

  it('silence between lines does not lower the reading (gating)', () => {
    const continuous = new LoudnessMeter(48000);
    const gappy = new LoudnessMeter(48000);
    continuous.feed(sine(4, 0.3));
    gappy.feed(sine(2, 0.3));
    gappy.feed(new Float32Array(48000 * 6));
    gappy.feed(sine(2, 0.3));
    expect(Math.abs(gappy.integrated! - continuous.integrated!)).toBeLessThan(0.5);
  });

  it('pure silence measures -Infinity', () => {
    const meter = new LoudnessMeter(48000);
    meter.feed(new Float32Array(48000));
    expect(meter.integrated).toBe(-Infinity);
  });

  it('makeupGain moves the reading to the target and leaves close or silent mixes alone', () => {
    const quiet = new LoudnessMeter(48000);
    const samples = sine(2, 0.05);
    quiet.feed(samples);
    const gain = makeupGain(quiet.integrated)!;
    const fixed = new LoudnessMeter(48000);
    fixed.feed(samples.map((s) => s * gain));
    expect(fixed.integrated!).toBeCloseTo(LOUDNESS_TARGET, 1);

    expect(makeupGain(LOUDNESS_TARGET + 0.5)).toBeNull();
    expect(makeupGain(-Infinity)).toBeNull();
    expect(makeupGain(null)).toBeNull();
    expect(makeupGain(-8)).toBeLessThan(1);
    expect(makeupGain(-60)).toBeCloseTo(10 ** (18 / 20));
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
    const samples = new Float32Array(sampleRate);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 300 * i) / sampleRate) * 0.4;
    const a = new LoudnessMeter(sampleRate);
    const b = new LoudnessMeter(sampleRate);
    a.feed(samples);
    b.feed(samples);
    expect(a.integrated).not.toBeNull();
    expect(a.integrated).toBe(b.integrated);
  });
});

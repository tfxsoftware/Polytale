import { describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline';

describe('Timeline', () => {
  it('avança pelo delta time vezes a velocidade', () => {
    const t = new Timeline();
    t.setDuration(10);
    t.setRate(2);
    t.play();
    expect(t.update(0.5)).toBe(1);
  });

  it('não avança pausado', () => {
    const t = new Timeline();
    t.setDuration(10);
    expect(t.update(1)).toBe(0);
  });

  it('para no fim e emite end', () => {
    const t = new Timeline();
    const onEnd = vi.fn();
    t.on('end', onEnd);
    t.setDuration(2);
    t.play();
    t.update(5);
    expect(t.time).toBe(2);
    expect(t.playing).toBe(false);
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('em loop volta ao início e marca descontinuidade', () => {
    const t = new Timeline();
    t.setDuration(2);
    t.setLoop(true);
    t.play();
    const before = t.discontinuity;
    expect(t.update(2.5)).toBeCloseTo(0.5);
    expect(t.discontinuity).toBe(before + 1);
  });

  it('seek limita ao intervalo [0, duração]', () => {
    const t = new Timeline();
    t.setDuration(5);
    t.seek(99);
    expect(t.time).toBe(5);
    t.seek(-3);
    expect(t.time).toBe(0);
  });

  it('play no fim recomeça do zero', () => {
    const t = new Timeline();
    t.setDuration(3);
    t.seek(3);
    t.play();
    expect(t.time).toBe(0);
  });
});

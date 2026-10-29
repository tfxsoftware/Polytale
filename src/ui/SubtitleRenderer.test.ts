import { describe, expect, it } from 'vitest';
import type { ActiveDialogue } from '../timeline/types';
import { SUBTITLE_DEFAULTS, revealState } from './SubtitleRenderer';

function dialogue(text: string, localTime: number, speakDuration = 4): ActiveDialogue {
  return { key: 'd', actorId: 'a', text, volume: 1, start: 0, speakDuration, localTime, subtitle: true };
}

describe('revealState', () => {
  it('typewriter (default): reveals the full line letter by letter', () => {
    const d = dialogue('Are you guys okay', 0);
    const early = revealState(d, SUBTITLE_DEFAULTS);
    expect(early.text).toBe('Are you guys okay');
    expect(early.revealed).toBeLessThan(d.text.length);
    expect(early.done).toBe(false);

    const late = revealState(dialogue('Are you guys okay', 10), SUBTITLE_DEFAULTS);
    expect(late.revealed).toBe(d.text.length);
    expect(late.done).toBe(true);
  });

  it("mode 'words': groups of maxWords, revealed whole-word by whole-word", () => {
    const style = { ...SUBTITLE_DEFAULTS, mode: 'words' as const, maxWords: 2 };
    const text = 'Are you guys okay';

    // No início da fala: primeiro grupo ("Are you"), ao menos a primeira palavra revelada.
    const start = revealState(dialogue(text, 0), style);
    expect(start.text).toBe('Are you');
    expect(start.revealed).toBeGreaterThanOrEqual('Are'.length);
    expect(start.revealed).toBeLessThan(start.text.length);

    // As duas palavras do primeiro grupo já foram ditas, mas o segundo grupo ainda não começou.
    const midFirstGroup = revealState(dialogue(text, 1.0), style);
    expect(midFirstGroup.text).toBe('Are you');
    expect(midFirstGroup.revealed).toBe('Are you'.length);

    // Depois do fim da fala: último grupo ("guys okay"), tudo revelado, done.
    const end = revealState(dialogue(text, 10), style);
    expect(end.text).toBe('guys okay');
    expect(end.revealed).toBe('guys okay'.length);
    expect(end.done).toBe(true);
  });

  it("mode 'chunk': each group appears whole, no progressive reveal", () => {
    const style = { ...SUBTITLE_DEFAULTS, mode: 'chunk' as const, maxWords: 2 };
    const text = 'Are you guys okay';

    const start = revealState(dialogue(text, 0), style);
    expect(start.text).toBe('Are you');
    expect(start.revealed).toBe('Are you'.length);
    expect(start.done).toBe(false);

    const end = revealState(dialogue(text, 10), style);
    expect(end.text).toBe('guys okay');
    expect(end.revealed).toBe('guys okay'.length);
    expect(end.done).toBe(true);
  });

  it('is a pure function of its inputs (seek-safe: same local time always yields the same result)', () => {
    const style = { ...SUBTITLE_DEFAULTS, mode: 'words' as const, maxWords: 3 };
    const a = revealState(dialogue('one two three four five six', 1.3), style);
    const b = revealState(dialogue('one two three four five six', 1.3), style);
    expect(a).toEqual(b);
  });
});

import { describe, expect, it } from 'vitest';
import { ScriptHistory } from './ScriptHistory';

const v = (n: number) => ({ meta: { title: `v${n}` }, timeline: [] });

describe('ScriptHistory', () => {
  it('desfaz e refaz na ordem', () => {
    const h = new ScriptHistory();
    h.reset(v(0));
    h.record(v(1));
    h.record(v(2));
    expect(h.undo()).toEqual(v(1));
    expect(h.undo()).toEqual(v(0));
    expect(h.undo()).toBeNull();
    expect(h.redo()).toEqual(v(1));
    expect(h.redo()).toEqual(v(2));
    expect(h.redo()).toBeNull();
  });

  it('uma nova mudança descarta o que foi desfeito', () => {
    const h = new ScriptHistory();
    h.reset(v(0));
    h.record(v(1));
    h.undo();
    h.record(v(2));
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toEqual(v(0));
  });

  it('ignora versões idênticas à atual', () => {
    const h = new ScriptHistory();
    h.reset(v(0));
    h.record(v(0));
    expect(h.canUndo).toBe(false);
  });

  it('guarda cópias, não referências', () => {
    const h = new ScriptHistory();
    const script = v(0);
    h.reset(script);
    h.record(v(1));
    script.meta.title = 'mutado';
    expect(h.undo()).toEqual(v(0));
  });

  it('respeita o limite', () => {
    const h = new ScriptHistory(2);
    h.reset(v(0));
    for (let i = 1; i <= 5; i++) h.record(v(i));
    expect(h.undo()).toEqual(v(4));
    expect(h.undo()).toEqual(v(3));
    expect(h.undo()).toBeNull();
  });

  it('agrupa mudanças rápidas da mesma origem', () => {
    let t = 0;
    const h = new ScriptHistory(100, () => t);
    h.reset(v(0));
    h.record(v(1), 'slider');
    t = 200;
    h.record(v(2), 'slider');
    t = 400;
    h.record(v(3), 'slider');
    expect(h.undo()).toEqual(v(0));
    expect(h.canUndo).toBe(false);
  });

  it('não agrupa origens diferentes nem mudanças espaçadas', () => {
    let t = 0;
    const h = new ScriptHistory(100, () => t);
    h.reset(v(0));
    h.record(v(1), 'slider');
    t = 5000;
    h.record(v(2), 'slider');
    h.record(v(3), 'outro');
    expect(h.undo()).toEqual(v(2));
    expect(h.undo()).toEqual(v(1));
    expect(h.undo()).toEqual(v(0));
  });
});

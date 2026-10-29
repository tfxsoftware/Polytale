import { describe, expect, it } from 'vitest';
import { ActionRegistry, StoryScriptError } from './ActionRegistry';
import { compileProject, evaluateProject, type CompiledProject } from './StoryProject';
import { defaultScript } from '../config/defaultScript';

/** Todos os roteiros de exemplo do repositório (novos arquivos entram automaticamente). */
const examples = import.meta.glob<unknown>('../../examples/*.json', { eager: true, import: 'default' });

const scripts: [string, unknown][] = [['defaultScript', defaultScript], ...Object.entries(examples)];

function compileErrors(registry: ActionRegistry, raw: unknown): string[] {
  try {
    compileProject(registry, raw);
    return [];
  } catch (err) {
    if (err instanceof StoryScriptError) return err.errors;
    throw err;
  }
}

/** Instantes de amostragem: início, fim e pontos espalhados (inclui fronteiras de capítulo). */
function sampleTimes(project: CompiledProject, count = 24): number[] {
  const times = new Set<number>([0, project.duration]);
  for (let i = 1; i < count; i++) times.add((project.duration * i) / count);
  for (const c of project.chapters) {
    times.add(c.start);
    times.add(Math.max(0, c.start - 0.01));
  }
  return [...times].sort((a, b) => a - b);
}

describe.each(scripts)('%s', (_name, raw) => {
  const registry = new ActionRegistry();

  it('compila sem erros', () => {
    expect(compileErrors(registry, raw)).toEqual([]);
  });

  it('tem duração positiva e marcadores dentro dela', () => {
    const project = compileProject(registry, raw);
    expect(project.duration).toBeGreaterThan(0);
    for (const m of project.markers) {
      expect(m.time).toBeGreaterThanOrEqual(0);
      expect(m.time).toBeLessThanOrEqual(project.duration + 1e-6);
    }
  });

  it('é reversível: o estado em t não depende do caminho até t', () => {
    const project = compileProject(registry, raw);
    const times = sampleTimes(project);
    // Referência: cada instante avaliado num registro "limpo".
    const fresh = times.map((t) => evaluateProject(new ActionRegistry(), compileProject(new ActionRegistry(), raw), t).frame);

    // Para frente, para trás e embaralhado no mesmo projeto compilado.
    const forward = times.map((t) => evaluateProject(registry, project, t).frame);
    const backward = [...times].reverse().map((t) => evaluateProject(registry, project, t).frame).reverse();
    const shuffled = times.map((_, i) => (i * 7) % times.length);
    const jumping: unknown[] = [];
    for (const i of shuffled) jumping[i] = evaluateProject(registry, project, times[i]).frame;

    expect(forward).toEqual(fresh);
    expect(backward).toEqual(fresh);
    expect(jumping).toEqual(fresh);
  });

  it('não altera o roteiro de entrada', () => {
    const before = structuredClone(raw);
    const project = compileProject(registry, raw);
    for (const t of sampleTimes(project, 8)) evaluateProject(registry, project, t);
    expect(raw).toEqual(before);
  });
});

describe('validação', () => {
  const registry = new ActionRegistry();

  it('rejeita algo que não é objeto', () => {
    expect(compileErrors(registry, 42)).toEqual(['o StoryScript deve ser um objeto JSON']);
  });

  it('exige meta.title e timeline ou chapters', () => {
    const errors = compileErrors(registry, { meta: {} });
    expect(errors).toContain(`'meta.title' é obrigatório`);
    expect(errors).toContain(`informe 'timeline' (cena única) ou 'chapters' (capítulos)`);
  });

  it('não aceita timeline e chapters juntos', () => {
    const errors = compileErrors(registry, { meta: { title: 'x' }, timeline: [], chapters: [{ title: 'a', timeline: [] }] });
    expect(errors).toContain(`use 'timeline' OU 'chapters', não os dois`);
  });

  it('valida as legendas', () => {
    const errors = compileErrors(registry, { meta: { title: 'x' }, timeline: [], subtitles: { style: 'nope', size: -1 } });
    expect(errors.some((e) => e.startsWith(`'subtitles.style' inválido`))).toBe(true);
    expect(errors).toContain(`'subtitles.size' deve ser um número > 0`);
  });

  it('aceita as posições novas e valida a margem', () => {
    for (const position of ['center', 'speaker']) {
      expect(compileErrors(registry, { meta: { title: 'x' }, timeline: [], subtitles: { position, margin: 40 } })).toEqual([]);
    }
    const errors = compileErrors(registry, { meta: { title: 'x' }, timeline: [], subtitles: { margin: -5 } });
    expect(errors).toContain(`'subtitles.margin' deve ser um número >= 0`);
  });

  it('prefixa erros com o capítulo', () => {
    const errors = compileErrors(registry, {
      meta: { title: 'x' },
      chapters: [{ title: 'Um', timeline: [{ time: 0, type: 'NAO_EXISTE' }] }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.startsWith('capítulo 1 (Um): '))).toBe(true);
  });
});

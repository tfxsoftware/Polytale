import { ActionRegistry, StoryScriptError, type CompileOptions, type CompiledStory } from './ActionRegistry';
import { SUBTITLE_POSITIONS, SUBTITLE_STYLES, type ChapterDef, type EventType, type FrameState, type StoryScript } from './types';
import { clamp01 } from '../utils/math';

/** Duração das transições em fade entre capítulos (cada metade). */
const CHAPTER_FADE = 0.6;
/** Tempo em que a cartela de título fica na tela. */
export const TITLE_CARD_DURATION = 3;

export interface CompiledChapter {
  index: number;
  title: string;
  story: CompiledStory;
  /** Início do capítulo no tempo global. */
  start: number;
  duration: number;
  transition: 'fade' | 'cut';
  showTitle: boolean;
}

export interface ProjectMarker {
  time: number;
  type: EventType | 'CHAPTER';
  label: string;
}

/** História completa: um ou mais capítulos tocados em sequência num único relógio. */
export interface CompiledProject {
  script: StoryScript;
  chapters: CompiledChapter[];
  duration: number;
  markers: ProjectMarker[];
  warnings: string[];
}

export interface ProjectFrame {
  chapter: CompiledChapter;
  /** Estado do capítulo no tempo local (frame.time é local ao capítulo). */
  frame: FrameState;
  /** Cartela de título ativa (null se nenhuma). */
  titleCard: { title: string; subtitle: string; progress: number } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Converte o script em um StoryScript independente por capítulo (herdando o topo). */
export function chapterScripts(script: StoryScript): { def: ChapterDef; script: StoryScript }[] {
  if (!script.chapters?.length) {
    const def: ChapterDef = { title: script.meta.title, timeline: script.timeline ?? [], duration: script.meta.duration, showTitle: false };
    return [{ def, script }];
  }
  return script.chapters.map((def) => ({
    def,
    script: {
      meta: { title: def.title, duration: def.duration },
      scene: def.scene ?? script.scene,
      fx: def.fx ?? script.fx,
      cameras: def.cameras ?? script.cameras,
      gestures: { ...(script.gestures ?? {}), ...(def.gestures ?? {}) },
      cast: script.cast,
      timeline: def.timeline,
    },
  }));
}

function validateProjectStructure(raw: unknown): string[] {
  if (!isObj(raw)) return ['o StoryScript deve ser um objeto JSON'];
  const errs: string[] = [];
  if (!isObj(raw.meta) || typeof raw.meta.title !== 'string') errs.push(`'meta.title' é obrigatório`);
  const hasTimeline = Array.isArray(raw.timeline);
  const hasChapters = Array.isArray(raw.chapters);
  if (!hasTimeline && !hasChapters) errs.push(`informe 'timeline' (cena única) ou 'chapters' (capítulos)`);
  if (hasTimeline && hasChapters) errs.push(`use 'timeline' OU 'chapters', não os dois`);
  if (hasChapters) {
    const chapters = raw.chapters as unknown[];
    if (!chapters.length) errs.push(`'chapters' não pode ser vazio`);
    chapters.forEach((c, i) => {
      if (!isObj(c)) return errs.push(`chapters[${i}]: deve ser um objeto`);
      if (typeof c.title !== 'string') errs.push(`chapters[${i}]: 'title' é obrigatório`);
      if (!Array.isArray(c.timeline)) errs.push(`chapters[${i}]: 'timeline' deve ser um array`);
      if (c.transition !== undefined && c.transition !== 'fade' && c.transition !== 'cut') errs.push(`chapters[${i}]: 'transition' deve ser 'fade' ou 'cut'`);
    });
  }
  if (raw.subtitles !== undefined) errs.push(...validateSubtitles(raw.subtitles));
  if (raw.cast !== undefined) {
    if (!isObj(raw.cast)) errs.push(`'cast' deve ser um objeto { id: definição }`);
    else
      for (const [id, def] of Object.entries(raw.cast)) {
        if (!isObj(def) || (def.kind !== 'actor' && def.kind !== 'prop')) errs.push(`cast.${id}: 'kind' deve ser 'actor' ou 'prop'`);
      }
  }
  return errs;
}

function validateSubtitles(s: unknown): string[] {
  if (!isObj(s)) return [`'subtitles' deve ser um objeto`];
  const errs: string[] = [];
  const oneOf = (field: string, list: readonly string[]) => {
    if (s[field] !== undefined && !list.includes(String(s[field]))) errs.push(`'subtitles.${field}' inválido (use ${list.join(', ')})`);
  };
  oneOf('style', SUBTITLE_STYLES);
  oneOf('position', SUBTITLE_POSITIONS);
  for (const f of ['enabled', 'showName', 'typewriter']) {
    if (s[f] !== undefined && typeof s[f] !== 'boolean') errs.push(`'subtitles.${f}' deve ser true ou false`);
  }
  for (const f of ['color', 'background', 'border', 'font']) {
    if (s[f] !== undefined && typeof s[f] !== 'string') errs.push(`'subtitles.${f}' deve ser uma string`);
  }
  if (s.size !== undefined && (typeof s.size !== 'number' || !(s.size > 0))) errs.push(`'subtitles.size' deve ser um número > 0`);
  if (s.margin !== undefined && (typeof s.margin !== 'number' || !(s.margin >= 0))) errs.push(`'subtitles.margin' deve ser um número >= 0`);
  return errs;
}

/** Valida e compila todos os capítulos. Erros vêm prefixados com o capítulo. */
export function compileProject(registry: ActionRegistry, raw: unknown, options: CompileOptions = {}): CompiledProject {
  const structural = validateProjectStructure(raw);
  if (structural.length) throw new StoryScriptError(structural);
  const script = raw as StoryScript;
  const multi = !!script.chapters?.length;

  const errors: string[] = [];
  const warnings: string[] = [];
  const chapters: CompiledChapter[] = [];
  const markers: ProjectMarker[] = [];
  let start = 0;

  chapterScripts(script).forEach(({ def, script: chapterScript }, index) => {
    const prefix = multi ? `capítulo ${index + 1} (${def.title}): ` : '';
    try {
      const story = registry.compile(chapterScript, options);
      warnings.push(...story.warnings.map((w) => prefix + w));
      const chapter: CompiledChapter = {
        index,
        title: def.title,
        story,
        start,
        duration: story.duration,
        transition: def.transition ?? 'fade',
        showTitle: multi && (def.showTitle ?? true),
      };
      chapters.push(chapter);
      if (multi) markers.push({ time: start, type: 'CHAPTER', label: `Capítulo ${index + 1}: ${def.title}` });
      for (const m of story.markers) markers.push({ ...m, time: m.time + start });
      start += story.duration;
    } catch (err) {
      if (err instanceof StoryScriptError) errors.push(...err.errors.map((e) => prefix + e));
      else errors.push(prefix + (err instanceof Error ? err.message : String(err)));
    }
  });

  if (errors.length) throw new StoryScriptError(errors);
  return { script, chapters, duration: start, markers, warnings };
}

export function chapterAt(project: CompiledProject, time: number): CompiledChapter {
  let found = project.chapters[0];
  for (const c of project.chapters) if (c.start <= time) found = c;
  return found;
}

/** Estado completo no tempo global: capítulo ativo + frame local + transições/cartela. */
export function evaluateProject(registry: ActionRegistry, project: CompiledProject, time: number): ProjectFrame {
  const chapter = chapterAt(project, time);
  const local = Math.min(Math.max(0, time - chapter.start), chapter.duration);
  const frame = registry.evaluate(chapter.story, local);

  // Chaves de áudio únicas entre capítulos.
  for (const d of frame.dialogues) d.key = `c${chapter.index}:${d.key}`;
  for (const s of frame.sounds) s.key = `c${chapter.index}:${s.key}`;

  // Transições: escurece no fim do capítulo e clareia no começo do próximo.
  const next = project.chapters[chapter.index + 1];
  let fade = 0;
  if (chapter.index > 0 && chapter.transition === 'fade') fade = Math.max(fade, 1 - clamp01(local / CHAPTER_FADE));
  if (next && next.transition === 'fade') fade = Math.max(fade, clamp01((local - (chapter.duration - CHAPTER_FADE)) / CHAPTER_FADE));
  if (fade > frame.fx.fade) {
    frame.fx.fade = fade;
    frame.fx.fadeColor = [0, 0, 0];
  }

  const titleCard =
    chapter.showTitle && local < TITLE_CARD_DURATION
      ? { title: chapter.title, subtitle: `Capítulo ${chapter.index + 1}`, progress: local / TITLE_CARD_DURATION }
      : null;

  return { chapter, frame, titleCard };
}

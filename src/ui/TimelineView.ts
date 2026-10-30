import { estimateSpeechDuration, type StoryEvent, type StoryScript } from '../timeline/types';

export interface TimelineViewCallbacks {
  /** Aplica um script editado. Retorna erros de validação (vazio = ok). */
  onChange(script: StoryScript, keepChapterTime: number): Promise<string[]>;
  /** Pula para um tempo local do capítulo exibido. */
  onSeek(chapterIndex: number, localTime: number): void;
  onOpen?(): void;
}

type Category = 'camera' | 'dialogue' | 'body' | 'object' | 'fx' | 'sound' | 'light';

const CATEGORY: Record<StoryEvent['type'], Category> = {
  SPAWN_OBJECT: 'object',
  DESPAWN_OBJECT: 'object',
  TRANSFORM_OBJECT: 'object',
  PLAY_AUDIO_WITH_LIPSYNC: 'dialogue',
  CAMERA_CUT: 'camera',
  CAMERA_TRANSITION: 'camera',
  CAMERA_SHAKE: 'camera',
  SET_LIGHT: 'light',
  SET_LOOK_TARGET: 'body',
  SET_EXPRESSION: 'body',
  PLAY_GESTURE: 'body',
  SET_POSE: 'body',
  REACH: 'body',
  ATTACH_OBJECT: 'object',
  DETACH_OBJECT: 'object',
  INTERACT: 'body',
  PLAY_ANIMATION: 'body',
  SET_RETRO_FX: 'fx',
  SET_STYLE: 'fx',
  SET_TIME_OF_DAY: 'fx',
  FADE_SCREEN: 'fx',
  FLASH_SCREEN: 'fx',
  PLAY_SOUND: 'sound',
  SHOW_TITLE: 'fx',
};

const DEFAULT_DURATION: Partial<Record<StoryEvent['type'], number>> = {
  CAMERA_TRANSITION: 1.5,
  CAMERA_SHAKE: 1.2,
  SET_EXPRESSION: 0.35,
  PLAY_GESTURE: 1.3,
  SET_POSE: 0.6,
  REACH: 0.5,
  INTERACT: 2.5,
  FADE_SCREEN: 1,
  FLASH_SCREEN: 0.35,
  PLAY_SOUND: 3,
  ATTACH_OBJECT: 0.15,
  DETACH_OBJECT: 0.4,
};

/** Modelos mínimos para "Adicionar evento". `target` é preenchido com a trilha escolhida. */
const TEMPLATES: Record<string, (target: string) => Record<string, unknown>> = {
  PLAY_AUDIO_WITH_LIPSYNC: (t) => ({ type: 'PLAY_AUDIO_WITH_LIPSYNC', target: t, text: 'Nova fala.' }),
  CAMERA_CUT: (t) => ({ type: 'CAMERA_CUT', preset: 'close_up', subject: t }),
  CAMERA_TRANSITION: (t) => ({ type: 'CAMERA_TRANSITION', preset: 'two_shot', subject: t, duration: 1.5 }),
  CAMERA_SHAKE: () => ({ type: 'CAMERA_SHAKE', intensity: 0.5 }),
  SET_EXPRESSION: (t) => ({ type: 'SET_EXPRESSION', target: t, expression: 'happy' }),
  PLAY_GESTURE: (t) => ({ type: 'PLAY_GESTURE', target: t, gesture: 'nod' }),
  SET_LOOK_TARGET: (t) => ({ type: 'SET_LOOK_TARGET', target: t, lookAt: 'camera' }),
  SET_POSE: (t) => ({ type: 'SET_POSE', target: t, pose: 'armsCrossed' }),
  TRANSFORM_OBJECT: (t) => ({ type: 'TRANSFORM_OBJECT', target: t, position: [0, 0, 0], duration: 1.5 }),
  FADE_SCREEN: () => ({ type: 'FADE_SCREEN', to: 1, duration: 1 }),
  FLASH_SCREEN: () => ({ type: 'FLASH_SCREEN' }),
  PLAY_SOUND: () => ({ type: 'PLAY_SOUND', src: 'procedural:chime' }),
};

interface Lane {
  key: string;
  label: string;
  events: number[];
}

const PX_MIN = 20;
const PX_MAX = 240;
const LANE_H = 30;

function eventDuration(ev: StoryEvent): number {
  if (typeof ev.duration === 'number' && ev.duration > 0) return ev.duration;
  if (ev.type === 'PLAY_AUDIO_WITH_LIPSYNC') return estimateSpeechDuration(ev.text ?? '') + (ev.hold ?? 0.5);
  return DEFAULT_DURATION[ev.type] ?? 0;
}

function laneOf(ev: StoryEvent): { key: string; label: string } {
  const cat = CATEGORY[ev.type] ?? 'fx';
  if (cat === 'camera') return { key: '#camera', label: 'Câmera' };
  if (cat === 'fx') return { key: '#fx', label: 'Tela / céu' };
  if (cat === 'sound') return { key: '#sound', label: 'Som' };
  const target = 'target' in ev && typeof ev.target === 'string' ? ev.target : '?';
  if (cat === 'light') return { key: `light:${target}`, label: `luz: ${target}` };
  return { key: `obj:${target}`, label: target };
}

function summary(ev: StoryEvent): string {
  switch (ev.type) {
    case 'PLAY_AUDIO_WITH_LIPSYNC':
      return `“${ev.text}”`;
    case 'CAMERA_CUT':
    case 'CAMERA_TRANSITION':
      return `${ev.type === 'CAMERA_CUT' ? 'corte' : 'trans.'} ${ev.shot ?? ev.preset ?? ''}${ev.subject ? ` ${ev.subject}` : ''}`;
    case 'SET_EXPRESSION':
      return ev.expression;
    case 'PLAY_GESTURE':
      return `gesto ${ev.gesture}`;
    case 'SET_POSE':
      return `pose ${typeof ev.pose === 'string' ? ev.pose : 'custom'}`;
    case 'INTERACT':
      return `${ev.interaction}${ev.with ? ` → ${ev.with}` : ''}`;
    case 'REACH':
      return ev.to === null ? 'recolhe mão' : 'alcança';
    case 'SET_LOOK_TARGET':
      return `olha ${Array.isArray(ev.lookAt) ? 'ponto' : ev.lookAt ?? 'livre'}`;
    case 'SPAWN_OBJECT':
      return 'aparece';
    case 'DESPAWN_OBJECT':
      return 'some';
    case 'TRANSFORM_OBJECT':
      return ev.position ? 'move' : 'gira';
    case 'SET_LIGHT':
      return `luz ${ev.intensity ?? ''}`;
    case 'PLAY_SOUND':
      return ev.src.replace('procedural:', '♪ ');
    case 'FADE_SCREEN':
      return ev.to > 0.5 ? 'fade out' : 'fade in';
    case 'SET_TIME_OF_DAY':
      return `${ev.hour}h`;
    default:
      return ev.type.toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * Editor visual da timeline: uma trilha por alvo (câmera, cada ator, efeitos, som),
 * blocos arrastáveis (muda `time`), inspetor JSON por evento, adicionar/duplicar/
 * excluir, régua clicável (seek) e zoom. Cada mudança recompila a história.
 */
export class TimelineView {
  private readonly root: HTMLDivElement;
  private readonly chapterSelect: HTMLSelectElement;
  private readonly lanesEl: HTMLDivElement;
  private readonly labelsEl: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly ruler: HTMLDivElement;
  private readonly playhead: HTMLDivElement;
  private readonly inspector: HTMLTextAreaElement;
  private readonly inspectorTitle: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly addType: HTMLSelectElement;

  private script: StoryScript | null = null;
  private chapter = 0;
  private selected: number | null = null;
  private pxPerSec = 60;
  private lanes: Lane[] = [];
  private applying: Promise<void> = Promise.resolve();

  constructor(
    parent: HTMLElement,
    private readonly cb: TimelineViewCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'tl-view';
    this.root.hidden = true;

    const bar = document.createElement('div');
    bar.className = 'tl-bar';
    const title = document.createElement('strong');
    title.textContent = 'TRILHAS';
    this.chapterSelect = document.createElement('select');
    this.chapterSelect.setAttribute('aria-label', 'Capítulo');
    this.addType = document.createElement('select');
    this.addType.setAttribute('aria-label', 'Tipo de evento');
    for (const t of Object.keys(TEMPLATES)) this.addType.append(new Option(t, t));
    const addBtn = this.button('+ evento', 'Adicionar evento na trilha selecionada, no tempo atual');
    const dupBtn = this.button('Duplicar', 'Duplicar evento selecionado (Ctrl+D)');
    const delBtn = this.button('Excluir', 'Excluir evento selecionado (Delete)');
    const zoom = document.createElement('input');
    zoom.type = 'range';
    zoom.min = String(PX_MIN);
    zoom.max = String(PX_MAX);
    zoom.value = String(this.pxPerSec);
    zoom.setAttribute('aria-label', 'Zoom');
    this.status = document.createElement('div');
    this.status.className = 'tl-status';
    const close = this.button('✕', 'Fechar (T)');
    bar.append(title, this.chapterSelect, this.addType, addBtn, dupBtn, delBtn, zoom, this.status, close);

    const body = document.createElement('div');
    body.className = 'tl-body';
    this.labelsEl = document.createElement('div');
    this.labelsEl.className = 'tl-labels';
    this.scroller = document.createElement('div');
    this.scroller.className = 'tl-scroller';
    this.ruler = document.createElement('div');
    this.ruler.className = 'tl-ruler';
    this.lanesEl = document.createElement('div');
    this.lanesEl.className = 'tl-lanes';
    this.playhead = document.createElement('div');
    this.playhead.className = 'tl-playhead';
    this.scroller.append(this.ruler, this.lanesEl, this.playhead);

    const insp = document.createElement('div');
    insp.className = 'tl-inspector';
    this.inspectorTitle = document.createElement('div');
    this.inspectorTitle.className = 'tl-insp-title';
    this.inspectorTitle.textContent = 'Selecione um evento';
    this.inspector = document.createElement('textarea');
    this.inspector.className = 'editor-text';
    this.inspector.spellcheck = false;
    this.inspector.setAttribute('aria-label', 'JSON do evento');
    const applyBtn = this.button('Aplicar', 'Aplicar JSON do evento (Ctrl+Enter)', 'is-primary');
    insp.append(this.inspectorTitle, this.inspector, applyBtn);

    body.append(this.labelsEl, this.scroller, insp);
    this.root.append(bar, body);
    parent.appendChild(this.root);

    close.addEventListener('click', () => this.close());
    this.chapterSelect.addEventListener('change', () => {
      this.chapter = Number(this.chapterSelect.value);
      this.selected = null;
      this.render();
    });
    zoom.addEventListener('input', () => {
      this.pxPerSec = Number(zoom.value);
      this.render();
    });
    this.scroller.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.pxPerSec = Math.min(PX_MAX, Math.max(PX_MIN, this.pxPerSec * (e.deltaY < 0 ? 1.15 : 0.87)));
        zoom.value = String(this.pxPerSec);
        this.render();
      },
      { passive: false },
    );
    this.ruler.addEventListener('pointerdown', (e) => {
      const rect = this.ruler.getBoundingClientRect();
      this.cb.onSeek(this.chapter, Math.max(0, (e.clientX - rect.left) / this.pxPerSec));
    });
    addBtn.addEventListener('click', () => this.addEvent());
    dupBtn.addEventListener('click', () => this.duplicate());
    delBtn.addEventListener('click', () => this.remove());
    applyBtn.addEventListener('click', () => this.applyInspector());
    this.inspector.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.applyInspector();
      }
      e.stopPropagation();
    });
    this.root.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
      // Só consome as teclas próprias; o resto (T, espaço, setas...) segue para os atalhos globais.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        this.remove();
      } else if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        this.duplicate();
      }
    });
    this.root.tabIndex = -1;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(script: StoryScript, chapter: number): void {
    this.root.hidden = false;
    this.cb.onOpen?.();
    this.setScript(script, chapter);
  }

  close(): void {
    this.root.hidden = true;
  }

  toggle(script: StoryScript, chapter: number): void {
    if (this.isOpen) this.close();
    else this.open(script, chapter);
  }

  /** Atualiza o script exibido (ex.: depois de aplicar no editor JSON). */
  setScript(script: StoryScript, chapter = this.chapter): void {
    this.script = structuredClone(script);
    const chapters = this.script.chapters ?? [];
    this.chapterSelect.replaceChildren(
      ...(chapters.length ? chapters.map((c, i) => new Option(`${i + 1}. ${c.title}`, String(i))) : [new Option(this.script.meta?.title ?? 'Cena', '0')]),
    );
    this.chapter = Math.min(chapter, Math.max(0, chapters.length - 1));
    this.chapterSelect.value = String(this.chapter);
    this.chapterSelect.disabled = chapters.length < 2;
    this.selected = null;
    this.render();
  }

  /** Move o cursor de reprodução (tempo local do capítulo exibido). */
  setPlayhead(chapterIndex: number, localTime: number): void {
    if (!this.isOpen) return;
    const visible = chapterIndex === this.chapter;
    this.playhead.hidden = !visible;
    if (visible) this.playhead.style.left = `${localTime * this.pxPerSec}px`;
    this.playheadTime = visible ? localTime : 0;
  }

  private playheadTime = 0;

  /* ---------------------------------------------------------------------- */

  private timeline(): StoryEvent[] {
    if (!this.script) return [];
    if (this.script.chapters?.length) return this.script.chapters[this.chapter]?.timeline ?? [];
    return (this.script.timeline ??= []);
  }

  private render(): void {
    const events = this.timeline();
    const laneMap = new Map<string, Lane>();
    const order = ['#camera'];
    laneMap.set('#camera', { key: '#camera', label: 'Câmera', events: [] });
    events.forEach((ev, i) => {
      if (!ev || typeof ev !== 'object') return;
      const { key, label } = laneOf(ev);
      if (!laneMap.has(key)) {
        laneMap.set(key, { key, label, events: [] });
        order.push(key);
      }
      laneMap.get(key)!.events.push(i);
    });
    // Efeitos e som no fim.
    const rank = (k: string) => (k === '#camera' ? 0 : k === '#fx' ? 3 : k === '#sound' ? 4 : k.startsWith('light:') ? 2 : 1);
    this.lanes = order.map((k) => laneMap.get(k)!).sort((a, b) => rank(a.key) - rank(b.key));

    const end = Math.max(10, ...events.map((e) => (e?.time ?? 0) + eventDuration(e))) + 3;
    const width = end * this.pxPerSec;
    this.ruler.style.width = this.lanesEl.style.width = `${width}px`;

    // Régua
    const step = this.pxPerSec >= 120 ? 0.5 : this.pxPerSec >= 50 ? 1 : this.pxPerSec >= 30 ? 2 : 5;
    const ticks: HTMLElement[] = [];
    for (let t = 0; t <= end; t += step) {
      const tick = document.createElement('div');
      tick.className = 'tl-tick';
      tick.style.left = `${t * this.pxPerSec}px`;
      tick.textContent = Number.isInteger(t) ? `${t}s` : '';
      ticks.push(tick);
    }
    this.ruler.replaceChildren(...ticks);

    this.labelsEl.replaceChildren(
      ...this.lanes.map((l) => {
        const el = document.createElement('div');
        el.className = 'tl-label';
        el.textContent = l.label;
        el.title = l.label;
        return el;
      }),
    );

    const blocks: HTMLElement[] = [];
    this.lanes.forEach((lane, li) => {
      const row = document.createElement('div');
      row.className = 'tl-row';
      row.style.top = `${li * LANE_H}px`;
      row.style.width = `${width}px`;
      blocks.push(row);
      for (const idx of lane.events) blocks.push(this.block(events[idx], idx, li));
    });
    this.lanesEl.style.height = `${this.lanes.length * LANE_H}px`;
    this.lanesEl.replaceChildren(...blocks);
    this.refreshInspector();
  }

  private block(ev: StoryEvent, index: number, laneIndex: number): HTMLElement {
    const el = document.createElement('div');
    const dur = eventDuration(ev);
    el.className = `tl-block cat-${CATEGORY[ev.type] ?? 'fx'}${index === this.selected ? ' is-selected' : ''}`;
    el.dataset.index = String(index);
    el.style.left = `${(ev.time ?? 0) * this.pxPerSec}px`;
    el.style.top = `${laneIndex * LANE_H + 3}px`;
    el.style.width = `${Math.max(10, dur * this.pxPerSec)}px`;
    el.textContent = summary(ev);
    el.title = `${ev.time.toFixed(2)}s · ${ev.type}\n${summary(ev)}`;

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(index);
      const startX = e.clientX;
      const startTime = ev.time ?? 0;
      let moved = false;
      el.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        const dt = (m.clientX - startX) / this.pxPerSec;
        if (Math.abs(m.clientX - startX) > 2) moved = true;
        const snap = m.shiftKey ? 0.5 : 0.05;
        const t = Math.max(0, Math.round((startTime + dt) / snap) * snap);
        ev.time = Number(t.toFixed(3));
        el.style.left = `${ev.time * this.pxPerSec}px`;
        this.status.textContent = `${ev.time.toFixed(2)}s`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (moved) this.commit(`movido para ${ev.time.toFixed(2)}s`);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => this.cb.onSeek(this.chapter, ev.time ?? 0));
    return el;
  }

  private select(index: number | null): void {
    this.selected = index;
    // Só alterna classes (sem re-render): o bloco pode estar sendo arrastado.
    this.lanesEl.querySelectorAll<HTMLElement>('.tl-block').forEach((b) => b.classList.toggle('is-selected', Number(b.dataset.index) === index));
    this.refreshInspector();
    this.root.focus({ preventScroll: true });
  }

  private refreshInspector(): void {
    const ev = this.selected !== null ? this.timeline()[this.selected] : undefined;
    if (!ev) {
      this.inspectorTitle.textContent = 'Selecione um evento';
      this.inspector.value = '';
      this.inspector.disabled = true;
      return;
    }
    this.inspector.disabled = false;
    this.inspectorTitle.textContent = `#${this.selected} · ${ev.type}`;
    if (document.activeElement !== this.inspector) this.inspector.value = JSON.stringify(ev, null, 2);
  }

  private applyInspector(): void {
    if (this.selected === null) return;
    try {
      const parsed = JSON.parse(this.inspector.value) as StoryEvent;
      this.timeline()[this.selected] = parsed;
      this.inspector.blur();
      this.commit('evento atualizado');
    } catch (err) {
      this.status.textContent = `JSON inválido: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private addEvent(): void {
    const lane = this.selected !== null ? laneOf(this.timeline()[this.selected]) : null;
    const target = lane && lane.key.startsWith('obj:') ? lane.key.slice(4) : this.firstActor();
    const make = TEMPLATES[this.addType.value];
    if (!make) return;
    const ev = { time: Number(this.playheadTime.toFixed(2)), ...make(target) } as unknown as StoryEvent;
    const tl = this.timeline();
    tl.push(ev);
    this.selected = tl.length - 1;
    this.commit(`${ev.type} adicionado`);
  }

  private duplicate(): void {
    if (this.selected === null) return;
    const tl = this.timeline();
    const copy = structuredClone(tl[this.selected]);
    copy.time = Number((copy.time + 0.5).toFixed(3));
    tl.push(copy);
    this.selected = tl.length - 1;
    this.commit('evento duplicado');
  }

  private remove(): void {
    if (this.selected === null) return;
    this.timeline().splice(this.selected, 1);
    this.selected = null;
    this.commit('evento excluído');
  }

  private firstActor(): string {
    for (const ev of this.timeline()) if (ev?.type === 'SPAWN_OBJECT' && ev.object?.kind === 'actor') return ev.target;
    const cast = Object.entries(this.script?.cast ?? {}).find(([, d]) => d.kind === 'actor');
    return cast?.[0] ?? 'ator';
  }

  /** Recompila com o script editado (serializado: uma aplicação por vez). */
  private commit(message: string): void {
    if (!this.script) return;
    const snapshot = structuredClone(this.script);
    this.render();
    this.applying = this.applying.then(async () => {
      const errors = await this.cb.onChange(snapshot, this.playheadTime);
      this.status.textContent = errors.length ? `⚠ ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1})` : ''}` : `✓ ${message}`;
      this.status.title = errors.join('\n');
      this.status.classList.toggle('is-error', errors.length > 0);
    });
  }

  private button(label: string, title: string, className = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `cp-btn ${className}`.trim();
    b.textContent = label;
    b.title = title;
    return b;
  }
}

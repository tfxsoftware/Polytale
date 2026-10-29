import type { ActiveDialogue, AspectRatio, SubtitleDef } from '../timeline/types';
import { SUBTITLE_DEFAULTS, drawSubtitles, resolveSubtitles } from './SubtitleRenderer';

export interface SettingsPanelCallbacks {
  /** Novo bloco `subtitles` do roteiro (undefined = tudo no padrão). */
  onSubtitlesChange(def: SubtitleDef | undefined): void;
  /** Novo `meta.aspect` (undefined = tela inteira). */
  onAspectChange(aspect: AspectRatio | undefined): void;
}

const ASPECTS: [string, string][] = [
  ['', 'Tela inteira'],
  ['16:9', '16:9 (paisagem)'],
  ['9:16', '9:16 (Reels, TikTok)'],
  ['1:1', '1:1 (quadrado)'],
];

const FONTS: [string, string][] = [
  ['VT323', 'Pixel (VT323)'],
  ['monospace', 'Monoespaçada'],
  ['sans-serif', 'Sem serifa'],
  ['serif', 'Com serifa'],
  ['Georgia', 'Georgia'],
  ['Impact', 'Impact'],
  ['Comic Sans MS', 'Comic Sans'],
];

const DEFAULT_BG = '#12163c';
const DEFAULT_BG_ALPHA = 0.92;

const PREVIEW_LINE: ActiveDialogue = {
  key: 'preview',
  actorId: 'preview',
  text: 'Assim ficam as legendas da história.',
  volume: 1,
  start: 0,
  speakDuration: 1,
  localTime: 2,
  subtitle: true,
};

/** '#rgb', '#rrggbb', 'rgb()' ou 'rgba()' -> { hex, alpha }. */
function parseColor(value: string | undefined): { hex: string; alpha: number } | null {
  if (!value) return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return { hex: `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase(), alpha: 1 };
  if (/^#[0-9a-f]{6}$/i.test(value)) return { hex: value.toLowerCase(), alpha: 1 };
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  if (!rgb) return null;
  const hex = `#${[rgb[1], rgb[2], rgb[3]].map((c) => Math.min(255, Number(c)).toString(16).padStart(2, '0')).join('')}`;
  return { hex, alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Painel "Opções" (botão ⚙ / tecla O): formato do vídeo (`meta.aspect`) e
 * visual das legendas com prévia ao vivo (bloco `subtitles` do roteiro).
 */
export class SettingsPanel {
  private readonly root: HTMLDivElement;
  private readonly preview: HTMLCanvasElement;
  private readonly aspect: HTMLSelectElement;
  private def: SubtitleDef = {};
  private readonly controls: {
    enabled: HTMLInputElement;
    style: HTMLSelectElement;
    position: HTMLSelectElement;
    margin: HTMLInputElement;
    marginOut: HTMLOutputElement;
    showName: HTMLInputElement;
    mode: HTMLSelectElement;
    typewriter: HTMLInputElement;
    maxWords: HTMLInputElement;
    maxWordsOut: HTMLOutputElement;
    size: HTMLInputElement;
    sizeOut: HTMLOutputElement;
    font: HTMLSelectElement;
    color: HTMLInputElement;
    background: HTMLInputElement;
    opacity: HTMLInputElement;
    opacityOut: HTMLOutputElement;
    border: HTMLInputElement;
  };
  private readonly boxOnly: HTMLElement[] = [];
  private readonly dependent: HTMLElement[] = [];
  private readonly typewriterOnly: HTMLElement[] = [];
  private readonly groupedOnly: HTMLElement[] = [];
  private marginRow!: HTMLLabelElement;
  private readonly marginLabel: HTMLSpanElement;

  constructor(
    parent: HTMLElement,
    private readonly cb: SettingsPanelCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'settings-panel';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Opções');

    const head = document.createElement('div');
    head.className = 'settings-head';
    const title = document.createElement('h2');
    title.textContent = 'Opções';
    const close = this.button('✕', 'Fechar (Esc)');
    close.addEventListener('click', () => this.close());
    head.append(title, close);
    const section = (text: string) => {
      const h = document.createElement('h3');
      h.textContent = text;
      return h;
    };

    this.preview = document.createElement('canvas');
    this.preview.className = 'settings-preview';
    this.preview.setAttribute('aria-hidden', 'true');

    const check = () => {
      const i = document.createElement('input');
      i.type = 'checkbox';
      return i;
    };
    const select = (options: [string, string][]) => {
      const s = document.createElement('select');
      s.append(...options.map(([v, label]) => new Option(label, v)));
      return s;
    };
    const range = (min: number, max: number, step: number) => {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = String(min);
      r.max = String(max);
      r.step = String(step);
      return r;
    };
    const color = () => {
      const c = document.createElement('input');
      c.type = 'color';
      return c;
    };

    this.controls = {
      enabled: check(),
      style: select([
        ['box', 'Caixa (RPG)'],
        ['plain', 'Texto (cinema)'],
        ['outline', 'Contorno + sombra'],
      ]),
      position: select([
        ['bottom', 'Embaixo'],
        ['top', 'Em cima'],
        ['center', 'No centro'],
        ['speaker', 'Sobre quem fala (balão)'],
      ]),
      margin: range(0, 200, 4),
      marginOut: document.createElement('output'),
      showName: check(),
      mode: select([
        ['typewriter', 'Letra a letra'],
        ['words', 'Grupos de palavras (TikTok)'],
        ['chunk', 'Blocos de frase'],
      ]),
      typewriter: check(),
      maxWords: range(1, 8, 1),
      maxWordsOut: document.createElement('output'),
      size: range(0.6, 2, 0.1),
      sizeOut: document.createElement('output'),
      font: select(FONTS),
      color: color(),
      background: color(),
      opacity: range(0, 1, 0.05),
      opacityOut: document.createElement('output'),
      border: color(),
    };
    const c = this.controls;

    const rows = [
      this.row('Mostrar legendas', c.enabled),
      this.row('Estilo', c.style, 'dep'),
      this.row('Posição', c.position, 'dep'),
      (this.marginRow = this.row('Distância da borda', c.margin, 'dep', c.marginOut)),
      this.row('Nome de quem fala', c.showName, 'dep'),
      this.row('Revelação do texto', c.mode, 'dep'),
      this.row('Máquina de escrever', c.typewriter, 'typewriter'),
      this.row('Palavras por grupo', c.maxWords, 'words', c.maxWordsOut),
      this.row('Tamanho', c.size, 'dep', c.sizeOut),
      this.row('Fonte', c.font, 'dep'),
      this.row('Cor do texto', c.color, 'dep'),
      this.row('Fundo da caixa', c.background, 'box'),
      this.row('Opacidade do fundo', c.opacity, 'box', c.opacityOut),
      this.row('Borda da caixa', c.border, 'box'),
    ];

    this.marginLabel = this.marginRow.querySelector('span')!;

    const footer = document.createElement('div');
    footer.className = 'settings-footer';
    const reset = this.button('PADRÃO', 'Voltar ao visual padrão das legendas');
    reset.addEventListener('click', () => this.commit({}));
    const done = this.button('OK', 'Fechar');
    done.addEventListener('click', () => this.close());
    footer.append(reset, done);

    this.aspect = select(ASPECTS);
    const aspectRow = this.row('Formato do vídeo', this.aspect);
    aspectRow.title = 'Proporção da tela e do vídeo baixado (1080p)';
    this.aspect.addEventListener('change', () => this.cb.onAspectChange((this.aspect.value || undefined) as AspectRatio | undefined));

    this.root.append(head, section('Vídeo'), aspectRow, section('Legendas'), this.preview, ...rows, footer);
    parent.appendChild(this.root);

    const set = <K extends keyof SubtitleDef>(key: K, value: SubtitleDef[K]) => {
      const next = { ...this.def };
      if (value === undefined || value === SUBTITLE_DEFAULTS[key]) delete next[key];
      else next[key] = value;
      this.commit(next);
    };
    const bg = () => set('background', rgba(c.background.value, Number(c.opacity.value)));
    c.enabled.addEventListener('change', () => set('enabled', c.enabled.checked));
    c.style.addEventListener('change', () => set('style', c.style.value as SubtitleDef['style']));
    c.position.addEventListener('change', () => set('position', c.position.value as SubtitleDef['position']));
    c.margin.addEventListener('input', () => set('margin', Number(c.margin.value)));
    c.showName.addEventListener('change', () => set('showName', c.showName.checked));
    c.mode.addEventListener('change', () => set('mode', c.mode.value as SubtitleDef['mode']));
    c.typewriter.addEventListener('change', () => set('typewriter', c.typewriter.checked));
    c.maxWords.addEventListener('input', () => set('maxWords', Number(c.maxWords.value)));
    c.size.addEventListener('input', () => set('size', Number(c.size.value)));
    c.font.addEventListener('change', () => set('font', c.font.value));
    c.color.addEventListener('input', () => set('color', c.color.value));
    c.background.addEventListener('input', bg);
    c.opacity.addEventListener('input', bg);
    c.border.addEventListener('input', () => set('border', c.border.value));

    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    void document.fonts?.ready.then(() => this.drawPreview());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(current: SubtitleDef | undefined): void {
    this.def = { ...current };
    this.sync();
    this.root.hidden = false;
    this.controls.enabled.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Atualiza os controles sem mexer no foco (ex.: depois de desfazer). */
  refresh(current: SubtitleDef | undefined): void {
    this.def = { ...current };
    this.sync();
  }

  /** Reflete o `meta.aspect` do roteiro carregado. */
  setAspect(aspect: AspectRatio | undefined): void {
    this.aspect.value = aspect ?? '';
  }

  toggle(current: SubtitleDef | undefined): void {
    if (this.isOpen) this.close();
    else this.open(current);
  }

  private commit(next: SubtitleDef): void {
    this.def = next;
    this.sync();
    this.cb.onSubtitlesChange(Object.keys(next).length ? { ...next } : undefined);
  }

  /** Controles <- estado atual. */
  private sync(): void {
    const s = resolveSubtitles(this.def);
    const c = this.controls;
    c.enabled.checked = s.enabled;
    c.style.value = s.style;
    c.position.value = s.position;
    c.margin.value = String(s.margin);
    c.marginOut.textContent = `${s.margin}px`;
    // No centro não há borda de referência; no balão a distância é acima da cabeça.
    this.marginLabel.textContent = s.position === 'speaker' ? 'Altura do balão' : 'Distância da borda';
    c.showName.checked = s.showName;
    c.mode.value = s.mode;
    c.typewriter.checked = s.typewriter;
    c.maxWords.value = String(s.maxWords);
    c.maxWordsOut.textContent = String(s.maxWords);
    c.size.value = String(s.size);
    c.sizeOut.textContent = `${s.size.toFixed(1)}x`;
    if (!FONTS.some(([v]) => v === s.font)) c.font.append(new Option(s.font, s.font));
    c.font.value = s.font;
    c.color.value = parseColor(s.color)?.hex ?? '#e8ecff';
    const bg = parseColor(s.background);
    c.background.value = bg?.hex ?? DEFAULT_BG;
    c.opacity.value = String(bg?.alpha ?? DEFAULT_BG_ALPHA);
    c.opacityOut.textContent = `${Math.round(Number(c.opacity.value) * 100)}%`;
    c.border.value = parseColor(s.border)?.hex ?? '#c9d1ff';

    for (const el of this.dependent) el.classList.toggle('is-disabled', !s.enabled);
    for (const el of this.boxOnly) el.classList.toggle('is-disabled', !s.enabled || s.style !== 'box');
    for (const el of this.typewriterOnly) el.classList.toggle('is-disabled', !s.enabled || s.mode !== 'typewriter');
    for (const el of this.groupedOnly) el.classList.toggle('is-disabled', !s.enabled || s.mode === 'typewriter');
    this.marginRow.classList.toggle('is-disabled', !s.enabled || s.position === 'center');
    this.drawPreview();
  }

  private drawPreview(): void {
    const canvas = this.preview;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 296;
    const h = canvas.clientHeight || 96;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = resolveSubtitles(this.def);
    if (!style.enabled) {
      ctx.fillStyle = 'rgba(232, 236, 255, 0.6)';
      ctx.font = '20px VT323, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('(sem legendas)', w / 2, h / 2);
      return;
    }
    // Na prévia, o "personagem" do balão fica no meio da base.
    const anchor = () => ({ x: 0.5, y: 1 });
    drawSubtitles(ctx, { width: w, height: h, scale: 0.55, inset: 10, time: 0, anchor }, [PREVIEW_LINE], style, () => ({ name: 'Personagem', color: '#ffd166' }));
  }

  private row(label: string, control: HTMLElement, group?: 'dep' | 'box' | 'typewriter' | 'words', output?: HTMLOutputElement): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'settings-row';
    const text = document.createElement('span');
    text.textContent = label;
    row.append(text, control);
    if (output) row.append(output);
    if (group === 'dep') this.dependent.push(row);
    if (group === 'box') this.boxOnly.push(row);
    if (group === 'typewriter') {
      this.dependent.push(row);
      this.typewriterOnly.push(row);
    }
    if (group === 'words') {
      this.dependent.push(row);
      this.groupedOnly.push(row);
    }
    return row;
  }

  private button(label: string, title: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-btn';
    b.textContent = label;
    b.title = title;
    return b;
  }
}

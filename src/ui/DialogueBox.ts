import type { ActiveDialogue } from '../timeline/types';
import {
  SUBTITLE_DEFAULTS,
  caretVisible,
  drawSubtitles,
  revealedChars,
  subtitleInset,
  subtitleScale,
  visibleDialogues,
  type ScreenPoint,
  type SpeakerInfo,
  type SubtitleStyle,
} from './SubtitleRenderer';
import { drawWatermark, type WatermarkStyle } from './Watermark';

/** Espaço livre acima do painel de controle (px). */
const BOTTOM_INSET = 96;
const TOP_INSET = 24;

/**
 * Legendas na tela: um canvas por cima da cena, desenhado por `drawSubtitles`
 * (o mesmo código do vídeo exportado). O conteúdo é derivado do quadro
 * (seek-safe): voltar no tempo "desescreve".
 */
export class DialogueBox {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Texto para leitores de tela (o canvas não é acessível). */
  private readonly live: HTMLDivElement;
  private lastSignature = '';
  private style: SubtitleStyle = SUBTITLE_DEFAULTS;
  private watermark: WatermarkStyle | null = null;
  /** Quadro com formato fixo (meta.aspect): mesmas proporções do vídeo exportado. */
  private framed = false;

  constructor(
    parent: HTMLElement,
    private readonly speaker: (actorId: string) => SpeakerInfo,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dialogue-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d')!;
    this.live = document.createElement('div');
    this.live.className = 'sr-only';
    this.live.setAttribute('aria-live', 'polite');
    parent.append(this.canvas, this.live);
    // A fonte pixelada chega depois do primeiro desenho.
    void document.fonts?.ready.then(() => this.clear());
  }

  setStyle(style: SubtitleStyle): void {
    this.style = style;
    this.clear();
  }

  setWatermark(watermark: WatermarkStyle | null): void {
    this.watermark = watermark;
    this.clear();
  }

  setFramed(framed: boolean): void {
    this.framed = framed;
    this.clear();
  }

  /** `anchor`: topo da cabeça de cada ator na tela (usado com position 'speaker'). */
  render(dialogues: ActiveDialogue[], anchor?: (actorId: string) => ScreenPoint | null): void {
    const { style, canvas } = this;
    const visible = visibleDialogues(dialogues, style);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    const time = performance.now() / 1000;
    const caret = visible.length > 0 && caretVisible(time);
    // Balões seguem os atores: a posição (arredondada em px) entra na assinatura.
    const where = (d: ActiveDialogue) => {
      if (style.position !== 'speaker') return '';
      const a = anchor?.(d.actorId);
      return a ? `@${Math.round(a.x * w)},${Math.round(a.y * h)}` : '@-';
    };
    const signature = `${w}x${h}|${caret}|${visible.map((d) => `${d.key}:${revealedChars(d, style.typewriter)}${where(d)}`).join('|')}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = w / dpr;
    const height = h / dpr;
    // Com formato fixo, a legenda escala com o quadro (igual ao vídeo); sem ele, tamanho fixo em px.
    const scale = this.framed ? subtitleScale(width, height) : 1;
    const inset = this.framed ? subtitleInset(style.position, width, height, scale) : style.position === 'top' ? TOP_INSET : BOTTOM_INSET;
    drawSubtitles(this.ctx, { width, height, scale, inset, time, anchor }, visible, style, this.speaker);
    if (this.watermark) drawWatermark(this.ctx, width, height, this.watermark);

    const spoken = visible.map((d) => `${this.speaker(d.actorId).name}: ${d.text}`).join(' ');
    if (this.live.textContent !== spoken) this.live.textContent = spoken;
  }

  clear(): void {
    this.lastSignature = '';
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

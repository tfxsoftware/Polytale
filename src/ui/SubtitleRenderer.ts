import type { ActiveDialogue, SubtitleDef } from '../timeline/types';
import { clamp, clamp01 } from '../utils/math';

/**
 * Desenho das legendas num canvas 2D. É a única implementação: a tela
 * (DialogueBox), o vídeo exportado (Recorder) e a prévia do painel de
 * opções chamam `drawSubtitles`, então o visual é sempre o mesmo.
 */

export interface SpeakerInfo {
  name: string;
  color: string;
}

/** `subtitles` do roteiro com os padrões aplicados. */
export type SubtitleStyle = Required<Omit<SubtitleDef, 'background' | 'border'>> & Pick<SubtitleDef, 'background' | 'border'>;

export const SUBTITLE_DEFAULTS: SubtitleStyle = {
  enabled: true,
  style: 'box',
  position: 'bottom',
  margin: 0,
  showName: true,
  typewriter: true,
  size: 1,
  color: '#e8ecff',
  background: undefined,
  border: undefined,
  font: 'VT323',
};

const BOX_BORDER = '#c9d1ff';
const BOX_RING = '#1a1f45';
const CARET_COLOR = '#ffd166';

export function resolveSubtitles(def: SubtitleDef | undefined): SubtitleStyle {
  const out = { ...SUBTITLE_DEFAULTS };
  for (const [k, v] of Object.entries(def ?? {})) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Falas que devem aparecer na legenda. */
export function visibleDialogues(dialogues: ActiveDialogue[], style: SubtitleStyle): ActiveDialogue[] {
  return style.enabled ? dialogues.filter((d) => d.subtitle) : [];
}

/** Quantos caracteres da fala já foram "datilografados" no instante atual. */
export function revealedChars(d: ActiveDialogue, typewriter = true): number {
  if (!typewriter) return d.text.length;
  const reveal = clamp01(d.localTime / Math.max(0.05, d.speakDuration * 0.92));
  return Math.ceil(d.text.length * reveal);
}

/** Família CSS com fallback monoespaçado. */
export function fontStack(font: string): string {
  return `${/^[\w-]+$/.test(font) ? font : `'${font.replace(/'/g, '')}'`}, ui-monospace, monospace`;
}

/** O cursor ▼ pisca a cada 0.8 s. */
export function caretVisible(time: number): boolean {
  return time % 0.8 < 0.4;
}

/** Ponto na tela normalizado (0..1, y para baixo). */
export interface ScreenPoint {
  x: number;
  y: number;
}

export interface SubtitleLayout {
  width: number;
  height: number;
  /** Pixels por "pixel de design" (1 = tamanhos originais da caixa). */
  scale: number;
  /** Distância da borda (de baixo ou de cima, conforme `position`), antes da `margin` do estilo. */
  inset: number;
  /** Segundos, para o cursor piscar. */
  time: number;
  /**
   * Topo da cabeça de quem fala na tela (position 'speaker'). null = fora de
   * quadro; essas falas voltam para a base da tela.
   */
  anchor?: (actorId: string) => ScreenPoint | null;
}

interface MeasuredBox {
  d: ActiveDialogue;
  lines: string[];
  shown: string[];
  done: boolean;
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

export function drawSubtitles(
  ctx: CanvasRenderingContext2D,
  layout: SubtitleLayout,
  dialogues: ActiveDialogue[],
  style: SubtitleStyle,
  speaker: (actorId: string) => SpeakerInfo,
): void {
  if (!dialogues.length) return;
  const k = layout.scale;
  const plain = style.style === 'plain';
  const padX = plain ? 0 : 16 * k;
  const padTop = plain ? 0 : 10 * k;
  const padBottom = plain ? 0 : 12 * k;
  const edge = 16 * k;
  const gap = 8 * k;
  const margin = Math.max(0, style.margin) * k;
  const fullWidth = Math.min(880 * k, layout.width - edge * 2);
  const bubbleWidth = Math.min(420 * k, layout.width - edge * 2);
  const textSize = Math.round(28 * k * style.size);
  const lineHeight = textSize * 1.15;
  const nameSize = Math.round(24 * k * style.size);
  const nameBlock = style.showName ? nameSize + 2 * k : 0;
  const font = (size: number) => `${size}px ${fontStack(style.font)}`;

  ctx.save();

  /** Quebra o texto e mede a caixa. Balões (`fit`) encolhem até o tamanho do texto. */
  const measure = (d: ActiveDialogue, maxWidth: number, fit: boolean): MeasuredBox => {
    ctx.font = font(textSize);
    const lines = wrap(ctx, d.text, maxWidth - padX * 2);
    // Revela os caracteres linha a linha (máquina de escrever).
    let remaining = revealedChars(d, style.typewriter);
    const shown = lines.map((l) => {
      const part = l.slice(0, Math.max(0, remaining));
      remaining -= l.length + 1;
      return part;
    });
    let width = maxWidth;
    if (fit) {
      let content = Math.max(...lines.map((l) => ctx.measureText(l).width));
      if (style.showName) {
        ctx.font = font(nameSize);
        content = Math.max(content, ctx.measureText(speaker(d.actorId).name.toUpperCase()).width);
      }
      width = Math.min(maxWidth, Math.max(120 * k, content + padX * 2 + 24 * k));
    }
    const done = revealedChars(d, style.typewriter) >= d.text.length;
    return { d, lines, shown, done, width, height: padTop + padBottom + nameBlock + lines.length * lineHeight };
  };

  // Texto com sombra (box) ou contorno (plain).
  const ink = (text: string, tx: number, ty: number, color: string) => {
    if (plain) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4 * k;
      ctx.strokeStyle = '#000';
      ctx.strokeText(text, tx, ty);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillText(text, tx + 2 * k, ty + 2 * k);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, tx, ty);
  };

  /** Desenha uma caixa em (x, y). `tail` = ponta do balão (só no estilo box). */
  const drawBox = (box: MeasuredBox, x: number, y: number, tail?: ScreenPoint) => {
    const { d, lines, shown, done, width, height } = box;
    if (!plain) {
      const b = 3 * k;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(x + 6 * k, y + 6 * k, width, height);
      ctx.fillStyle = BOX_RING;
      ctx.fillRect(x - b, y - b, width + b * 2, height + b * 2);
      if (tail) {
        // Rabicho: contorno (borda), base opaca e o fundo por cima, como a caixa.
        const base = y + height - b;
        const half = 9 * k;
        const tx = clamp(tail.x, x + half + 6 * k, x + width - half - 6 * k);
        const triangle = (grow: number) => {
          ctx.beginPath();
          ctx.moveTo(tx - half - grow, base);
          ctx.lineTo(tx + half + grow, base);
          ctx.lineTo(tail.x, tail.y + grow);
          ctx.closePath();
          ctx.fill();
        };
        ctx.fillStyle = style.border ?? BOX_BORDER;
        triangle(b);
        ctx.fillStyle = BOX_RING;
        triangle(0);
        ctx.fillStyle = style.background ?? 'rgba(8, 10, 30, 0.92)';
        triangle(0);
      }
      if (style.background) ctx.fillStyle = style.background;
      else {
        const g = ctx.createLinearGradient(0, y, 0, y + height);
        g.addColorStop(0, 'rgba(18, 22, 60, 0.92)');
        g.addColorStop(1, 'rgba(8, 10, 30, 0.92)');
        ctx.fillStyle = g;
      }
      ctx.fillRect(x, y, width, height);
      ctx.strokeStyle = style.border ?? BOX_BORDER;
      ctx.lineWidth = b;
      ctx.strokeRect(x + b / 2, y + b / 2, width - b, height - b);
    }

    const center = x + width / 2;
    ctx.textBaseline = 'top';
    if (style.showName) {
      const info = speaker(d.actorId);
      ctx.font = font(nameSize);
      ctx.textAlign = plain ? 'center' : 'left';
      ink(info.name.toUpperCase(), plain ? center : x + padX, y + padTop, info.color);
    }
    ctx.font = font(textSize);
    ctx.textAlign = 'left';
    const textTop = y + padTop + nameBlock;
    let caretX = x + padX;
    shown.forEach((line, i) => {
      // Centralizado pela linha completa: o texto parcial não "anda" enquanto é datilografado.
      const lx = plain ? center - ctx.measureText(lines[i]).width / 2 : x + padX;
      ink(line, lx, textTop + i * lineHeight, style.color);
      caretX = lx + ctx.measureText(line).width;
    });
    if (!plain && done && caretVisible(layout.time)) {
      const caretSize = Math.round(18 * k * style.size);
      ctx.font = font(caretSize);
      ctx.fillStyle = CARET_COLOR;
      ctx.fillText('▼', caretX + 8 * k, textTop + (lines.length - 1) * lineHeight + (textSize - caretSize) * 0.6);
    }
  };

  /** Pilha de caixas largas centralizadas (embaixo, em cima ou no centro). */
  const drawStack = (list: ActiveDialogue[], position: 'bottom' | 'top' | 'center', extra = margin) => {
    if (!list.length) return;
    const boxes = list.map((d) => measure(d, fullWidth, false));
    const total = boxes.reduce((s, b) => s + b.height, 0) + gap * (boxes.length - 1);
    let y =
      position === 'top'
        ? layout.inset + extra
        : position === 'center'
          ? (layout.height - total) / 2
          : layout.height - layout.inset - extra - total;
    y = clamp(y, 0, Math.max(0, layout.height - total));
    const x = (layout.width - fullWidth) / 2;
    for (const box of boxes) {
      drawBox(box, x, y);
      y += box.height + gap;
    }
  };

  if (style.position !== 'speaker') drawStack(dialogues, style.position);
  else {
    // Balões sobre a cabeça de quem fala; quem está fora de quadro vai para a base.
    const offscreen: ActiveDialogue[] = [];
    const placed: Rect[] = [];
    const tailLength = plain ? 0 : 14 * k;
    for (const d of dialogues) {
      const a = layout.anchor?.(d.actorId);
      if (!a) {
        offscreen.push(d);
        continue;
      }
      const box = measure(d, bubbleWidth, true);
      const tip: ScreenPoint = { x: a.x * layout.width, y: a.y * layout.height - 6 * k - margin };
      const rect: Rect = {
        x: clamp(tip.x - box.width / 2, edge, layout.width - edge - box.width),
        y: tip.y - tailLength - box.height,
        width: box.width,
        height: box.height,
      };
      // Dois balões no mesmo lugar: o mais novo sobe.
      for (let guard = 0; guard < placed.length; guard++) {
        const hit = placed.find((p) => overlaps(rect, p, gap));
        if (!hit) break;
        rect.y = hit.y - gap - rect.height;
      }
      const top = clamp(rect.y, gap, Math.max(gap, layout.height - gap - rect.height));
      // O rabicho só aparece se o balão ficou logo acima da cabeça.
      const tail = !plain && top === rect.y && tip.y > top + rect.height ? tip : undefined;
      rect.y = top;
      placed.push(rect);
      drawBox(box, rect.x, rect.y, tail);
    }
    drawStack(offscreen, 'bottom', 0);
  }
  ctx.restore();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

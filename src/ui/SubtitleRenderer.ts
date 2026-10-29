import type { ActiveDialogue, SubtitleDef } from '../timeline/types';
import { clamp01 } from '../utils/math';

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

export interface SubtitleLayout {
  width: number;
  height: number;
  /** Pixels por "pixel de design" (1 = tamanhos originais da caixa). */
  scale: number;
  /** Distância da borda (de baixo ou de cima, conforme `position`). */
  inset: number;
  /** Segundos, para o cursor piscar. */
  time: number;
}

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
  const width = Math.min(880 * k, layout.width - 32 * k);
  const x = (layout.width - width) / 2;
  const textSize = Math.round(28 * k * style.size);
  const lineHeight = textSize * 1.15;
  const nameSize = Math.round(24 * k * style.size);
  const nameBlock = style.showName ? nameSize + 2 * k : 0;
  const font = (size: number) => `${size}px ${fontStack(style.font)}`;

  // Mede todas as caixas antes, para empilhar a partir do topo ou da base.
  ctx.save();
  const boxes = dialogues.map((d) => {
    ctx.font = font(textSize);
    const lines = wrap(ctx, d.text, width - padX * 2);
    // Revela os caracteres linha a linha (máquina de escrever).
    let remaining = revealedChars(d, style.typewriter);
    const shown = lines.map((l) => {
      const part = l.slice(0, Math.max(0, remaining));
      remaining -= l.length + 1;
      return part;
    });
    return { d, lines, shown, done: revealedChars(d, style.typewriter) >= d.text.length, height: padTop + padBottom + nameBlock + lines.length * lineHeight };
  });
  const gap = 8 * k;
  const total = boxes.reduce((s, b) => s + b.height, 0) + gap * (boxes.length - 1);
  let y = style.position === 'top' ? layout.inset : layout.height - layout.inset - total;

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

  for (const { d, lines, shown, done, height } of boxes) {
    if (!plain) {
      const b = 3 * k;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(x + 6 * k, y + 6 * k, width, height);
      ctx.fillStyle = BOX_RING;
      ctx.fillRect(x - b, y - b, width + b * 2, height + b * 2);
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

    ctx.textBaseline = 'top';
    if (style.showName) {
      const info = speaker(d.actorId);
      ctx.font = font(nameSize);
      ctx.textAlign = plain ? 'center' : 'left';
      ink(info.name.toUpperCase(), plain ? layout.width / 2 : x + padX, y + padTop, info.color);
    }
    ctx.font = font(textSize);
    ctx.textAlign = 'left';
    const textTop = y + padTop + nameBlock;
    let caretX = x + padX;
    shown.forEach((line, i) => {
      // Centralizado pela linha completa: o texto parcial não "anda" enquanto é datilografado.
      const lx = plain ? (layout.width - ctx.measureText(lines[i]).width) / 2 : x + padX;
      ink(line, lx, textTop + i * lineHeight, style.color);
      caretX = lx + ctx.measureText(line).width;
    });
    if (!plain && done && caretVisible(layout.time)) {
      const caretSize = Math.round(18 * k * style.size);
      ctx.font = font(caretSize);
      ctx.fillStyle = CARET_COLOR;
      ctx.fillText('▼', caretX + 8 * k, textTop + (lines.length - 1) * lineHeight + (textSize - caretSize) * 0.6);
    }
    y += height + gap;
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

import type { ActiveDialogue, SubtitleDef } from '../timeline/types';
import { clamp, clamp01 } from '../utils/math';

/**
 * Desenho das legendas num canvas 2D. É a única implementação: a tela
 * (DialogueBox), o vídeo exportado (Recorder) e a prévia do painel de
 * opções chamam `drawSubtitles`, então o visual é sempre o mesmo.
 */

export interface SpeakerInfo {
  name: string;
  /** Cor do nome (balão/etiqueta). */
  color: string;
  /** Overrides opcionais por ator (`ActorObjectDef.subtitle`) para o corpo do texto falado. */
  font?: string;
  textColor?: string;
  size?: number;
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
  mode: 'typewriter',
  maxWords: 3,
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

interface WordTiming {
  word: string;
  /** Segundos desde o início da fala (`localTime`). */
  start: number;
  end: number;
}

/**
 * Duração de cada palavra, proporcional ao seu tamanho (mesmo peso usado por
 * `estimateSpeechDuration`), somando `totalDuration`. Função pura — mesmas
 * entradas sempre produzem a mesma divisão (seek-safe).
 */
function wordTimings(text: string, totalDuration: number): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const weights = words.map((w) => Math.max(1, w.length));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  let t = 0;
  return words.map((word, i) => {
    const start = t;
    t += (weights[i] / totalWeight) * totalDuration;
    return { word, start, end: t };
  });
}

interface WordGroup {
  words: WordTiming[];
  start: number;
}

function groupWords(timings: WordTiming[], maxWords: number): WordGroup[] {
  const groups: WordGroup[] = [];
  const n = Math.max(1, Math.floor(maxWords));
  for (let i = 0; i < timings.length; i += n) {
    const slice = timings.slice(i, i + n);
    groups.push({ words: slice, start: slice[0].start });
  }
  return groups;
}

/** Texto e revelação a desenhar neste instante, conforme `style.mode`. Exportado para testes. */
export function revealState(d: ActiveDialogue, style: SubtitleStyle): { text: string; revealed: number; done: boolean } {
  if (style.mode !== 'words' && style.mode !== 'chunk') {
    const revealed = revealedChars(d, style.typewriter);
    return { text: d.text, revealed, done: revealed >= d.text.length };
  }
  const groups = groupWords(wordTimings(d.text, d.speakDuration), style.maxWords);
  if (!groups.length) return { text: d.text, revealed: d.text.length, done: true };
  // Grupo ativo: o último cujo início já passou (mantém o último grupo durante o `hold`).
  let group = groups[0];
  for (const g of groups) {
    if (g.start > d.localTime) break;
    group = g;
  }
  const text = group.words.map((w) => w.word).join(' ');
  if (style.mode === 'chunk') return { text, revealed: text.length, done: group === groups[groups.length - 1] };
  // 'words': soma palavras inteiras já faladas dentro do grupo (sem revelar letra a letra).
  let doneWords = 0;
  for (const w of group.words) {
    if (w.start > d.localTime) break;
    doneWords++;
  }
  doneWords = Math.max(1, doneWords);
  const revealed = group.words.slice(0, doneWords).reduce((s, w) => s + w.word.length, 0) + (doneWords - 1);
  return { text, revealed, done: doneWords >= group.words.length && group === groups[groups.length - 1] };
}

/** Família CSS com fallback monoespaçado. */
export function fontStack(font: string): string {
  return `${/^[\w-]+$/.test(font) ? font : `'${font.replace(/'/g, '')}'`}, ui-monospace, monospace`;
}

/** O cursor ▼ pisca a cada 0.8 s. */
export function caretVisible(time: number): boolean {
  return time % 0.8 < 0.4;
}

/** Pixels por "pixel de design" num quadro de largura × altura (720p = 1). */
export function subtitleScale(width: number, height: number): number {
  return Math.max(0.6, Math.min(width, height) / 720);
}

/**
 * Distância da borda para legendas 'bottom'/'top'. Em quadro vertical, fica fora
 * das faixas que a interface do Reels/TikTok/Shorts cobre (legenda do post
 * embaixo, título em cima).
 */
export function subtitleInset(position: SubtitleStyle['position'], width: number, height: number, scale: number): number {
  const base = (position === 'top' ? 24 : 28) * scale;
  if (height < width * 1.2) return base;
  return Math.max(base, height * (position === 'top' ? 0.12 : 0.2));
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
  /** Fonte, tamanhos e cor do corpo do texto — já com o override por ator (`speaker().font/size/textColor`) aplicado. */
  font: string;
  textSize: number;
  nameSize: number;
  lineHeight: number;
  nameBlock: number;
  color: string;
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
  const outline = style.style === 'outline';
  const noBox = style.style === 'plain' || outline;
  const padX = noBox ? 0 : 16 * k;
  const padTop = noBox ? 0 : 10 * k;
  const padBottom = noBox ? 0 : 12 * k;
  const edge = 16 * k;
  const gap = 8 * k;
  const margin = Math.max(0, style.margin) * k;
  const fullWidth = Math.min(880 * k, layout.width - edge * 2);
  const bubbleWidth = Math.min(420 * k, layout.width - edge * 2);

  ctx.save();

  /** Quebra o texto e mede a caixa. Balões (`fit`) encolhem até o tamanho do texto. Aplica o override por ator. */
  const measure = (d: ActiveDialogue, maxWidth: number, fit: boolean): MeasuredBox => {
    const rs = revealState(d, style);
    const info = speaker(d.actorId);
    const boxFont = info.font ?? style.font;
    const boxSize = info.size ?? style.size;
    const fontAt = (size: number) => `${size}px ${fontStack(boxFont)}`;
    const textSize = Math.round(28 * k * boxSize);
    const lineHeight = textSize * 1.15;
    const nameSize = Math.round(24 * k * boxSize);
    const nameBlock = style.showName ? nameSize + 2 * k : 0;

    ctx.font = fontAt(textSize);
    const lines = wrap(ctx, rs.text, maxWidth - padX * 2);
    // Revela os caracteres (ou palavras inteiras, nos modos 'words'/'chunk') linha a linha.
    let remaining = rs.revealed;
    const shown = lines.map((l) => {
      const part = l.slice(0, Math.max(0, remaining));
      remaining -= l.length + 1;
      return part;
    });
    let width = maxWidth;
    if (fit) {
      let content = Math.max(...lines.map((l) => ctx.measureText(l).width));
      if (style.showName) {
        ctx.font = fontAt(nameSize);
        content = Math.max(content, ctx.measureText(info.name.toUpperCase()).width);
      }
      width = Math.min(maxWidth, Math.max(120 * k, content + padX * 2 + 24 * k));
    }
    return {
      d,
      lines,
      shown,
      done: rs.done,
      width,
      height: padTop + padBottom + nameBlock + lines.length * lineHeight,
      font: boxFont,
      textSize,
      nameSize,
      lineHeight,
      nameBlock,
      color: info.textColor ?? style.color,
    };
  };

  // Texto com sombra (box), contorno (plain) ou contorno + sombra projetada (outline).
  const ink = (text: string, tx: number, ty: number, color: string) => {
    if (outline) {
      ctx.save();
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = '#000';
      ctx.fillText(text, tx + 4 * k, ty + 4 * k);
      ctx.restore();
    }
    if (noBox) {
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
    const { d, lines, shown, done, width, height, font: boxFont, textSize, nameSize, lineHeight, nameBlock, color } = box;
    const fontAt = (size: number) => `${size}px ${fontStack(boxFont)}`;
    if (!noBox) {
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
      ctx.font = fontAt(nameSize);
      ctx.textAlign = noBox ? 'center' : 'left';
      ink(info.name.toUpperCase(), noBox ? center : x + padX, y + padTop, info.color);
    }
    ctx.font = fontAt(textSize);
    ctx.textAlign = 'left';
    const textTop = y + padTop + nameBlock;
    let caretX = x + padX;
    shown.forEach((line, i) => {
      // Centralizado pela linha completa: o texto parcial não "anda" enquanto é datilografado.
      const lx = noBox ? center - ctx.measureText(lines[i]).width / 2 : x + padX;
      ink(line, lx, textTop + i * lineHeight, color);
      caretX = lx + ctx.measureText(line).width;
    });
    if (!noBox && style.mode === 'typewriter' && done && caretVisible(layout.time)) {
      const caretSize = Math.round(textSize * (18 / 28));
      ctx.font = fontAt(caretSize);
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
    const tailLength = noBox ? 0 : 14 * k;
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
      const tail = !noBox && top === rect.y && tip.y > top + rect.height ? tip : undefined;
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

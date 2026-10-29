import type { WatermarkDef, WatermarkPosition } from '../timeline/types';
import { fontStack, subtitleScale } from './SubtitleRenderer';

/**
 * Marca d'água: desenhada no canto da cena por `drawWatermark`, usado tanto pela
 * tela (`DialogueBox`, mesmo canvas das legendas) quanto pelo vídeo exportado
 * (`Recorder`) — igual ao padrão de `SubtitleRenderer`.
 */

export interface WatermarkStyle {
  text: string;
  image?: string;
  position: WatermarkPosition;
  opacity: number;
  size: number;
  color: string;
}

export const WATERMARK_DEFAULTS: WatermarkStyle = {
  text: '',
  image: undefined,
  position: 'bottom-right',
  opacity: 0.8,
  size: 22,
  color: '#ffffff',
};

/** `undefined`/sem texto nem imagem = sem marca d'água. */
export function resolveWatermark(def: WatermarkDef | undefined): WatermarkStyle | null {
  if (!def || (!def.text && !def.image)) return null;
  const out = { ...WATERMARK_DEFAULTS };
  for (const [k, v] of Object.entries(def)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Imagens carregadas uma vez e reaproveitadas (tela e vídeo compartilham o cache). */
const imageCache = new Map<string, HTMLImageElement>();
function loadedImage(src: string): HTMLImageElement | null {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    imageCache.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

export function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number, style: WatermarkStyle): void {
  if (!style.text && !style.image) return;
  const k = subtitleScale(width, height);
  const margin = 20 * k;
  const img = style.image ? loadedImage(style.image) : null;
  const fontSize = Math.round(style.size * k);

  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.font = `${fontSize}px ${fontStack('VT323')}`;
  ctx.textBaseline = 'middle';

  const imgH = img ? fontSize * 1.6 : 0;
  const imgW = img ? imgH * (img.naturalWidth / img.naturalHeight) : 0;
  const textW = style.text ? ctx.measureText(style.text).width : 0;
  const gap = img && style.text ? 8 * k : 0;
  const blockW = imgW + gap + textW;
  const blockH = Math.max(imgH, fontSize);

  let x: number;
  let y: number;
  switch (style.position) {
    case 'top-left':
      x = margin;
      y = margin + blockH / 2;
      break;
    case 'top-right':
      x = width - margin - blockW;
      y = margin + blockH / 2;
      break;
    case 'center':
      x = (width - blockW) / 2;
      y = (height - blockH) / 2 + blockH / 2;
      break;
    case 'bottom-left':
      x = margin;
      y = height - margin - blockH / 2;
      break;
    default:
      x = width - margin - blockW;
      y = height - margin - blockH / 2;
  }

  let cursor = x;
  if (img) {
    ctx.drawImage(img, cursor, y - imgH / 2, imgW, imgH);
    cursor += imgW + gap;
  }
  if (style.text) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillText(style.text, cursor + 1 * k, y + 1 * k);
    ctx.fillStyle = style.color;
    ctx.fillText(style.text, cursor, y);
  }
  ctx.restore();
}

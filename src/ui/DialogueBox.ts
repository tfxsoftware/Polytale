import type { ActiveDialogue } from '../timeline/types';
import { clamp01 } from '../utils/math';

export interface SpeakerInfo {
  name: string;
  color: string;
}

/** Quantos caracteres da fala já foram "datilografados" no instante atual. */
export function revealedChars(d: ActiveDialogue): number {
  const reveal = clamp01(d.localTime / Math.max(0.05, d.speakDuration * 0.92));
  return Math.ceil(d.text.length * reveal);
}

/**
 * Legendas estilo RPG dos anos 90: caixa com nome do falante e texto
 * revelado em "máquina de escrever" sincronizado ao tempo da fala.
 * O conteúdo é derivado do quadro (seek-safe): voltar no tempo "desescreve".
 */
export class DialogueBox {
  private readonly root: HTMLDivElement;
  private lastSignature = '';

  constructor(
    parent: HTMLElement,
    private readonly speaker: (actorId: string) => SpeakerInfo,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'dialogue-layer';
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  render(dialogues: ActiveDialogue[]): void {
    const items = dialogues.map((d) => ({ d, chars: revealedChars(d) }));
    const signature = items.map((i) => `${i.d.key}:${i.chars}`).join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.root.replaceChildren(
      ...items.map(({ d, chars }) => {
        const info = this.speaker(d.actorId);
        const box = document.createElement('div');
        box.className = 'dialogue-box';
        const name = document.createElement('div');
        name.className = 'dialogue-name';
        name.textContent = info.name;
        name.style.color = info.color;
        const text = document.createElement('div');
        text.className = 'dialogue-text';
        const shown = document.createElement('span');
        shown.textContent = d.text.slice(0, chars);
        // Texto restante invisível reserva o espaço (sem "pulos" de layout).
        const hidden = document.createElement('span');
        hidden.className = 'dialogue-hidden';
        hidden.textContent = d.text.slice(chars);
        text.append(shown, hidden);
        if (chars >= d.text.length) {
          const caret = document.createElement('span');
          caret.className = 'dialogue-caret';
          caret.textContent = '▼';
          text.append(caret);
        }
        box.append(name, text);
        return box;
      }),
    );
  }

  clear(): void {
    this.lastSignature = '';
    this.root.replaceChildren();
  }
}

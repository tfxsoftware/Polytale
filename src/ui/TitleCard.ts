import { clamp01, smoothstep } from '../utils/math';

export interface TitleCardState {
  title: string;
  subtitle: string;
  /** 0..1 ao longo da exibição. */
  progress: number;
  /** true = só o texto (com sombra), sem a faixa escura — para sobrepor a uma cena em andamento. */
  overlay?: boolean;
}

/** Opacidade da cartela: entra e sai suavemente (derivada do tempo — seek-safe). */
export function titleCardOpacity(progress: number): number {
  const p = clamp01(progress);
  return smoothstep(0.05, 0.25, p) * (1 - smoothstep(0.75, 1, p));
}

/** Cartela de capítulo ("Capítulo 2 — Amanhecer") sobre a cena. */
export class TitleCard {
  private readonly root: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private readonly main: HTMLDivElement;
  private lastKey = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'title-card';
    this.sub = document.createElement('div');
    this.sub.className = 'title-card-sub';
    this.main = document.createElement('div');
    this.main.className = 'title-card-main';
    this.root.append(this.sub, this.main);
    this.root.style.opacity = '0';
    parent.appendChild(this.root);
  }

  render(state: TitleCardState | null): void {
    const opacity = state ? titleCardOpacity(state.progress) : 0;
    const key = state ? `${state.subtitle}|${state.title}` : '';
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.sub.textContent = state?.subtitle ?? '';
      this.main.textContent = state?.title ?? '';
    }
    this.root.style.opacity = opacity.toFixed(3);
    this.root.classList.toggle('is-overlay', !!state?.overlay);
  }
}

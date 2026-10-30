export interface ExportOverlayCallbacks {
  onCancel(): void;
}

function formatTime(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Progresso da geração de vídeo. Cobre a interface (sem esconder a cena) para
 * que nada mexa na timeline enquanto a história é gravada; Esc cancela.
 * Fica fora do canvas, então não aparece no vídeo.
 */
export class ExportOverlay {
  private readonly root: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly info: HTMLDivElement;
  private readonly title: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    private readonly cb: ExportOverlayCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'export-overlay';
    this.root.hidden = true;

    const card = document.createElement('div');
    card.className = 'export-card';
    card.setAttribute('role', 'status');
    this.title = document.createElement('div');
    this.title.className = 'export-title';
    this.title.textContent = '⬇ Gerando vídeo…';
    const bar = document.createElement('div');
    bar.className = 'export-bar';
    this.fill = document.createElement('div');
    this.fill.className = 'export-fill';
    bar.append(this.fill);
    this.info = document.createElement('div');
    this.info.className = 'export-info';
    const hint = document.createElement('div');
    hint.className = 'export-hint';
    hint.textContent = 'A história toca do início ao fim; mantenha esta aba aberta. O download começa sozinho no final.';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cp-btn';
    cancel.textContent = 'CANCELAR';
    cancel.title = 'Cancelar (Esc)';
    cancel.addEventListener('click', () => this.cb.onCancel());
    card.append(this.title, bar, this.info, hint, cancel);
    this.root.append(card);
    parent.append(this.root);

    const onKey = (e: KeyboardEvent) => {
      if (!this.isOpen) return;
      // Nenhum atalho funciona durante a geração (F1–F12 seguem para o navegador); Esc cancela.
      e.stopImmediatePropagation();
      if (!/^F\d+$/.test(e.key)) e.preventDefault();
      if (e.key === 'Escape') this.cb.onCancel();
    };
    window.addEventListener('keydown', onKey, { capture: true });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  show(title = '⬇ Gerando vídeo…'): void {
    this.title.textContent = title;
    this.setProgress(0, 0);
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  setProgress(time: number, duration: number): void {
    const p = duration > 0 ? Math.min(1, time / duration) : 0;
    this.fill.style.width = `${(p * 100).toFixed(1)}%`;
    this.info.textContent = `${formatTime(time)} / ${formatTime(duration)} · ${Math.round(p * 100)}%`;
  }
}

export interface TimelineEditorCallbacks {
  /** Aplica o JSON. Retorna lista de erros (vazia = sucesso). */
  onApply(script: unknown): Promise<string[]>;
  /** Script padrão para o botão "Restaurar demo". */
  getDefault(): unknown;
  onOpen?(): void;
  onClose?(): void;
}

/** Localiza linha/coluna de um erro de JSON.parse (formato varia entre navegadores). */
function describeJsonError(text: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const pos = /position (\d+)/i.exec(msg);
  const lineCol = /line (\d+) column (\d+)/i.exec(msg);
  if (lineCol) return `JSON inválido (linha ${lineCol[1]}, coluna ${lineCol[2]}): ${msg}`;
  if (pos) {
    const p = Number(pos[1]);
    const before = text.slice(0, p);
    const line = before.split('\n').length;
    const col = p - before.lastIndexOf('\n');
    return `JSON inválido (linha ${line}, coluna ${col}): ${msg}`;
  }
  return `JSON inválido: ${msg}`;
}

/**
 * Modal para colar/editar um StoryScript JSON e aplicá-lo em tempo real.
 * Ctrl/Cmd+Enter aplica, Esc fecha, Tab insere indentação.
 */
export class TimelineEditor {
  private readonly backdrop: HTMLDivElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly errors: HTMLUListElement;
  private readonly applyBtn: HTMLButtonElement;
  private readonly info: HTMLSpanElement;

  constructor(
    parent: HTMLElement,
    private readonly cb: TimelineEditorCallbacks,
  ) {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'editor-backdrop';
    this.backdrop.hidden = true;

    const modal = document.createElement('div');
    modal.className = 'editor-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Editor de StoryScript');

    const header = document.createElement('div');
    header.className = 'editor-header';
    const title = document.createElement('h2');
    title.textContent = 'StoryScript JSON';
    this.info = document.createElement('span');
    this.info.className = 'editor-info';
    const close = this.button('✕', 'Fechar (Esc)');
    header.append(title, this.info, close);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'editor-text';
    this.textarea.spellcheck = false;
    this.textarea.setAttribute('aria-label', 'StoryScript JSON');

    this.errors = document.createElement('ul');
    this.errors.className = 'editor-errors';

    const footer = document.createElement('div');
    footer.className = 'editor-footer';
    const formatBtn = this.button('Formatar', 'Reindentar JSON');
    const copyBtn = this.button('Copiar', 'Copiar para a área de transferência');
    const resetBtn = this.button('Restaurar demo', 'Carregar o script de demonstração');
    this.applyBtn = this.button('Aplicar ▶', 'Aplicar (Ctrl+Enter)', 'is-primary');
    footer.append(formatBtn, copyBtn, resetBtn, this.applyBtn);

    modal.append(header, this.textarea, this.errors, footer);
    this.backdrop.append(modal);
    parent.appendChild(this.backdrop);

    close.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    formatBtn.addEventListener('click', () => this.format());
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.textarea.value).then(
        () => this.flash('Copiado.'),
        () => this.flash('Não foi possível copiar.'),
      );
    });
    resetBtn.addEventListener('click', () => {
      this.setText(cb.getDefault());
      this.showErrors([]);
    });
    this.applyBtn.addEventListener('click', () => void this.apply());
    this.textarea.addEventListener('input', () => this.updateInfo());
    this.textarea.addEventListener('keydown', (e) => this.onKey(e));
  }

  get isOpen(): boolean {
    return !this.backdrop.hidden;
  }

  open(current: unknown): void {
    this.setText(current);
    this.showErrors([]);
    this.backdrop.hidden = false;
    this.cb.onOpen?.();
    requestAnimationFrame(() => this.textarea.focus());
  }

  close(): void {
    if (!this.isOpen) return;
    this.backdrop.hidden = true;
    this.cb.onClose?.();
  }

  private setText(value: unknown): void {
    this.textarea.value = JSON.stringify(value, null, 2);
    this.updateInfo();
  }

  private parse(): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
      return { ok: true, value: JSON.parse(this.textarea.value) };
    } catch (err) {
      return { ok: false, error: describeJsonError(this.textarea.value, err) };
    }
  }

  private format(): void {
    const r = this.parse();
    if (!r.ok) return this.showErrors([r.error]);
    this.setText(r.value);
    this.showErrors([]);
  }

  private async apply(): Promise<void> {
    const r = this.parse();
    if (!r.ok) return this.showErrors([r.error]);
    this.applyBtn.disabled = true;
    try {
      const errs = await this.cb.onApply(r.value);
      this.showErrors(errs);
      if (!errs.length) this.close();
    } finally {
      this.applyBtn.disabled = false;
    }
  }

  private showErrors(errs: string[]): void {
    this.errors.replaceChildren(
      ...errs.map((e) => {
        const li = document.createElement('li');
        li.textContent = e;
        return li;
      }),
    );
  }

  private updateInfo(): void {
    const r = this.parse();
    if (!r.ok) {
      this.info.textContent = 'JSON inválido';
      this.info.classList.add('is-error');
      return;
    }
    this.info.classList.remove('is-error');
    const v = r.value as { timeline?: unknown[] };
    const n = Array.isArray(v?.timeline) ? v.timeline.length : 0;
    this.info.textContent = `${n} eventos · ${this.textarea.value.length} caracteres`;
  }

  private flash(msg: string): void {
    const prev = this.info.textContent;
    this.info.textContent = msg;
    setTimeout(() => (this.info.textContent = prev), 1200);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void this.apply();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const ta = this.textarea;
      const { selectionStart: s, selectionEnd: end } = ta;
      ta.setRangeText('  ', s, end, 'end');
      this.updateInfo();
    }
    e.stopPropagation();
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

import type { GeneratorProgress, GeneratorTransport, ScriptGenerator } from '../systems/ScriptGenerator';

/** O SDK e o skills.md só são baixados quando o painel é aberto pela primeira vez. */
const loadGenerator = () => import('../systems/ScriptGenerator');

const KEY_STORAGE = 'polytale:anthropic-key';

export interface GeneratorPanelCallbacks {
  /** Valida um script (lista de erros vazia = ok). */
  validate(script: unknown): string[];
  /** Recebe o roteiro gerado e válido. */
  onScript(script: unknown): Promise<void>;
  onOpen?(): void;
}

function readStoredKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

function storeKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* armazenamento indisponível */
  }
}

/**
 * Modal "Gerar com IA": o usuário cola uma história em texto livre e o Claude
 * devolve um StoryScript (usando o skills.md), já validado pela engine.
 */
export class GeneratorPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly story: HTMLTextAreaElement;
  private readonly keyRow: HTMLDivElement;
  private readonly keyInput: HTMLInputElement;
  private readonly remember: HTMLInputElement;
  private readonly mode: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly errors: HTMLUListElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private generator: ScriptGenerator | null = null;
  private useProxy = false;
  private abort: AbortController | null = null;

  constructor(
    parent: HTMLElement,
    private readonly cb: GeneratorPanelCallbacks,
  ) {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'editor-backdrop';
    this.backdrop.hidden = true;
    const modal = document.createElement('div');
    modal.className = 'editor-modal generator-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Gerar roteiro com IA');

    const header = document.createElement('div');
    header.className = 'editor-header';
    const title = document.createElement('h2');
    title.textContent = 'Gerar roteiro com IA';
    this.mode = document.createElement('span');
    this.mode.className = 'editor-info';
    const close = this.button('✕', 'Fechar (Esc)');
    header.append(title, this.mode, close);

    const hint = document.createElement('p');
    hint.className = 'generator-hint';
    hint.textContent =
      'Cole uma história, roteiro ou ideia de cena. O Claude converte em StoryScript (personagens, câmera, falas, interações) e a engine valida antes de aplicar.';

    this.story = document.createElement('textarea');
    this.story.className = 'editor-text generator-story';
    this.story.placeholder =
      'Ex.: Numa taverna à noite, a ferreira Rosa conversa com um viajante misterioso. Ele entrega um mapa, ela desconfia, um trovão estoura lá fora...';
    this.story.setAttribute('aria-label', 'História');

    this.keyRow = document.createElement('div');
    this.keyRow.className = 'generator-key';
    this.keyInput = document.createElement('input');
    this.keyInput.type = 'password';
    this.keyInput.placeholder = 'sk-ant-...';
    this.keyInput.autocomplete = 'off';
    this.keyInput.setAttribute('aria-label', 'Chave da API Anthropic');
    this.keyInput.value = readStoredKey();
    const rememberLabel = document.createElement('label');
    this.remember = document.createElement('input');
    this.remember.type = 'checkbox';
    this.remember.checked = !!this.keyInput.value;
    rememberLabel.append(this.remember, ' lembrar neste navegador');
    const keyNote = document.createElement('small');
    keyNote.textContent =
      'A chave é enviada direto do seu navegador para a API. Use só em uso pessoal; para publicar o app, rode com ANTHROPIC_API_KEY no servidor (.env.local).';
    const keyLabel = document.createElement('span');
    keyLabel.textContent = 'Chave da API:';
    this.keyRow.append(keyLabel, this.keyInput, rememberLabel, keyNote);

    this.status = document.createElement('div');
    this.status.className = 'generator-status';
    this.errors = document.createElement('ul');
    this.errors.className = 'editor-errors';

    const footer = document.createElement('div');
    footer.className = 'editor-footer';
    this.cancelBtn = this.button('Cancelar', 'Cancelar a geração');
    this.cancelBtn.disabled = true;
    this.runBtn = this.button('Gerar ✦', 'Gerar roteiro (Ctrl+Enter)', 'is-primary');
    footer.append(this.cancelBtn, this.runBtn);

    modal.append(header, hint, this.story, this.keyRow, this.status, this.errors, footer);
    this.backdrop.append(modal);
    parent.appendChild(this.backdrop);

    close.addEventListener('click', () => this.close());
    this.runBtn.addEventListener('click', () => void this.run());
    this.cancelBtn.addEventListener('click', () => this.abort?.abort());
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void this.run();
      e.stopPropagation();
    });
  }

  get isOpen(): boolean {
    return !this.backdrop.hidden;
  }

  async open(): Promise<void> {
    this.backdrop.hidden = false;
    this.cb.onOpen?.();
    this.mode.textContent = 'carregando…';
    const mod = await loadGenerator();
    this.generator ??= new mod.ScriptGenerator(this.cb.validate);
    this.useProxy = await mod.proxyAvailable();
    this.keyRow.hidden = this.useProxy;
    this.mode.textContent = this.useProxy ? `${mod.GENERATOR_MODEL} · chave do servidor` : `${mod.GENERATOR_MODEL} · chave própria`;
    requestAnimationFrame(() => this.story.focus());
  }

  close(): void {
    this.abort?.abort();
    this.backdrop.hidden = true;
  }

  private async run(): Promise<void> {
    if (this.abort || !this.generator) return;
    const { GeneratorError } = await loadGenerator();
    const text = this.story.value.trim();
    if (!text) return this.fail('Escreva ou cole uma história primeiro.');

    let transport: GeneratorTransport;
    if (this.useProxy) transport = { kind: 'proxy' };
    else {
      const key = this.keyInput.value.trim();
      if (!key) return this.fail('Informe sua chave da API (ou rode o servidor com ANTHROPIC_API_KEY).');
      storeKey(this.remember.checked ? key : null);
      transport = { kind: 'key', apiKey: key };
    }

    this.abort = new AbortController();
    this.runBtn.disabled = true;
    this.cancelBtn.disabled = false;
    this.showErrors([]);
    try {
      const result = await this.generator.generate(text, transport, (p) => this.progress(p), this.abort.signal);
      this.status.textContent = `Pronto (${result.attempts} tentativa${result.attempts > 1 ? 's' : ''}, ${result.model}). Aplicando…`;
      await this.cb.onScript(result.script);
      this.status.textContent = '';
      this.close();
    } catch (err) {
      if (err instanceof GeneratorError) this.fail(err.message, err.details);
      else this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.abort = null;
      this.runBtn.disabled = false;
      this.cancelBtn.disabled = true;
    }
  }

  private progress(p: GeneratorProgress): void {
    const what = p.phase === 'writing' ? 'Escrevendo roteiro' : p.phase === 'fixing' ? 'Corrigindo erros de validação' : 'Validando';
    this.status.textContent = `${what}… tentativa ${p.attempt} · ${p.chars.toLocaleString('pt-BR')} caracteres`;
  }

  private fail(message: string, details: string[] = []): void {
    this.status.textContent = message;
    this.showErrors(details);
  }

  private showErrors(errs: string[]): void {
    this.errors.replaceChildren(
      ...errs.slice(0, 30).map((e) => {
        const li = document.createElement('li');
        li.textContent = e;
        return li;
      }),
    );
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

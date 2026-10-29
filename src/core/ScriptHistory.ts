/**
 * Histórico de desfazer/refazer dos roteiros aplicados.
 *
 * Guarda cópias serializadas (JSON) de cada versão válida: imutáveis, baratas de
 * comparar e independentes de mutações posteriores do objeto original.
 */

const DEFAULT_LIMIT = 100;
/** Mudanças com a mesma chave dentro desta janela viram um único passo (ex.: arrastar um slider). */
const COALESCE_MS = 1000;

export class ScriptHistory {
  private past: string[] = [];
  private future: string[] = [];
  private current: string | null = null;
  private lastKey: string | null = null;
  private lastAt = 0;

  constructor(
    private readonly limit = DEFAULT_LIMIT,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Começa do zero com `script` como versão atual (ex.: roteiro inicial). */
  reset(script: unknown): void {
    this.past = [];
    this.future = [];
    this.current = JSON.stringify(script);
    this.lastKey = null;
  }

  /**
   * Registra uma nova versão aplicada com sucesso. Com `coalesceKey`, mudanças
   * seguidas da mesma origem substituem o passo anterior em vez de empilhar.
   */
  record(script: unknown, coalesceKey?: string): void {
    const json = JSON.stringify(script);
    if (json === this.current) return;
    const at = this.now();
    const coalesce = coalesceKey !== undefined && coalesceKey === this.lastKey && at - this.lastAt < COALESCE_MS && this.past.length > 0;
    if (!coalesce && this.current !== null) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = json;
    this.future = [];
    this.lastKey = coalesceKey ?? null;
    this.lastAt = at;
  }

  /** Volta uma versão; retorna o roteiro a aplicar (ou null se não houver). */
  undo(): unknown | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    if (this.current !== null) this.future.push(this.current);
    return this.moveTo(prev);
  }

  /** Avança uma versão desfeita; retorna o roteiro a aplicar (ou null). */
  redo(): unknown | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    if (this.current !== null) this.past.push(this.current);
    return this.moveTo(next);
  }

  private moveTo(json: string): unknown {
    this.current = json;
    this.lastKey = null;
    return JSON.parse(json);
  }
}

import Anthropic from '@anthropic-ai/sdk';
import skills from '../../skills.md?raw';

/** Rota do proxy do servidor Vite (dev/preview) que injeta ANTHROPIC_API_KEY. */
export const PROXY_BASE = '/api/anthropic';
const PROXY_STATUS = '/api/polytale/ai-status';

export const GENERATOR_MODEL = 'claude-opus-5-5';
const MAX_ATTEMPTS = 3;

/**
 * Como chegar à API:
 * - 'proxy': o servidor do Vite adiciona a chave (lida de .env.local) — ela nunca chega ao navegador;
 * - 'key': chave digitada pelo usuário, usada direto do navegador (só para uso pessoal/local).
 */
export type GeneratorTransport = { kind: 'proxy' } | { kind: 'key'; apiKey: string };

export interface GeneratorProgress {
  phase: 'writing' | 'validating' | 'fixing';
  attempt: number;
  /** Caracteres de JSON recebidos na tentativa atual. */
  chars: number;
  errors?: string[];
}

export interface GeneratorResult {
  script: unknown;
  attempts: number;
  /** Modelo que efetivamente respondeu (pode ser o de fallback). */
  model: string;
}

export class GeneratorError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'GeneratorError';
  }
}

/** O proxy do servidor está ativo (dev/preview com ANTHROPIC_API_KEY definida)? */
export async function proxyAvailable(): Promise<boolean> {
  try {
    const res = await fetch(PROXY_STATUS, { headers: { accept: 'application/json' } });
    if (!res.ok) return false;
    const body = (await res.json()) as { available?: boolean };
    return body.available === true;
  } catch {
    return false;
  }
}

const INSTRUCTIONS = `Você roda dentro do editor da engine Polytale. O usuário vai colar uma história,
roteiro ou ideia de cena. Converta em um StoryScript seguindo a skill abaixo.

Responda SOMENTE com o objeto JSON do StoryScript (sem markdown, sem comentários,
sem texto antes ou depois). Se a história tiver mais de um lugar ou salto de tempo,
use "chapters" com "cast" para reaproveitar os personagens.

`;

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('a resposta não contém um objeto JSON');
  return JSON.parse(trimmed.slice(start, end + 1));
}

/**
 * Gera StoryScript a partir de texto livre com Claude, usando o skills.md como
 * system prompt (em cache). Valida o resultado com o compilador da engine e,
 * se houver erros, devolve-os ao modelo para correção (até 3 tentativas).
 */
export class ScriptGenerator {
  constructor(private readonly validate: (script: unknown) => string[]) {}

  async generate(
    story: string,
    transport: GeneratorTransport,
    onProgress: (p: GeneratorProgress) => void,
    signal?: AbortSignal,
  ): Promise<GeneratorResult> {
    const client =
      transport.kind === 'proxy'
        ? new Anthropic({ apiKey: 'via-proxy', baseURL: `${window.location.origin}${PROXY_BASE}`, dangerouslyAllowBrowser: true })
        : new Anthropic({ apiKey: transport.apiKey, dangerouslyAllowBrowser: true });

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: story }];
    let lastErrors: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let chars = 0;
      onProgress({ phase: attempt === 1 ? 'writing' : 'fixing', attempt, chars, errors: lastErrors });

      const stream = client.beta.messages.stream(
        {
          model: GENERATOR_MODEL,
          max_tokens: 64000,
          output_config: { effort: 'high' },
          // Se o modelo recusar, a API refaz a chamada num modelo de fallback recomendado.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: [{ type: 'text', text: INSTRUCTIONS + skills, cache_control: { type: 'ephemeral' } }],
          messages,
        },
        { signal },
      );
      stream.on('text', (delta) => {
        chars += delta.length;
        onProgress({ phase: attempt === 1 ? 'writing' : 'fixing', attempt, chars });
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        throw describeApiError(err);
      }

      if (message.stop_reason === 'refusal') {
        const explanation = message.stop_details?.explanation;
        throw new GeneratorError('O modelo recusou gerar este roteiro.', explanation ? [explanation] : []);
      }
      if (message.stop_reason === 'max_tokens') {
        throw new GeneratorError('A resposta ficou longa demais e foi cortada. Tente uma história mais curta ou dividida em partes.');
      }

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      onProgress({ phase: 'validating', attempt, chars });
      let script: unknown;
      try {
        script = extractJson(text);
        lastErrors = this.validate(script);
      } catch (err) {
        lastErrors = [`JSON inválido: ${err instanceof Error ? err.message : String(err)}`];
      }
      if (!lastErrors.length) return { script, attempts: attempt, model: message.model };

      // Devolve a resposta completa (incluindo blocos de raciocínio, inalterados) + os erros.
      messages.push({ role: 'assistant', content: message.content });
      messages.push({
        role: 'user',
        content: `O StoryScript tem erros de validação:\n- ${lastErrors.slice(0, 40).join('\n- ')}\n\nCorrija e responda novamente SOMENTE com o JSON completo.`,
      });
    }
    throw new GeneratorError(`Não consegui um roteiro válido em ${MAX_ATTEMPTS} tentativas.`, lastErrors);
  }
}

function describeApiError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return new GeneratorError('Geração cancelada.');
  if (err instanceof Anthropic.AuthenticationError) return new GeneratorError('Chave de API inválida ou ausente.');
  if (err instanceof Anthropic.PermissionDeniedError) return new GeneratorError('A chave não tem permissão para este modelo.');
  if (err instanceof Anthropic.RateLimitError) return new GeneratorError('Limite de uso atingido. Tente de novo em instantes.');
  if (err instanceof Anthropic.BadRequestError) return new GeneratorError(`Requisição recusada pela API: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new GeneratorError('Sem conexão com a API (rede, CORS ou proxy desligado).');
  if (err instanceof Anthropic.APIError) return new GeneratorError(`Erro da API (${err.status ?? '?'}): ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

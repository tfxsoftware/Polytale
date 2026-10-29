/**
 * Persistência de roteiros: arquivo .json (abrir/salvar), link compartilhável
 * (roteiro comprimido no hash da URL) e rascunho local do navegador.
 */

const HASH_KEY = 'story';
const LOCAL_KEY = 'polytale:last-script';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Roteiro -> texto compacto para URL (deflate + base64url). */
export async function encodeScript(script: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(script));
  if (typeof CompressionStream === 'undefined') return `j${toBase64Url(json)}`;
  return `z${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
}

export async function decodeScript(encoded: string): Promise<unknown> {
  const kind = encoded[0];
  const bytes = fromBase64Url(encoded.slice(1));
  const raw = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}

/** URL da página atual com o roteiro embutido no hash. */
export async function shareUrl(script: unknown): Promise<string> {
  const url = new URL(window.location.href);
  url.hash = `${HASH_KEY}=${await encodeScript(script)}`;
  return url.toString();
}

/** Roteiro embutido no hash da URL atual (ou null). */
export async function scriptFromLocation(): Promise<unknown | null> {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const encoded = params.get(HASH_KEY);
  if (!encoded) return null;
  try {
    return await decodeScript(encoded);
  } catch (err) {
    console.warn('[ScriptStorage] link de roteiro inválido', err);
    return null;
  }
}

export function downloadScript(script: unknown, title = 'roteiro'): void {
  const slug =
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'roteiro';
  const blob = new Blob([JSON.stringify(script, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Abre o seletor de arquivos e lê um .json. Resolve null se o usuário cancelar. */
export function openScriptFile(): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(JSON.parse(await file.text()));
      } catch (err) {
        reject(new Error(`Arquivo não é um JSON válido: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Rascunho local (por navegador): último roteiro aplicado com sucesso. */
export function saveDraft(script: unknown): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(script));
  } catch {
    /* armazenamento indisponível (modo privado, cota) — ignorar */
  }
}

export function loadDraft(): unknown | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignorar */
  }
}

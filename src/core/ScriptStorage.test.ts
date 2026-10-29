import { describe, expect, it } from 'vitest';
import { decodeScript, encodeScript } from './ScriptStorage';
import { defaultScript } from '../config/defaultScript';

describe('link compartilhável', () => {
  it('ida e volta preserva o roteiro', async () => {
    const encoded = await encodeScript(defaultScript);
    expect(encoded).toMatch(/^[zj][A-Za-z0-9_-]+$/);
    expect(await decodeScript(encoded)).toEqual(defaultScript);
  });

  it('preserva acentos e emoji', async () => {
    const script = { meta: { title: 'Ação — coração 🔥' }, timeline: [] };
    expect(await decodeScript(await encodeScript(script))).toEqual(script);
  });

  it('comprime quando possível', async () => {
    const encoded = await encodeScript(defaultScript);
    expect(encoded[0]).toBe('z');
    expect(encoded.length).toBeLessThan(JSON.stringify(defaultScript).length);
  });

  it('lê o formato sem compressão', async () => {
    const script = { meta: { title: 'x' }, timeline: [] };
    const raw = btoa(JSON.stringify(script)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await decodeScript(`j${raw}`)).toEqual(script);
  });
});

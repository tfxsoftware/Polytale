import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { SCHEMA_PATH, generateSchema } from './schema';
import { defaultScript } from '../src/config/defaultScript';

const examplesDir = fileURLToPath(new URL('../examples/', import.meta.url));
const examples = readdirSync(examplesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f): [string, unknown] => [f, JSON.parse(readFileSync(examplesDir + f, 'utf8'))]);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

describe('JSON Schema do StoryScript', () => {
  it('está em dia com src/timeline/types.ts (rode `npm run schema`)', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n')).toBe(generateSchema());
  }, 60_000);

  it.each([['defaultScript', defaultScript], ...examples])('aceita %s', (_name, script) => {
    validate(script);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('rejeita tipo de evento desconhecido', () => {
    expect(validate({ meta: { title: 'x' }, timeline: [{ time: 0, type: 'NAO_EXISTE' }] })).toBe(false);
  });
});

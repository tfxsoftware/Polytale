/**
 * JSON Schema do StoryScript, gerado a partir de src/timeline/types.ts.
 *
 *   npm run schema   -> regrava schema/storyscript.schema.json
 *
 * O teste scripts/schema.test.ts falha se o arquivo estiver desatualizado.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const root = fileURLToPath(new URL('..', import.meta.url));
export const SCHEMA_PATH = `${root}schema/storyscript.schema.json`;

export function generateSchema(): string {
  const schema = createGenerator({
    path: `${root}src/timeline/types.ts`,
    tsconfig: `${root}tsconfig.json`,
    type: 'StoryScript',
    skipTypeCheck: true,
  }).createSchema('StoryScript');
  return `${JSON.stringify({ title: 'Polytale StoryScript', ...schema }, null, 2)}\n`;
}

if (process.argv.includes('--write')) {
  writeFileSync(SCHEMA_PATH, generateSchema());
  console.log(`schema gravado em ${SCHEMA_PATH}`);
}

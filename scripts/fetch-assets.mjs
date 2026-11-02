/**
 * Baixa os assets de exemplo (public/ fica fora do git) de uma release do GitHub.
 *
 *   npm run assets [-- --force]
 *
 * Não sobrescreve arquivos locais; --force substitui pelos da release.
 * Requer tar no PATH (já incluso no Windows 10+, macOS e Linux).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS_TAG = 'assets-v1';
const ARCHIVE = 'public-assets.tar.gz';
const url = `https://github.com/tfxsoftware/Polytale/releases/download/${ASSETS_TAG}/${ARCHIVE}`;

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const archivePath = path.join(publicDir, ARCHIVE);
const force = process.argv.includes('--force');

console.log(`baixando ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`falha no download: HTTP ${res.status}`);
  process.exit(1);
}

fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));
try {
  // cwd + caminho relativo: o GNU tar entende "C:\..." como host remoto.
  execFileSync('tar', [force ? '-xzf' : '-xzkf', ARCHIVE], { cwd: publicDir, stdio: 'inherit' });
} finally {
  fs.rmSync(archivePath);
}
console.log('assets prontos em public/');

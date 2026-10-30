/**
 * Aplica a tatuagem do sol e da lua no antebraço esquerdo de um avatar GLB, pintando na textura do corpo.
 *
 *   node scripts/apply-tattoo.mjs <avatar.glb> <desenho.jpg> <saida.glb> [mascara.png]
 *
 * Usa só as linhas claras do adesivo (contorno, sem preenchimento) e projeta cada figura em volta do
 * antebraço: o sol na face de cima, a lua na face de baixo, com a cabeça voltada para o cotovelo.
 * Requer ffmpeg no PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const [avatar, drawing, output, maskPreview] = process.argv.slice(2);
if (!avatar || !drawing || !output) {
  console.error('uso: node scripts/apply-tattoo.mjs <avatar.glb> <desenho.jpg> <saida.glb> [mascara.png]');
  process.exit(1);
}

/** Recortes das figuras no desenho (px): x0, y0, x1, y1. */
const FIGURES = {
  moon: { box: [78, 112, 292, 498], side: Math.PI },
  sun: { box: [300, 100, 518, 498], side: 0 },
};
/** Altura de cada figura ao longo do antebraço (m) e centro entre cotovelo (0) e punho (1). */
const FIGURE_LENGTH = 0.11;
const FIGURE_CENTER = 0.68;
const INK = [24, 24, 30];
const INK_OPACITY = 0.9;
const MIN_LINE_PIXELS = 25;
/** A textura é ampliada antes de pintar: o braço ocupa pouco dela e as linhas ficam finas. */
const TEXTURE_SCALE = 2;

function decode(bytes, width, height) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, 'pipe:1'], {
    input: bytes,
    maxBuffer: width * height * 4,
  });
}

function encodePng(rgb, width, height) {
  return execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', 'pipe:0', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], {
    input: rgb,
    maxBuffer: width * height * 4 + 1024,
  });
}

function imageSize(file) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  return { width: w, height: h };
}

/** Linhas lavanda do adesivo: claras e azuladas, nem o fundo branco nem o azul escuro do preenchimento. */
function lineMask(rgb, width, height) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const [r, g, b] = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    mask[i] = (r + g + b) / 3 > 125 && b - r > 12 ? 1 : 0;
  }
  // Tira as estrelinhas do preenchimento: manchas pequenas e soltas.
  const seen = new Uint8Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    const blob = [];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      blob.push(p);
      for (const q of [p - 1, p + 1, p - width, p + width]) {
        if (q >= 0 && q < mask.length && mask[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (blob.length < MIN_LINE_PIXELS) for (const p of blob) mask[p] = 0;
  }
  return mask;
}

const file = fs.readFileSync(avatar);
const jsonLength = file.readUInt32LE(12);
const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString());
const binStart = 20 + jsonLength + 8;
const bin = file.subarray(binStart, binStart + file.readUInt32LE(20 + jsonLength));

function readAccessor(index, Typed, components) {
  const a = json.accessors[index];
  const view = json.bufferViews[a.bufferView];
  const size = components * Typed.BYTES_PER_ELEMENT;
  const stride = view.byteStride ?? size;
  const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = new Typed(a.count * components);
  const bytes = Buffer.from(out.buffer);
  for (let i = 0; i < a.count; i++) bin.copy(bytes, i * size, offset + i * stride, offset + i * stride + size);
  return out;
}

const size = imageSize(drawing);
const ink = lineMask(decode(fs.readFileSync(drawing), size.width, size.height), size.width, size.height);
if (maskPreview) {
  const preview = Buffer.alloc(size.width * size.height * 3, 255);
  ink.forEach((v, i) => {
    if (v) preview.fill(0, i * 3, i * 3 + 3);
  });
  fs.writeFileSync(maskPreview, encodePng(preview, size.width, size.height));
}

const body = json.meshes.find((m) => m.name === 'avaturn_body').primitives[0];
const positions = readAccessor(body.attributes.POSITION, Float32Array, 3);
const uvs = readAccessor(body.attributes.TEXCOORD_0, Float32Array, 2);
const indices = Uint32Array.from(readAccessor(body.indices, json.accessors[body.indices].componentType === 5125 ? Uint32Array : Uint16Array, 1));
const material = json.materials[body.material];
const image = json.images[json.textures[material.pbrMetallicRoughness.baseColorTexture.index].source];
const imageView = json.bufferViews[image.bufferView];
const imageBytes = bin.subarray(imageView.byteOffset ?? 0, (imageView.byteOffset ?? 0) + imageView.byteLength);

const textureFile = `${output}.tmp`;
fs.writeFileSync(textureFile, imageBytes);
const source = imageSize(textureFile);
fs.rmSync(textureFile);
const texture = { width: source.width * TEXTURE_SCALE, height: source.height * TEXTURE_SCALE };
const pixels = Buffer.from(decode(imageBytes, texture.width, texture.height));

/** Posição de repouso de um osso: a translação da inversa da matriz de bind. */
function restX(boneName) {
  const skin = json.skins[0];
  const joint = skin.joints.findIndex((node) => json.nodes[node].name === boneName);
  const m = readAccessor(skin.inverseBindMatrices, Float32Array, 16).subarray(joint * 16, joint * 16 + 16);
  // A parte de rotação é ortogonal, com escala uniforme: a inversa é a transposta dividida pela escala ao quadrado.
  const scale2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  return -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]) / scale2;
}

/** Faixa de x do antebraço esquerdo, de cotovelo a punho: o braço fica ao longo de +x na pose de repouso. */
const FOREARM = [restX('LeftForeArm'), restX('LeftHand')];
console.log(`antebraço: x de ${FOREARM[0].toFixed(3)} a ${FOREARM[1].toFixed(3)}`);

/** Eixo central do antebraço: y e z médios em cada ponta da faixa, interpolados em x. */
const ends = [
  { sumY: 0, sumZ: 0, n: 0 },
  { sumY: 0, sumZ: 0, n: 0 },
];
for (let v = 0; v < positions.length / 3; v++) {
  const x = positions[v * 3];
  if (x < FOREARM[0] || x > FOREARM[1]) continue;
  const end = ends[x < (FOREARM[0] + FOREARM[1]) / 2 ? 0 : 1];
  end.sumY += positions[v * 3 + 1];
  end.sumZ += positions[v * 3 + 2];
  end.n++;
}
const [elbow, wrist] = ends.map((e) => ({ y: e.sumY / e.n, z: e.sumZ / e.n }));

/** Tinta (0..1) num ponto do antebraço. */
function inkAt(x, y, z) {
  const t = (x - FOREARM[0]) / (FOREARM[1] - FOREARM[0]);
  const dy = y - (elbow.y + (wrist.y - elbow.y) * t);
  const dz = z - (elbow.z + (wrist.z - elbow.z) * t);
  const radius = Math.hypot(dy, dz);
  const angle = Math.atan2(dz, dy);
  const along = (t - FIGURE_CENTER) * (FOREARM[1] - FOREARM[0]);
  for (const { box, side } of Object.values(FIGURES)) {
    const turn = ((angle - side + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const [x0, y0, x1, y1] = box;
    const scale = (y1 - y0) / FIGURE_LENGTH;
    const u = (x0 + x1) / 2 - turn * radius * scale;
    const v = (y0 + y1) / 2 + along * scale;
    if (u < x0 || u >= x1 || v < y0 || v >= y1) continue;
    return ink[Math.floor(v) * size.width + Math.floor(u)];
  }
  return 0;
}

let painted = 0;
const SAMPLES = 3;
for (let i = 0; i < indices.length; i += 3) {
  const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
  if (![a, b, c].every((v) => positions[v * 3] > FOREARM[0] - 0.02 && positions[v * 3] < FOREARM[1] + 0.02)) continue;
  const uv = [a, b, c].map((v) => [uvs[v * 2] * texture.width, uvs[v * 2 + 1] * texture.height]);
  const minX = Math.floor(Math.min(...uv.map((p) => p[0])));
  const maxX = Math.ceil(Math.max(...uv.map((p) => p[0])));
  const minY = Math.floor(Math.min(...uv.map((p) => p[1])));
  const maxY = Math.ceil(Math.max(...uv.map((p) => p[1])));
  const det = (uv[1][1] - uv[2][1]) * (uv[0][0] - uv[2][0]) + (uv[2][0] - uv[1][0]) * (uv[0][1] - uv[2][1]);
  if (!det) continue;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let hits = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const qx = px + (sx + 0.5) / SAMPLES;
          const qy = py + (sy + 0.5) / SAMPLES;
          const w0 = ((uv[1][1] - uv[2][1]) * (qx - uv[2][0]) + (uv[2][0] - uv[1][0]) * (qy - uv[2][1])) / det;
          const w1 = ((uv[2][1] - uv[0][1]) * (qx - uv[2][0]) + (uv[0][0] - uv[2][0]) * (qy - uv[2][1])) / det;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          covered++;
          const at = (k) => w0 * positions[a * 3 + k] + w1 * positions[b * 3 + k] + w2 * positions[c * 3 + k];
          hits += inkAt(at(0), at(1), at(2));
        }
      }
      if (!covered || !hits || px < 0 || py < 0 || px >= texture.width || py >= texture.height) continue;
      const amount = (hits / covered) * INK_OPACITY;
      const o = (py * texture.width + px) * 3;
      for (let k = 0; k < 3; k++) pixels[o + k] = Math.round(pixels[o + k] + (INK[k] - pixels[o + k]) * amount);
      painted++;
    }
  }
}
console.log(`${painted} texels pintados`);

// A textura nova entra no fim do buffer; o restante do arquivo fica igual.
const png = encodePng(pixels, texture.width, texture.height);
const padded = Buffer.alloc(Math.ceil(png.length / 4) * 4);
png.copy(padded);
json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: png.length });
image.bufferView = json.bufferViews.length - 1;
image.mimeType = 'image/png';
json.buffers[0].byteLength = bin.length + padded.length;

const body2 = Buffer.from(JSON.stringify(json));
const jsonChunk = Buffer.alloc(Math.ceil(body2.length / 4) * 4, 0x20);
body2.copy(jsonChunk);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + jsonChunk.length + bin.length + padded.length, 8);
header.writeUInt32LE(jsonChunk.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length + padded.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(output, Buffer.concat([header, jsonChunk, binHeader, bin, padded]));
console.log(`${output}: ${(fs.statSync(output).size / 1024).toFixed(0)} KB`);

/**
 * Reduz um cenário GLB gerado por IA (malha única com textura PBR) para o visual low poly da engine.
 *
 *   node scripts/build-background.mjs [--drop=x0,y0,z0,x1,y1,z1 ...] <entrada.glb> <saida.glb> [triangulos=60000] [textura=1024]
 *
 * --drop remove peças soltas da malha que caibam inteiras na caixa (coordenadas do arquivo de entrada).
 * Descarta normais (o GLTFLoader passa a usar flat shading), troca o PBR por uma única textura
 * pequena sem filtragem e recentra o modelo: origem no centro da base, com o chão em y = 0.
 * Requer ffmpeg no PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';

const args = process.argv.slice(2);
const dropBoxes = args.filter((a) => a.startsWith('--drop=')).map((a) => a.slice('--drop='.length).split(',').map(Number));
const [input, output, targetTris = '60000', textureSize = '1024'] = args.filter((a) => !a.startsWith('--'));
if (!input || !output) {
  console.error('uso: node scripts/build-background.mjs <entrada.glb> <saida.glb> [triangulos] [textura]');
  process.exit(1);
}

const GL = { UINT: 5125, FLOAT: 5126, NEAREST: 9728, ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963 };

const file = fs.readFileSync(input);
const jsonLength = file.readUInt32LE(12);
const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString());
const binStart = 20 + jsonLength + 8;

function viewBytes(index) {
  const view = json.bufferViews[index];
  const start = binStart + (view.byteOffset ?? 0);
  return file.subarray(start, start + view.byteLength);
}

function readAccessor(index, Typed, components) {
  const a = json.accessors[index];
  const bytes = viewBytes(a.bufferView).subarray(a.byteOffset ?? 0);
  const out = new Typed(a.count * components);
  Buffer.from(out.buffer).set(bytes.subarray(0, out.byteLength));
  return out;
}

function shrinkTexture(bytes, size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polytale-texture-'));
  const source = path.join(dir, 'in');
  const target = path.join(dir, 'out.png');
  fs.writeFileSync(source, bytes);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-vf', `scale=${size}:${size}:flags=area`, '-frames:v', '1', target]);
  const out = fs.readFileSync(target);
  fs.rmSync(dir, { recursive: true });
  return out;
}

/** Tira as peças soltas (vértices iguais soldados, para atravessar as costuras de UV) contidas em `boxes`. */
function dropComponents(indices, positions, boxes) {
  const count = positions.length / 3;
  const welded = new Map();
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (v) => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  for (let v = 0; v < count; v++) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    if (welded.has(key)) parent[find(v)] = find(welded.get(key));
    else welded.set(key, v);
  }
  for (let i = 0; i < indices.length; i += 3) {
    parent[find(indices[i + 1])] = find(indices[i]);
    parent[find(indices[i + 2])] = find(indices[i]);
  }
  const bounds = new Map();
  for (let v = 0; v < count; v++) {
    const root = find(v);
    if (!bounds.has(root)) bounds.set(root, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    const { min, max } = bounds.get(root);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[v * 3 + k]);
      max[k] = Math.max(max[k], positions[v * 3 + k]);
    }
  }
  const inside = ({ min, max }, box) => [0, 1, 2].every((k) => min[k] >= box[k] && max[k] <= box[k + 3]);
  const kept = [];
  for (let i = 0; i < indices.length; i += 3) {
    if (!boxes.some((box) => inside(bounds.get(find(indices[i])), box))) kept.push(indices[i], indices[i + 1], indices[i + 2]);
  }
  console.log(`--drop: ${(indices.length - kept.length) / 3} tris removidos`);
  return Uint32Array.from(kept);
}

const primitive = json.meshes[0].primitives[0];
const positions = readAccessor(primitive.attributes.POSITION, Float32Array, 3);
const uvs = readAccessor(primitive.attributes.TEXCOORD_0, Float32Array, 2);
const rawIndices = readAccessor(primitive.indices, Uint32Array, 1);
const indices = dropBoxes.length ? dropComponents(rawIndices, positions, dropBoxes) : rawIndices;

await MeshoptSimplifier.ready;
MeshoptSimplifier.useExperimentalFeatures = true;
const [reduced, error] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, uvs, 2, [0.5, 0.5], null, Number(targetTris) * 3, 1);
console.log(`${indices.length / 3} -> ${reduced.length / 3} tris (erro ${error.toFixed(4)})`);

// Mantém só os vértices usados e coloca a origem no centro da base.
const remap = new Map();
const outIndices = Uint32Array.from(reduced, (v) => {
  if (!remap.has(v)) remap.set(v, remap.size);
  return remap.get(v);
});
const used = [...remap.keys()];
const outPositions = new Float32Array(used.length * 3);
const outUvs = new Float32Array(used.length * 2);
used.forEach((v, i) => {
  outPositions.set(positions.subarray(v * 3, v * 3 + 3), i * 3);
  outUvs.set(uvs.subarray(v * 2, v * 2 + 2), i * 2);
});
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
outPositions.forEach((v, i) => {
  min[i % 3] = Math.min(min[i % 3], v);
  max[i % 3] = Math.max(max[i % 3], v);
});
const origin = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
outPositions.forEach((v, i) => {
  outPositions[i] = v - origin[i % 3];
});

const baseImage = json.images[json.textures[json.materials[primitive.material].pbrMetallicRoughness.baseColorTexture.index].source];
const png = shrinkTexture(viewBytes(baseImage.bufferView), Number(textureSize));

const chunks = [];
const bufferViews = [];
let byteLength = 0;
function addView(bytes, target) {
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
  const padded = Buffer.alloc(Math.ceil(bytes.byteLength / 4) * 4);
  padded.set(bytes);
  chunks.push(padded);
  byteLength += padded.byteLength;
  return bufferViews.length - 1;
}
const raw = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

const out = {
  asset: { version: '2.0', generator: 'Polytale build-background' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: path.basename(output, path.extname(output)), mesh: 0 }],
  meshes: [{ primitives: [{ material: 0, indices: 2, attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
  materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
  textures: [{ source: 0, sampler: 0 }],
  samplers: [{ magFilter: GL.NEAREST, minFilter: GL.NEAREST }],
  images: [{ bufferView: 3, mimeType: 'image/png' }],
  accessors: [
    {
      bufferView: addView(raw(outPositions), GL.ARRAY_BUFFER),
      componentType: GL.FLOAT,
      count: used.length,
      type: 'VEC3',
      min: [-(max[0] - min[0]) / 2, 0, -(max[2] - min[2]) / 2],
      max: [(max[0] - min[0]) / 2, max[1] - min[1], (max[2] - min[2]) / 2],
    },
    { bufferView: addView(raw(outUvs), GL.ARRAY_BUFFER), componentType: GL.FLOAT, count: used.length, type: 'VEC2' },
    { bufferView: addView(raw(outIndices), GL.ELEMENT_ARRAY_BUFFER), componentType: GL.UINT, count: outIndices.length, type: 'SCALAR' },
  ],
};
addView(png);
out.bufferViews = bufferViews;
out.buffers = [{ byteLength }];

const body = Buffer.from(JSON.stringify(out));
const jsonChunk = Buffer.alloc(Math.ceil(body.length / 4) * 4, 0x20);
body.copy(jsonChunk);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + jsonChunk.length + byteLength, 8);
header.writeUInt32LE(jsonChunk.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(byteLength, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(output, Buffer.concat([header, jsonChunk, binHeader, ...chunks]));
console.log(`${output}: ${(fs.statSync(output).size / 1024).toFixed(0)} KB, ${(max[0] - min[0]).toFixed(3)} x ${(max[1] - min[1]).toFixed(3)} x ${(max[2] - min[2]).toFixed(3)}`);

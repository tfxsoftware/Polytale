/**
 * Gera uma versão low poly de um avatar GLB e embute clipes FBX do Mixamo no mesmo arquivo.
 *
 *   node scripts/build-character.mjs [--full] [--body-texture=N] [entrada.glb] [saida.glb] [Clipe.fbx ...]
 *
 * Com --full, malha e materiais ficam intactos e só os clipes são embutidos.
 * --body-texture troca o tamanho da textura do corpo (ex.: para uma tatuagem continuar legível).
 * Reduz a malha, descarta normais (o GLTFLoader passa a usar flat shading), troca o PBR por
 * uma única textura pequena sem filtragem e copia as trilhas dos FBX para o esqueleto do GLB.
 * Os clipes precisam vir de um esqueleto com os mesmos nomes de ossos. Requer ffmpeg no PATH.
 * O corpo ganha um morph `jawOpen` e uma malha escura de boca: o avatar não tem morphs nem boca aberta.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const args = process.argv.slice(2);
const full = args.includes('--full');
const defaultOutput = full ? 'public/models/character-full.glb' : 'public/models/character-lowpoly.glb';
const [input = 'public/models/character.glb', output = defaultOutput, ...clipArgs] = args.filter((a) => !a.startsWith('--'));
const bodyTexture = Number(args.find((a) => a.startsWith('--body-texture='))?.split('=')[1]) || 128;
const clipFiles = clipArgs.length ? clipArgs : ['public/models/Walking.fbx', 'public/models/Talking.fbx'];

/** Triângulos e tamanho da textura por malha (a do corpo guarda o rosto). */
const TARGETS = {
  avaturn_body: { tris: 1500, texture: bodyTexture },
  avaturn_hair_0: { tris: 300, texture: 64 },
  avaturn_shoes_0: { tris: 300, texture: 64 },
  avaturn_look_0: { tris: 900, texture: 128 },
};
const DEFAULT_TARGET = { tris: 500, texture: 128 };
/** Pele a menos disso sob a roupa é removida: com pouca geometria ela atravessaria o tecido. */
const COVER_DISTANCE = 0.08;
const MAX_INFLUENCES = 4;
/** Boca do avatar Avaturn na pose de repouso (m). */
const MOUTH = { lipLine: 1.652, chin: 1.598, halfWidth: 0.05, front: 0.03, drop: 0.024, center: 1.642, openHeight: 0.024, z: 0.0935, width: 0.023 };
const MOUTH_SEGMENTS = 10;

const GL = { BYTE: 5120, UBYTE: 5121, SHORT: 5122, USHORT: 5123, UINT: 5125, FLOAT: 5126, NEAREST: 9728 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPED = { [GL.BYTE]: Int8Array, [GL.UBYTE]: Uint8Array, [GL.SHORT]: Int16Array, [GL.USHORT]: Uint16Array, [GL.UINT]: Uint32Array, [GL.FLOAT]: Float32Array };

function readGlb(file) {
  const b = fs.readFileSync(file);
  const jsonLength = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLength).toString());
  const binStart = 20 + jsonLength + 8;
  return { json, bin: b.subarray(binStart, binStart + b.readUInt32LE(20 + jsonLength)) };
}

/** Lê um accessor como array compacto (ignora stride e alinhamento do buffer original). */
function readAccessor({ json, bin }, index) {
  const a = json.accessors[index];
  const view = json.bufferViews[a.bufferView];
  const Typed = TYPED[a.componentType];
  const n = COMPONENTS[a.type];
  const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = view.byteStride ?? n * Typed.BYTES_PER_ELEMENT;
  const out = new Typed(a.count * n);
  for (let i = 0; i < a.count; i++) {
    const element = new Typed(bin.buffer.slice(bin.byteOffset + offset + i * stride, bin.byteOffset + offset + i * stride + n * Typed.BYTES_PER_ELEMENT));
    out.set(element, i * n);
  }
  return out;
}

/** Pesos em float, cobrindo os formatos normalizados que o glTF permite. */
function readWeights(glb, index) {
  const raw = readAccessor(glb, index);
  const max = glb.json.accessors[index].componentType === GL.UBYTE ? 255 : glb.json.accessors[index].componentType === GL.USHORT ? 65535 : 1;
  return Float32Array.from(raw, (v) => v / max);
}

class GlbWriter {
  chunks = [];
  byteLength = 0;
  bufferViews = [];
  accessors = [];

  /** Parte do buffer original: índices de accessors e bufferViews existentes continuam válidos. */
  static extending({ json, bin }) {
    const writer = new GlbWriter();
    writer.bufferViews = [...json.bufferViews];
    writer.accessors = [...json.accessors];
    writer.view(bin);
    writer.bufferViews.pop();
    return writer;
  }

  view(bytes) {
    this.bufferViews.push({ buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength });
    const padded = Buffer.alloc(Math.ceil(bytes.byteLength / 4) * 4);
    padded.set(bytes);
    this.chunks.push(padded);
    this.byteLength += padded.byteLength;
    return this.bufferViews.length - 1;
  }

  accessor(array, type, bounds = false) {
    const n = COMPONENTS[type];
    const componentType = Object.keys(TYPED).find((k) => TYPED[k] === array.constructor);
    const a = {
      bufferView: this.view(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)),
      componentType: Number(componentType),
      count: array.length / n,
      type,
    };
    if (bounds) {
      a.min = Array(n).fill(Infinity);
      a.max = Array(n).fill(-Infinity);
      array.forEach((v, i) => {
        a.min[i % n] = Math.min(a.min[i % n], v);
        a.max[i % n] = Math.max(a.max[i % n], v);
      });
    }
    this.accessors.push(a);
    return this.accessors.length - 1;
  }

  write(file, json) {
    const body = Buffer.from(JSON.stringify({ ...json, bufferViews: this.bufferViews, accessors: this.accessors, buffers: [{ byteLength: this.byteLength }] }));
    const jsonChunk = Buffer.alloc(Math.ceil(body.length / 4) * 4, 0x20);
    body.copy(jsonChunk);
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + jsonChunk.length + this.byteLength, 8);
    header.writeUInt32LE(jsonChunk.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(this.byteLength, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    fs.writeFileSync(file, Buffer.concat([header, jsonChunk, binHeader, ...this.chunks]));
  }
}

function rayHitsTriangle(o, d, a, b, c, maxT) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return false;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
  if (u < 0 || u > 1) return false;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
  if (v < 0 || u + v > 1) return false;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
  return t >= 0 && t <= maxT;
}

/** Remove triângulos cujos três vértices têm uma peça de roupa logo à frente da normal. */
function cullCovered(mesh, covers) {
  const tri = [];
  for (const c of covers) {
    for (let i = 0; i < c.indices.length; i += 3) {
      tri.push([0, 1, 2].map((k) => Array.from(c.positions.subarray(c.indices[i + k] * 3, c.indices[i + k] * 3 + 3))));
    }
  }
  const covered = new Uint8Array(mesh.positions.length / 3);
  for (let v = 0; v < covered.length; v++) {
    const o = Array.from(mesh.positions.subarray(v * 3, v * 3 + 3));
    const d = Array.from(mesh.normals.subarray(v * 3, v * 3 + 3));
    covered[v] = tri.some(([a, b, c]) => rayHitsTriangle(o, d, a, b, c, COVER_DISTANCE)) ? 1 : 0;
  }
  const kept = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    if (!(covered[a] && covered[b] && covered[c])) kept.push(a, b, c);
  }
  return { ...mesh, indices: Uint32Array.from(kept) };
}

/** Mantém só os vértices usados pela malha reduzida. */
function compact(mesh, indices) {
  const remap = new Map();
  const remapped = Uint32Array.from(indices, (v) => {
    if (!remap.has(v)) remap.set(v, remap.size);
    return remap.get(v);
  });
  const old = [...remap.keys()];
  const take = (array, n) => {
    const out = new array.constructor(old.length * n);
    old.forEach((v, i) => out.set(array.subarray(v * n, v * n + n), i * n));
    return out;
  };
  return { ...mesh, indices: remapped, positions: take(mesh.positions, 3), uvs: take(mesh.uvs, 2), joints: take(mesh.joints, 4), weights: take(mesh.weights, 4) };
}

/** Abre a boca: o lábio inferior e o queixo descem, sumindo em direção aos cantos e ao pescoço. */
function jawOpenDeltas(positions) {
  const deltas = new Float32Array(positions.length);
  for (let v = 0; v < positions.length / 3; v++) {
    const [x, y, z] = positions.subarray(v * 3, v * 3 + 3);
    if (y > MOUTH.lipLine || y < MOUTH.chin || z < MOUTH.front || Math.abs(x) > MOUTH.halfWidth) continue;
    const across = 1 - (x / MOUTH.halfWidth) ** 2;
    deltas[v * 3 + 1] = -MOUTH.drop * across;
    deltas[v * 3 + 2] = -0.004 * across;
  }
  return deltas;
}

/** Elipse escura entre os lábios, achatada em repouso (invisível) e aberta pelo morph. */
function mouthMesh(head) {
  const count = MOUTH_SEGMENTS + 1;
  const positions = new Float32Array(count * 3);
  const deltas = new Float32Array(count * 3);
  positions.set([0, MOUTH.center, MOUTH.z]);
  for (let i = 0; i < MOUTH_SEGMENTS; i++) {
    const a = (i / MOUTH_SEGMENTS) * Math.PI * 2;
    const x = Math.cos(a) * MOUTH.width;
    positions.set([x, MOUTH.center, MOUTH.z - 40 * x * x], (i + 1) * 3);
    deltas[(i + 1) * 3 + 1] = (Math.sin(a) * MOUTH.openHeight) / 2;
  }
  const indices = new Uint32Array(MOUTH_SEGMENTS * 3);
  for (let i = 0; i < MOUTH_SEGMENTS; i++) indices.set([0, i + 1, ((i + 1) % MOUTH_SEGMENTS) + 1], i * 3);
  const joints = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    joints[v * 4] = head;
    weights[v * 4] = 1;
  }
  return { positions, deltas, indices, joints, weights };
}

function shrinkTexture(bytes, size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polytale-texture-'));
  const source = path.join(dir, 'in');
  const target = path.join(dir, 'out.png');
  fs.writeFileSync(source, bytes);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-vf', `scale=${size}:${size}:flags=area,format=rgba`, '-frames:v', '1', target]);
  const out = fs.readFileSync(target);
  fs.rmSync(dir, { recursive: true });
  return out;
}

// O FBXLoader tenta carregar as texturas do arquivo; aqui só importam ossos e trilhas.
globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };

function loadClip(file) {
  const bytes = fs.readFileSync(file);
  const scene = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '');
  let hips = null;
  scene.traverse((o) => {
    if (o.isBone && o.name === 'Hips') hips = o;
  });
  return { name: path.basename(file, path.extname(file)), clip: scene.animations[0], hipsRest: hips.position.toArray() };
}

/** Compensa a diferença de altura entre os rigs e remove o deslocamento de clipes que não vieram "In Place". */
function hipsTrack(values, fbxRest, glbRest) {
  const out = Float32Array.from(values);
  const frames = out.length / 3;
  for (const axis of [0, 1, 2]) {
    const drift = axis === 1 ? 0 : values[(frames - 1) * 3 + axis] - values[axis];
    const inPlace = Math.abs(drift) > 0.3;
    for (let f = 0; f < frames; f++) {
      const offset = inPlace ? glbRest[axis] - values[axis] - (drift * f) / (frames - 1) : glbRest[axis] - fbxRest[axis];
      out[f * 3 + axis] += offset;
    }
  }
  return out;
}

await MeshoptSimplifier.ready;
MeshoptSimplifier.useExperimentalFeatures = true;
const glb = readGlb(input);
const { json } = glb;
const writer = full ? GlbWriter.extending(glb) : new GlbWriter();

/** Malhas e materiais reduzidos, gravados em `writer`. */
function buildLowPoly() {
  const meshes = json.meshes.map((m) => {
    const p = m.primitives[0];
    const a = p.attributes;
    const weights = readWeights(glb, a.WEIGHTS_0);
    // Só o primeiro conjunto de influências chega ao three.js: os pesos precisam somar 1 sem o segundo.
    for (let i = 0; i < weights.length; i += MAX_INFLUENCES) {
      const sum = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3] || 1;
      for (let k = 0; k < MAX_INFLUENCES; k++) weights[i + k] /= sum;
    }
    return {
      name: m.name,
      material: json.materials[p.material],
      positions: readAccessor(glb, a.POSITION),
      normals: readAccessor(glb, a.NORMAL),
      uvs: readAccessor(glb, a.TEXCOORD_0),
      joints: readAccessor(glb, a.JOINTS_0),
      weights,
      indices: Uint32Array.from(readAccessor(glb, p.indices)),
    };
  });

  const clothes = meshes.filter((m) => /look|shoes/.test(m.name));
  const reduced = meshes.map((source) => {
    const mesh = /body/.test(source.name) ? cullCovered(source, clothes) : source;
    const { tris } = TARGETS[mesh.name] ?? DEFAULT_TARGET;
    const [indices] = MeshoptSimplifier.simplifyWithAttributes(mesh.indices, mesh.positions, 3, mesh.uvs, 2, [0.5, 0.5], null, tris * 3, 1);
    console.log(`${mesh.name}: ${source.indices.length / 3} -> ${mesh.indices.length / 3} (roupa) -> ${indices.length / 3} tris`);
    return compact(mesh, indices);
  });

  const images = [];
  const textures = [];
  const materials = reduced.map((m) => {
    const source = json.images[json.textures[m.material.pbrMetallicRoughness.baseColorTexture.index].source];
    const view = json.bufferViews[source.bufferView];
    const bytes = glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    images.push({ bufferView: writer.view(shrinkTexture(bytes, (TARGETS[m.name] ?? DEFAULT_TARGET).texture)), mimeType: 'image/png' });
    textures.push({ source: images.length - 1, sampler: 0 });
    const blend = m.material.alphaMode === 'BLEND';
    return {
      name: m.material.name,
      pbrMetallicRoughness: { baseColorTexture: { index: textures.length - 1 }, metallicFactor: 0, roughnessFactor: 1 },
      doubleSided: true,
      // Transparência com recorte: cabelo em cartões não sofre com a ordem de desenho.
      ...(blend ? { alphaMode: 'MASK', alphaCutoff: 0.5 } : {}),
    };
  });

  const jaw = (deltas) => ({ targets: [{ POSITION: writer.accessor(deltas, 'VEC3', true) }] });
  const jawMesh = { weights: [0], extras: { targetNames: ['jawOpen'] } };
  const outMeshes = reduced.map((m, i) => ({
    name: m.name,
    primitives: [
      {
        material: i,
        indices: writer.accessor(m.indices, 'SCALAR'),
        attributes: {
          POSITION: writer.accessor(m.positions, 'VEC3', true),
          TEXCOORD_0: writer.accessor(m.uvs, 'VEC2'),
          JOINTS_0: writer.accessor(m.joints, 'VEC4'),
          WEIGHTS_0: writer.accessor(m.weights, 'VEC4'),
        },
        ...(/body/.test(m.name) ? jaw(jawOpenDeltas(m.positions)) : {}),
      },
    ],
    ...(/body/.test(m.name) ? jawMesh : {}),
  }));

  const mouth = mouthMesh(json.skins[0].joints.findIndex((node) => json.nodes[node].name === 'Head'));
  materials.push({ name: 'mouth', pbrMetallicRoughness: { baseColorFactor: [0.09, 0.02, 0.02, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true });
  outMeshes.push({
    name: 'mouth',
    primitives: [
      {
        material: materials.length - 1,
        indices: writer.accessor(mouth.indices, 'SCALAR'),
        attributes: {
          POSITION: writer.accessor(mouth.positions, 'VEC3', true),
          JOINTS_0: writer.accessor(mouth.joints, 'VEC4'),
          WEIGHTS_0: writer.accessor(mouth.weights, 'VEC4'),
        },
        ...jaw(mouth.deltas),
      },
    ],
    ...jawMesh,
  });
  const nodes = [...json.nodes, { name: 'mouth', mesh: outMeshes.length - 1, skin: 0 }];
  const scenes = json.scenes.map((scene, i) => (i === (json.scene ?? 0) ? { ...scene, nodes: [...scene.nodes, nodes.length - 1] } : scene));

  const skins = json.skins.map((s) => ({ ...s, inverseBindMatrices: writer.accessor(readAccessor(glb, s.inverseBindMatrices), 'MAT4') }));

  return {
    meshes: outMeshes,
    nodes,
    scenes,
    skins: json.skins.map((s) => ({ ...s, inverseBindMatrices: writer.accessor(readAccessor(glb, s.inverseBindMatrices), 'MAT4') })),
    materials,
    textures,
    images,
    samplers: [{ magFilter: GL.NEAREST, minFilter: GL.NEAREST }],
  };
}

const nodeIndex = new Map(json.nodes.map((n, i) => [n.name, i]));
const animations = json.animations.map((a, i) => ({
  name: i === 0 ? 'Idle' : a.name,
  channels: a.channels,
  samplers: a.samplers.map((s) => ({
    interpolation: s.interpolation,
    input: writer.accessor(readAccessor(glb, s.input), 'SCALAR', true),
    output: writer.accessor(readAccessor(glb, s.output), json.accessors[s.output].type),
  })),
}));

for (const file of clipFiles) {
  const { name, clip, hipsRest } = loadClip(file);
  const channels = [];
  const samplers = [];
  for (const track of clip.tracks) {
    const [bone, property] = track.name.split('.');
    const node = nodeIndex.get(bone);
    if (node === undefined) continue;
    const translation = property === 'position';
    const values = translation ? hipsTrack(track.values, hipsRest, json.nodes[node].translation) : Float32Array.from(track.values);
    channels.push({ sampler: samplers.length, target: { node, path: translation ? 'translation' : 'rotation' } });
    samplers.push({
      interpolation: 'LINEAR',
      input: writer.accessor(Float32Array.from(track.times), 'SCALAR', true),
      output: writer.accessor(values, translation ? 'VEC3' : 'VEC4'),
    });
  }
  animations.push({ name, channels, samplers });
  console.log(`clipe ${name}: ${clip.duration.toFixed(2)}s, ${channels.length} trilhas`);
}

const assets = full ? {} : buildLowPoly();
writer.write(output, { ...json, ...assets, asset: { version: '2.0', generator: 'Polytale build-character' }, animations });
console.log(`${output}: ${(fs.statSync(output).size / 1024).toFixed(0)} KB`);

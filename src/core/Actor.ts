import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  JOINTS,
  type ActorFrame,
  type ActorObjectDef,
  type BodyPart,
  type Expression,
  type GestureDef,
  type Hand,
  type Joint,
  type ObjectFrame,
  type PoseFrame,
  type Socket,
} from '../timeline/types';
import { restPoseFrame, sampleGesture } from '../timeline/poses';
import type { AssetLoader } from './AssetLoader';
import type { LipsyncState } from '../systems/AudioLipsync';
import { DEG2RAD, clamp, clamp01, damp, fbm1D, hashString, lerp, seededRandom, smoothstep } from '../utils/math';
import { EXPRESSION_PRESETS, MorphController, zeroMorphs, type MorphName, type MorphWeights } from './ActorFace';
import { ADDITIVE_JOINTS, BASE_HEIGHT, buildGltfRig, buildProceduralRig, type GltfRig, type ProceduralRig, type Rig } from './ActorRig';
import { solveTwoBoneIK } from './IK';

/* ========================================================================== */
/*  Actor                                                                     */
/* ========================================================================== */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _pole = new THREE.Vector3();

/**
 * Personagem: encapsula malha 3D, morph targets (rosto) e a "vida" procedural.
 *
 * Fluxo por quadro:
 *  1. `applyFrame()` — estado vindo da timeline (transform, expressão, gesto, clipe).
 *  2. `setLipsync()` / `setLookTarget()` — entradas de áudio e olhar.
 *  3. `update(deltaTime)` — respiração, piscar, sacadas, caminhada, gestos e morphs.
 */
export class Actor {
  readonly root = new THREE.Group();
  private readonly rig: Rig;
  private readonly morphs: MorphController;
  private readonly rand: () => number;
  private readonly seed: number;

  // Estado vindo da timeline
  private expression: ActorFrame['expression'] | null = null;
  private gesture: { name: string; progress: number } | null = null;
  private pose: PoseFrame = restPoseFrame();
  private gestureLibrary: Readonly<Record<string, GestureDef>> = {};
  private readonly reach: Record<Hand, { point: THREE.Vector3; weight: number; shake: number }> = {
    left: { point: new THREE.Vector3(), weight: 0, shake: 0 },
    right: { point: new THREE.Vector3(), weight: 0, shake: 0 },
  };
  private readonly bodyScale: number;
  private clip: ActorFrame['clip'] = null;
  private timelineTime = 0;
  private lipsync: LipsyncState = { jawOpen: 0, mouthWide: 0, mouthPucker: 0, energy: 0, speaking: false };
  private lookTarget: THREE.Vector3 | null = null;

  // Vida procedural
  private clock = 0;
  private readonly breathPeriod: number;
  private blinkTimer: number;
  private blinkT = -1;
  private doubleBlink = false;
  private saccadeTimer = 0;
  private readonly saccadeOffset = new THREE.Vector3();
  private readonly gazeLocal = new THREE.Vector2();
  private headYaw = 0;
  private headPitch = 0;
  private talkAmount = 0;

  // Locomoção
  private readonly lastWorldPos = new THREE.Vector3();
  private hasLastPos = false;
  private speed = 0;
  private walkPhase = 0;
  private walkAmount = 0;

  // Mixer GLTF
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private idleAction: THREE.AnimationAction | null = null;

  constructor(
    readonly id: string,
    readonly def: ActorObjectDef,
    gltf?: GLTF,
    assets?: AssetLoader,
  ) {
    this.seed = hashString(id);
    this.rand = seededRandom(this.seed);
    this.breathPeriod = 3.4 + this.rand() * 1.2;
    this.blinkTimer = 1 + this.rand() * 3;

    this.rig = gltf ? buildGltfRig(gltf) : buildProceduralRig(def, assets);
    const scale = gltf ? 1 : (def.height ?? 1.75) / BASE_HEIGHT;
    this.bodyScale = scale;
    this.rig.body.scale.setScalar(scale);
    this.root.add(this.rig.body);
    this.root.name = `actor:${id}`;
    this.root.visible = false;
    this.morphs = new MorphController(this.rig.body);

    if (this.rig.kind === 'gltf' && def.idleClip) {
      const clip = THREE.AnimationClip.findByName(this.rig.clips, def.idleClip);
      if (clip) {
        this.idleAction = this.rig.mixer.clipAction(clip);
        this.idleAction.play();
      } else console.warn(`[Actor:${id}] clipe idle '${def.idleClip}' não encontrado`);
    }
  }

  get name(): string {
    return this.def.name;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** Aplica o estado determinístico da timeline. */
  applyFrame(obj: ObjectFrame, actor: ActorFrame, timelineTime: number): void {
    const wasVisible = this.root.visible;
    this.root.visible = obj.visible;
    this.root.position.set(obj.position[0], obj.position[1], obj.position[2]);
    this.root.rotation.set(obj.rotation[0] * DEG2RAD, obj.rotation[1] * DEG2RAD, obj.rotation[2] * DEG2RAD, 'YXZ');
    this.root.scale.setScalar(obj.scale);
    this.expression = actor.expression;
    this.gesture = actor.gesture;
    this.clip = actor.clip;
    this.pose = actor.pose;
    this.timelineTime = timelineTime;
    if (!wasVisible && obj.visible) this.hasLastPos = false;
  }

  /** Gestos customizados (keyframes) disponíveis para PLAY_GESTURE. */
  setGestureLibrary(library: Readonly<Record<string, GestureDef>>): void {
    this.gestureLibrary = library;
  }

  /** Alvo da mão (IK) no mundo; `weight` 0 = braço livre. */
  setReach(hand: Hand, point: THREE.Vector3 | null, weight: number, shake = 0): void {
    const r = this.reach[hand];
    r.weight = point ? clamp01(weight) : 0;
    r.shake = shake;
    if (point) r.point.copy(point);
  }

  /** Transformação de mundo de um encaixe (mão, cabeça, costas, peito). */
  getSocketWorld(socketName: Socket, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const s = this.rig.sockets[socketName];
    s.getWorldPosition(outPos);
    s.getWorldQuaternion(outQuat);
  }

  /** Posição de mundo de uma parte do corpo (alvos de REACH). */
  getPartWorldPosition(part: BodyPart, out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    switch (part) {
      case 'head':
        return this.rig.headCenter.getWorldPosition(out);
      case 'chest':
        return this.rig.sockets.chest.getWorldPosition(out);
      case 'back':
        return this.rig.sockets.back.getWorldPosition(out);
      case 'handL':
        return this.rig.sockets.handL.getWorldPosition(out);
      case 'handR':
        return this.rig.sockets.handR.getWorldPosition(out);
      case 'shoulderL':
      case 'shoulderR': {
        const j = this.rig.joints[part];
        if (j) return j.getWorldPosition(out);
        return this.rig.chestCenter.getWorldPosition(out);
      }
      case 'root':
      default:
        return out.copy(this.root.position);
    }
  }

  setLipsync(state: LipsyncState): void {
    this.lipsync = state;
  }

  /** Alvo do olhar no mundo (null = olhar livre para frente). */
  setLookTarget(target: THREE.Vector3 | null): void {
    if (!target) this.lookTarget = null;
    else (this.lookTarget ??= new THREE.Vector3()).copy(target);
  }

  getHeadWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.rig.headCenter.getWorldPosition(out);
  }

  getChestWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.rig.chestCenter.getWorldPosition(out);
  }

  /** Direção para onde o corpo está voltado (plano XZ). */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.root.quaternion).setY(0).normalize();
  }

  /** Vida procedural — roda sempre, independentemente da timeline estar pausada. */
  update(deltaTime: number): void {
    const dt = Math.min(deltaTime, 0.1);
    this.clock += dt;

    this.updateLocomotion(dt);
    this.updateBlink(dt);
    this.updateSaccades(dt);
    this.talkAmount = damp(this.talkAmount, this.lipsync.speaking ? clamp01(this.lipsync.energy * 1.6) : 0, 6, dt);

    if (this.rig.kind === 'procedural') this.updateProceduralBody(this.rig, dt);
    else this.updateGltfBody(this.rig, dt);

    this.applyPoseLayers();
    this.applyReachIK();
    this.updateFace();
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => m.dispose());
    });
    if (this.rig.kind === 'gltf') this.rig.mixer.stopAllAction();
    this.root.removeFromParent();
  }

  /* ---------------------------------------------------------------------- */
  /*  Lógicas procedurais                                                   */
  /* ---------------------------------------------------------------------- */

  /** Velocidade estimada a partir do deslocamento real (alimenta o ciclo de caminhada). */
  private updateLocomotion(dt: number): void {
    const pos = _v.copy(this.root.position);
    if (this.hasLastPos && dt > 0) {
      const dist = Math.hypot(pos.x - this.lastWorldPos.x, pos.z - this.lastWorldPos.z);
      // Saltos grandes (seek) não contam como caminhada.
      const instant = dist > 0.5 ? 0 : dist / dt;
      this.speed = damp(this.speed, instant, 10, dt);
    }
    this.lastWorldPos.copy(pos);
    this.hasLastPos = true;
    const STRIDE = 1.15;
    this.walkPhase += (this.speed / STRIDE) * Math.PI * 2 * dt;
    this.walkAmount = damp(this.walkAmount, clamp01(this.speed / 1.1), 8, dt);
  }

  /** Piscar aleatório: timer 2–5s dispara um tween de ida-e-volta de 0.15s no morph eyeBlink. */
  private updateBlink(dt: number): void {
    const BLINK = 0.15;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      if (this.blinkT >= BLINK) {
        this.blinkT = -1;
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.blinkTimer = 0.12;
        } else this.blinkTimer = 2 + this.rand() * 3;
      }
    } else {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkT = 0;
        this.doubleBlink = this.rand() < 0.15;
      }
    }
  }

  private blinkValue(): number {
    if (this.blinkT < 0) return 0;
    return Math.sin(Math.PI * clamp01(this.blinkT / 0.15));
  }

  /** Micro-saltos do olhar: a cada 0.25–1.4s o alvo recebe um deslocamento aleatório milimétrico. */
  private updateSaccades(dt: number): void {
    this.saccadeTimer -= dt;
    if (this.saccadeTimer <= 0) {
      this.saccadeTimer = 0.25 + this.rand() * 1.15;
      const r = 0.035;
      this.saccadeOffset.set((this.rand() - 0.5) * 2 * r, (this.rand() - 0.5) * 2 * r * 0.6, (this.rand() - 0.5) * 2 * r);
    }
  }

  /** Alvo do olhar com ruído contínuo (fbm) + sacada; null se olhar livre. */
  private noisyLookTarget(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.lookTarget) return null;
    const t = this.clock * 0.6;
    out.copy(this.lookTarget).add(this.saccadeOffset);
    out.x += fbm1D(t, this.seed % 97) * 0.05;
    out.y += fbm1D(t + 31, this.seed % 89) * 0.03;
    out.z += fbm1D(t + 77, this.seed % 83) * 0.05;
    return out;
  }

  private expressionPose(): { morphs: MorphWeights; headPitch: number; headRoll: number; slump: number; gazeUp: number } {
    const morphs = zeroMorphs();
    let headPitch = 0;
    let headRoll = 0;
    let slump = 0;
    let gazeUp = 0;
    if (this.expression) {
      for (const [name, w] of Object.entries(this.expression) as [Expression, number][]) {
        if (w <= 0) continue;
        const p = EXPRESSION_PRESETS[name];
        for (const [m, v] of Object.entries(p.morphs) as [MorphName, number][]) morphs[m] += v * w;
        headPitch += (p.headPitch ?? 0) * w;
        headRoll += (p.headRoll ?? 0) * w;
        slump += (p.slump ?? 0) * w;
        gazeUp += (p.gazeUp ?? 0) * w;
      }
    }
    return { morphs, headPitch, headRoll, slump, gazeUp };
  }

  private gestureEnvelope(): number {
    if (!this.gesture) return 0;
    const p = this.gesture.progress;
    return smoothstep(0, 0.18, p) * (1 - smoothstep(0.82, 1, p));
  }

  /** Yaw/pitch (rad) do alvo no espaço local do corpo, a partir de um ponto de referência. */
  private localAngles(from: THREE.Vector3, target: THREE.Vector3): { yaw: number; pitch: number } {
    this.root.updateMatrixWorld();
    const inv = _m.copy(this.root.matrixWorld).invert();
    const a = _v2.copy(target).applyMatrix4(inv);
    const b = from.clone().applyMatrix4(inv);
    a.sub(b);
    const yaw = Math.atan2(a.x, a.z);
    const pitch = -Math.atan2(a.y, Math.hypot(a.x, a.z));
    return { yaw, pitch };
  }

  private updateProceduralBody(rig: ProceduralRig, dt: number): void {
    const t = this.clock;
    const expr = this.expressionPose();
    const env = this.gestureEnvelope();
    const g = this.gesture;
    const gp = g?.progress ?? 0;

    // ---- Respiração: senoide lenta transladando/rotacionando o peito ----
    const breath = Math.sin((t * Math.PI * 2) / this.breathPeriod);
    rig.chest.position.y = rig.chestBaseY + breath * 0.006;
    rig.chest.rotation.set(breath * -0.012 + expr.slump * 0.12, 0, 0);
    rig.hips.rotation.set(0, 0, 0);
    rig.chest.scale.set(1 + breath * 0.012, 1, 1 + breath * 0.018);

    // ---- Balanço idle / transferência de peso ----
    const sway = fbm1D(t * 0.25, this.seed % 53);
    rig.body.rotation.z = sway * 0.02;
    rig.hips.position.x = sway * 0.015;

    // ---- Caminhada ----
    const w = this.walkAmount;
    const ph = this.walkPhase;
    rig.hips.position.y = 0.92 + Math.abs(Math.sin(ph)) * 0.035 * w - 0.015 * w;
    // Rotações sempre definidas por completo: a camada de pose/IK do quadro anterior não "vaza".
    rig.legL.upper.rotation.set(Math.sin(ph) * 0.6 * w, 0, 0);
    rig.legR.upper.rotation.set(-Math.sin(ph) * 0.6 * w, 0, 0);
    rig.legL.lower.rotation.set(Math.max(0, Math.sin(ph + Math.PI * 0.5)) * 0.9 * w, 0, 0);
    rig.legR.lower.rotation.set(Math.max(0, Math.sin(ph - Math.PI * 0.5)) * 0.9 * w, 0, 0);

    // ---- Braços: repouso + caminhada + fala + gestos ----
    const talk = this.talkAmount;
    const talkL = fbm1D(t * 1.3, (this.seed % 41) + 1) * talk;
    const talkR = fbm1D(t * 1.3, (this.seed % 37) + 9) * talk;

    let lShX = -Math.sin(ph) * 0.45 * w + talkL * 0.25 - talk * 0.15;
    let lShZ = 0.1 + breath * 0.01 + expr.slump * -0.04;
    let lEl = -0.15 - talk * 0.5 + talkL * 0.3 - w * 0.25;
    let rShX = Math.sin(ph) * 0.45 * w + talkR * 0.25 - talk * 0.15;
    let rShZ = -0.1 - breath * 0.01 + expr.slump * 0.04;
    let rEl = -0.15 - talk * 0.5 + talkR * 0.3 - w * 0.25;
    let shoulderLift = expr.slump * -0.015;
    let headPitchG = 0;
    let headYawG = 0;
    let spineBow = 0;

    if (g) {
      switch (g.name) {
        case 'wave':
          rShZ = lerp(rShZ, -2.55, env);
          rShX = lerp(rShX, -0.2, env);
          rEl = lerp(rEl, Math.sin(gp * Math.PI * 9) * 0.45, env);
          break;
        case 'point':
          rShX = lerp(rShX, -1.45, env);
          rShZ = lerp(rShZ, -0.12, env);
          rEl = lerp(rEl, -0.05, env);
          break;
        case 'shrug':
          shoulderLift += 0.045 * env;
          lShZ = lerp(lShZ, 0.35, env);
          rShZ = lerp(rShZ, -0.35, env);
          lEl = lerp(lEl, -1.3, env);
          rEl = lerp(rEl, -1.3, env);
          headPitchG = -0.04 * env;
          break;
        case 'nod':
          headPitchG = Math.sin(gp * Math.PI * 4) * 0.22 * env;
          break;
        case 'headShake':
          headYawG = Math.sin(gp * Math.PI * 6) * 0.35 * env;
          break;
        case 'bow': {
          const bell = Math.sin(Math.PI * gp);
          spineBow = 0.65 * bell;
          headPitchG = 0.2 * bell;
          lShX = lerp(lShX, 0.25, bell);
          rShX = lerp(rShX, 0.25, bell);
          break;
        }
      }
    }

    rig.armL.upper.rotation.set(lShX, 0, lShZ);
    rig.armR.upper.rotation.set(rShX, 0, rShZ);
    rig.armL.lower.rotation.set(lEl, 0, 0);
    rig.armR.lower.rotation.set(g?.name === 'wave' ? -0.3 * env + rEl * (1 - env) : rEl, 0, g?.name === 'wave' ? rEl * env : 0);
    rig.armL.upper.position.y = 0.47 + shoulderLift + breath * 0.004;
    rig.armR.upper.position.y = 0.47 + shoulderLift + breath * 0.004;
    rig.chest.rotation.x += spineBow;
    if (rig.cape) rig.cape.rotation.set(0.1 + w * 0.55 + fbm1D(t * 0.9, (this.seed % 19) + 2) * 0.06 - expr.slump * 0.05, 0, 0);

    // ---- Cabeça: LookAt amortecido com ruído + gestos + fala ----
    let targetYaw = fbm1D(t * 0.15, (this.seed % 29) + 3) * 0.15;
    let targetPitch = fbm1D(t * 0.12, (this.seed % 31) + 5) * 0.05 - expr.gazeUp * 0.08;
    const look = this.noisyLookTarget(_v);
    if (look) {
      // Origem na altura dos olhos (pivô da cabeça + meia cabeça), independente da rotação atual.
      rig.head.updateMatrixWorld();
      const from = rig.head.getWorldPosition(new THREE.Vector3());
      from.y += 0.24 * this.bodyScale;
      const a = this.localAngles(from, look);
      targetYaw = clamp(a.yaw, -1.2, 1.2);
      targetPitch = clamp(a.pitch, -0.6, 0.6);
    }
    this.headYaw = damp(this.headYaw, targetYaw, 5, dt);
    this.headPitch = damp(this.headPitch, targetPitch, 5, dt);

    const talkNod = Math.sin(t * 7.3) * 0.04 * talk;
    const pitch = this.headPitch + expr.headPitch + headPitchG + talkNod - spineBow * 0.5;
    const yaw = this.headYaw + headYawG;
    rig.neck.rotation.set(pitch * 0.4, yaw * 0.4, expr.headRoll * 0.4, 'YXZ');
    rig.head.rotation.set(pitch * 0.6, yaw * 0.6, expr.headRoll * 0.6 + sway * 0.03, 'YXZ');

    // ---- Olhos: pupilas seguem o alvo (com sacadas) ----
    let gx = fbm1D(t * 0.4, (this.seed % 23) + 11) * 0.3;
    let gy = expr.gazeUp * 0.6;
    if (look) {
      // Ângulo residual não coberto pela cabeça.
      rig.head.updateMatrixWorld();
      const eyePos = rig.headCenter.getWorldPosition(new THREE.Vector3());
      const inv = _m.copy(rig.head.matrixWorld).invert();
      const dir = look.clone().applyMatrix4(inv).sub(eyePos.applyMatrix4(inv));
      gx = clamp(Math.atan2(dir.x, dir.z) * 1.6, -1, 1);
      gy = clamp(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) * 1.6, -1, 1);
    }
    // Sacadas são rápidas (lambda alto) — micro-saltos visíveis nas pupilas.
    this.gazeLocal.x = damp(this.gazeLocal.x, gx, 35, dt);
    this.gazeLocal.y = damp(this.gazeLocal.y, gy, 35, dt);
    for (const p of rig.pupils) p.position.set(this.gazeLocal.x * 0.02, this.gazeLocal.y * 0.017, 0.001);

    const wide = expr.morphs.eyeWide;
    for (const e of rig.eyes) e.scale.setScalar(1 + wide * 0.18);
  }

  private updateGltfBody(rig: GltfRig, dt: number): void {
    // Ossos voltam ao repouso antes do mixer: camadas aditivas não acumulam entre quadros.
    for (const [bone, q] of rig.rest) bone.quaternion.copy(q);
    rig.body.position.y = 0;
    this.updateMixer(rig, dt);
    const t = this.clock;
    const expr = this.expressionPose();
    const breath = Math.sin((t * Math.PI * 2) / this.breathPeriod);

    if (rig.spineBone) {
      _q.setFromEuler(_e.set(breath * -0.015 + expr.slump * 0.1, 0, 0));
      rig.spineBone.quaternion.multiply(_q);
      rig.spineBone.position.y += breath * 0.002;
    }

    let targetYaw = fbm1D(t * 0.15, (this.seed % 29) + 3) * 0.15;
    let targetPitch = fbm1D(t * 0.12, (this.seed % 31) + 5) * 0.05;
    const look = this.noisyLookTarget(_v);
    if (look) {
      const from = this.getHeadWorldPosition(new THREE.Vector3());
      const a = this.localAngles(from, look);
      targetYaw = clamp(a.yaw, -1.1, 1.1);
      targetPitch = clamp(a.pitch, -0.5, 0.5);
    }
    this.headYaw = damp(this.headYaw, targetYaw, 5, dt);
    this.headPitch = damp(this.headPitch, targetPitch, 5, dt);

    const g = this.gesture;
    const env = this.gestureEnvelope();
    let gPitch = 0;
    let gYaw = 0;
    if (g?.name === 'nod') gPitch = Math.sin(g.progress * Math.PI * 4) * 0.22 * env;
    if (g?.name === 'headShake') gYaw = Math.sin(g.progress * Math.PI * 6) * 0.35 * env;
    const talkNod = Math.sin(t * 7.3) * 0.04 * this.talkAmount;

    const pitch = this.headPitch + expr.headPitch + gPitch + talkNod;
    const yaw = this.headYaw + gYaw;
    if (rig.neckBone) rig.neckBone.quaternion.multiply(_q.setFromEuler(_e.set(pitch * 0.4, yaw * 0.4, expr.headRoll * 0.4, 'YXZ')));
    if (rig.headBone) {
      const k = rig.neckBone ? 0.6 : 1;
      rig.headBone.quaternion.multiply(_q.setFromEuler(_e.set(pitch * k, yaw * k, expr.headRoll * k, 'YXZ')));
    }
  }

  /** Clipes GLTF amostrados deterministicamente pelo tempo da timeline (seek-safe). */
  private updateMixer(rig: GltfRig, dt: number): void {
    const clipState = this.clip;
    const action = (name: string): THREE.AnimationAction | null => {
      let a = this.actions.get(name);
      if (!a) {
        const clip = THREE.AnimationClip.findByName(rig.clips, name);
        if (!clip) return null;
        a = rig.mixer.clipAction(clip);
        this.actions.set(name, a);
      }
      return a;
    };
    const place = (a: THREE.AnimationAction, startAt: number, loop: boolean, weight: number) => {
      const d = a.getClip().duration;
      let local = Math.max(0, this.timelineTime - startAt);
      local = loop ? local % d : Math.min(local, d - 1e-4);
      a.enabled = true;
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = true;
      a.paused = true; // tempo controlado manualmente
      a.time = local;
      a.setEffectiveWeight(weight);
      if (!a.isRunning()) a.play();
    };

    for (const a of this.actions.values()) a.setEffectiveWeight(0);
    if (clipState) {
      const cur = action(clipState.name);
      const w = clipState.fade > 0 ? clamp01((this.timelineTime - clipState.startAt) / clipState.fade) : 1;
      if (cur) place(cur, clipState.startAt, clipState.loop, w);
      if (clipState.prev && w < 1) {
        const prev = action(clipState.prev.name);
        if (prev) place(prev, clipState.prev.startAt, clipState.prev.loop, 1 - w);
      }
      if (this.idleAction) this.idleAction.setEffectiveWeight(cur ? 0 : 1);
    } else if (this.idleAction) {
      this.idleAction.setEffectiveWeight(1);
    }
    if (this.idleAction) this.idleAction.paused = false;
    rig.mixer.update(dt);
  }

  /** Camadas de pose: SET_POSE e gestos customizados (keyframes), sobre a animação procedural. */
  private applyPoseLayers(): void {
    const rig = this.rig;
    const custom = this.gesture ? this.gestureLibrary[this.gesture.name] : undefined;
    const g = custom && this.gesture ? sampleGesture(custom, this.gesture.progress) : null;

    for (const j of JOINTS) {
      const obj = rig.joints[j];
      if (!obj) continue;
      const pj = this.pose.joints[j];
      if (pj.w > 0.001) this.applyJoint(obj, j, pj.rot, pj.w);
      const gr = g?.joints[j];
      if (g && gr && g.weight > 0.001) this.applyJoint(obj, j, gr, g.weight);
    }

    const crouch = this.pose.crouch + (g ? g.crouch * g.weight : 0);
    if (rig.kind === 'procedural') rig.hips.position.y -= crouch / this.bodyScale;
    else rig.body.position.y = -crouch;
  }

  private applyJoint(obj: THREE.Object3D, joint: Joint, rotDeg: readonly number[], w: number): void {
    const x = rotDeg[0] * DEG2RAD;
    const y = rotDeg[1] * DEG2RAD;
    const z = rotDeg[2] * DEG2RAD;
    if (this.rig.kind === 'gltf' || ADDITIVE_JOINTS.has(joint)) {
      obj.quaternion.multiply(_q.setFromEuler(_e.set(x * w, y * w, z * w)));
    } else {
      obj.rotation.x = lerp(obj.rotation.x, x, w);
      obj.rotation.y = lerp(obj.rotation.y, y, w);
      obj.rotation.z = lerp(obj.rotation.z, z, w);
    }
  }

  /** Alcance: IK de dois ossos em cada braço com alvo ativo. */
  private applyReachIK(): void {
    let dirty = true;
    for (const hand of ['left', 'right'] as const) {
      const r = this.reach[hand];
      const chain = this.rig.arms[hand];
      if (!chain || r.weight < 0.001) continue;
      if (dirty) {
        this.root.updateMatrixWorld(true);
        dirty = false;
      }
      const target = _v.copy(r.point);
      if (r.shake > 0) target.y += Math.sin(this.clock * Math.PI * 2 * 3.2) * 0.035 * r.shake;
      // Cotovelo aponta para baixo, para trás e para fora.
      const side = hand === 'left' ? 1 : -1;
      const pole = chain.upper.getWorldPosition(_v2).add(_pole.set(side * 0.35, -0.45, -0.6).applyQuaternion(this.root.quaternion));
      solveTwoBoneIK(chain, target, pole, r.weight);
    }
  }

  private updateFace(): void {
    const expr = this.expressionPose();
    const m = expr.morphs;
    const lip = this.lipsync;
    const blink = this.blinkValue();

    // Volume (RMS) -> jawOpen. Distribuição espectral -> boca larga / arredondada.
    this.morphs.set('jawOpen', Math.max(m.jawOpen, lip.jawOpen * 0.9 + m.jawOpen * 0.3));
    this.morphs.set('mouthWide', m.mouthWide + lip.mouthWide * 0.8);
    this.morphs.set('mouthPucker', m.mouthPucker * (1 - lip.jawOpen) + lip.mouthPucker * 0.8);
    this.morphs.set('mouthSmile', m.mouthSmile);
    this.morphs.set('mouthFrown', m.mouthFrown);
    this.morphs.set('eyeBlink', blink);
    this.morphs.set('eyeSquint', m.eyeSquint * (1 - blink));
    this.morphs.set('eyeWide', m.eyeWide * (1 - blink));
    this.morphs.set('browInnerUp', m.browInnerUp + lip.energy * 0.15);
    this.morphs.set('browDown', m.browDown);
    this.morphs.set('browOuterUp', m.browOuterUp);
  }
}


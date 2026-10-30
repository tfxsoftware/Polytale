import * as THREE from 'three';
import type { CameraDriftSpec, CameraShotDef, CameraShotSpec, CameraValue, FrameState, PointRef, ShakeState } from '../timeline/types';
import type { Actor } from '../core/Actor';
import { clamp, DEG2RAD, fbm1D, noise1D } from '../utils/math';

/** Fornece atores ao diretor (implementado pelo SceneManager). */
export interface ActorProvider {
  getActor(id: string): Actor | undefined;
  visibleActors(): Actor[];
  /** Posição no mundo de um prop (planos de inserção/B-roll). null se o id não for um prop. */
  propPosition(id: string, out: THREE.Vector3): THREE.Vector3 | null;
}

export interface CameraPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  /** Distância até o alvo do plano — usada como foco automático do desfoque de profundidade (fx.dof). */
  focusDistance: number;
}

const DEFAULT_FOV = 50;
const UP = new THREE.Vector3(0, 1, 0);
/** Proporção de referência dos presets (quadros mais estreitos se adaptam). */
const REFERENCE_ASPECT = 16 / 9;

/**
 * Diretor de câmera.
 *
 * - Planos customizados (`cameras` do script) e presets dinâmicos
 *   (wide, medium, close_up, over_shoulder, two_shot, low_angle) que
 *   enquadram atores na posição atual deles. Os presets se adaptam à
 *   proporção do quadro: em vídeo vertical, os planos de grupo recuam para
 *   caber todos na largura.
 * - Transições: posição por Lerp, orientação por Slerp (quaternions), FOV por Lerp.
 *   Misturas aninhadas permitem interromper uma transição no meio.
 * - CAMERA_SHAKE procedural com decaimento exponencial, determinístico no tempo
 *   da timeline (o mesmo instante sempre produz o mesmo tremor).
 */
export class CameraDirector {
  private readonly shots = new Map<string, CameraShotDef>();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly lookMatrix = new THREE.Matrix4();
  private readonly cameraPos = new THREE.Vector3();
  private focusDistance = 3;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly actors: ActorProvider,
  ) {}

  setShots(shots: Iterable<CameraShotDef>): void {
    this.shots.clear();
    for (const s of shots) this.shots.set(s.id, s);
  }

  /** Posição atual da câmera (útil como alvo de olhar 'camera'). */
  getPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.cameraPos);
  }

  /** Distância até o alvo do plano atual — foco automático do desfoque de profundidade (fx.dof). */
  getFocusDistance(): number {
    return this.focusDistance;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Coloca `camera` no plano customizado `id` (telas com câmera ao vivo). false se o plano não existir. */
  poseShot(id: string, time: number, camera: THREE.PerspectiveCamera): boolean {
    if (!this.shots.has(id)) return false;
    const pose = this.resolveSpec({ shot: id }, 0, time);
    camera.position.copy(pose.position);
    camera.quaternion.copy(pose.quaternion);
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return true;
  }

  /** Aplica o plano/mistura do quadro + tremores. */
  apply(frame: FrameState): void {
    const pose = this.resolve(frame.camera, frame.time);
    this.applyShake(pose, frame.shakes, frame.time);

    this.camera.position.copy(pose.position);
    this.camera.quaternion.copy(pose.quaternion);
    if (Math.abs(this.camera.fov - pose.fov) > 1e-4) {
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    this.cameraPos.copy(pose.position);
    this.focusDistance = pose.focusDistance;
  }

  /** Resolve recursivamente um CameraValue em pose (Lerp/Slerp entre planos). */
  resolve(value: CameraValue, time: number): CameraPose {
    if (value.kind === 'shot') return this.resolveSpec(value.spec, value.start, time);
    const a = this.resolve(value.from, time);
    const b = this.resolve(value.to, time);
    const t = value.alpha;
    return {
      position: a.position.lerp(b.position, t),
      quaternion: a.quaternion.slerp(b.quaternion, t),
      fov: a.fov + (b.fov - a.fov) * t,
      focusDistance: a.focusDistance + (b.focusDistance - a.focusDistance) * t,
    };
  }

  /* ---------------------------------------------------------------------- */

  private resolveSpec(spec: CameraShotSpec, start: number, time: number): CameraPose {
    let position: THREE.Vector3;
    let target: THREE.Vector3;
    let fov = DEFAULT_FOV;
    let roll = 0;
    let handheld = spec.handheld ?? 0;

    const custom = spec.shot ? this.shots.get(spec.shot) : undefined;
    if (custom) {
      position = this.resolvePoint(custom.position, 'head');
      target = this.resolvePoint(custom.lookAt, 'head');
      fov = custom.fov ?? DEFAULT_FOV;
      roll = (custom.roll ?? 0) * DEG2RAD;
      handheld = spec.handheld ?? custom.handheld ?? 0;
    } else {
      const p = this.resolvePreset(spec);
      position = p.position;
      target = p.target;
      fov = p.fov;
    }
    if (spec.fov !== undefined) fov = spec.fov;
    if (spec.offset) position.add(this.tmpA.set(spec.offset[0], spec.offset[1], spec.offset[2]));
    if (spec.drift) this.applyDrift(spec.drift, position, target, clamp(time - start, 0, spec.drift.duration ?? Infinity));

    // "Câmera na mão": deriva lenta e determinística.
    if (handheld > 0) {
      const h = handheld * 0.06;
      target.x += fbm1D(time * 0.35, 3) * h;
      target.y += fbm1D(time * 0.3, 7) * h * 0.6;
      position.x += fbm1D(time * 0.25, 11) * h * 0.5;
      position.y += fbm1D(time * 0.28, 13) * h * 0.4;
    }

    const focusDistance = Math.max(0.05, position.distanceTo(target));
    const quaternion = this.lookQuaternion(position, target, roll);
    return { position, quaternion, fov, focusDistance };
  }

  /** Deriva contínua desde o início do plano: `push` aproxima do alvo, `pan` orbita em torno dele. */
  private applyDrift(drift: CameraDriftSpec, position: THREE.Vector3, target: THREE.Vector3, elapsed: number): void {
    if (drift.push) {
      const dir = this.tmpB.subVectors(target, position).setY(0).normalize();
      position.addScaledVector(dir, drift.push * elapsed);
    }
    if (drift.pan) {
      const angle = drift.pan * DEG2RAD * elapsed;
      const offset = this.tmpC.copy(position).sub(target).applyAxisAngle(UP, angle);
      position.copy(target).add(offset);
    }
  }

  private lookQuaternion(position: THREE.Vector3, target: THREE.Vector3, roll: number): THREE.Quaternion {
    if (position.distanceToSquared(target) < 1e-8) target = target.clone().add(new THREE.Vector3(0, 0, -1));
    this.lookMatrix.lookAt(position, target, UP);
    const q = new THREE.Quaternion().setFromRotationMatrix(this.lookMatrix);
    if (roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
    return q;
  }

  private resolvePoint(ref: PointRef, defaultAnchor: 'head' | 'chest' | 'root'): THREE.Vector3 {
    if (Array.isArray(ref)) return new THREE.Vector3(ref[0], ref[1], ref[2]);
    const actor = this.actors.getActor(ref.actor);
    const out = new THREE.Vector3();
    if (!actor) return out;
    const anchor = ref.anchor ?? defaultAnchor;
    if (anchor === 'head') actor.getHeadWorldPosition(out);
    else if (anchor === 'chest') actor.getChestWorldPosition(out);
    else out.copy(actor.root.position);
    if (ref.offset) {
      const off = this.tmpA.set(ref.offset[0], ref.offset[1], ref.offset[2]);
      if (ref.local) off.applyQuaternion(actor.root.quaternion);
      out.add(off);
    }
    return out;
  }

  /** Presets cinematográficos calculados a partir dos atores. */
  private resolvePreset(spec: CameraShotSpec): { position: THREE.Vector3; target: THREE.Vector3; fov: number } {
    const preset = spec.preset ?? 'wide';
    const subject = spec.subject ? this.actors.getActor(spec.subject) : undefined;
    const other = spec.over ? this.actors.getActor(spec.over) : this.nearestOther(subject);
    const sideSign = spec.side === 'left' ? -1 : 1;

    switch (preset) {
      case 'close_up':
      case 'medium': {
        // Sem ator: se o `subject` for um prop, vira plano de inserção (B-roll) sobre o objeto.
        if (!subject) {
          const prop = spec.subject ? this.actors.propPosition(spec.subject, new THREE.Vector3()) : null;
          if (prop) return this.insert(prop, preset === 'close_up' ? 0.75 : 1.5, sideSign);
          return this.wide(spec);
        }
        const close = preset === 'close_up';
        const head = subject.getHeadWorldPosition(new THREE.Vector3());
        // Mira abaixo do rosto: a cabeça fica no terço superior (espaço para legendas).
        const target = head.clone().add(new THREE.Vector3(0, close ? -0.2 : -0.55, 0));
        const position = this.clearOrbit(subject, head, close ? 1.7 : 2.9, sideSign, close ? -0.08 : -0.15);
        return { position, target, fov: close ? 35 : 40 };
      }
      case 'over_shoulder': {
        if (!subject) return this.wide(spec);
        const target = subject.getHeadWorldPosition(new THREE.Vector3());
        if (!other) {
          const fwd = subject.getForward(this.tmpB);
          return { position: target.clone().addScaledVector(fwd, 2.2).add(new THREE.Vector3(0, 0.2, 0)), target, fov: 40 };
        }
        const shoulder = other.getHeadWorldPosition(new THREE.Vector3());
        const toSubject = this.tmpB.subVectors(target, shoulder).setY(0);
        const sep = Math.max(0.3, toSubject.length());
        toSubject.normalize();
        const right = this.tmpC.crossVectors(toSubject, UP).normalize();
        // A linha câmera->sujeito converge; para a cabeça de `over` ficar na borda do
        // quadro (~0.42 m da linha em 16:9), o deslocamento lateral cresce quando estão
        // próximos. Em quadro estreito a borda fica mais perto da linha, mas a cabeça não
        // encolhe junto: sem a folga, ela taparia o sujeito.
        const back = 0.9;
        const narrow = this.narrowness();
        const clearance = 0.42 * narrow + 0.45 * (1 - narrow);
        const lateral = THREE.MathUtils.clamp((clearance * (sep + back)) / sep, 0.5 * narrow, 1.4);
        const position = shoulder
          .clone()
          .addScaledVector(toSubject, -back)
          .addScaledVector(right, sideSign * lateral)
          .add(new THREE.Vector3(0, 0.12, 0));
        return { position, target: target.clone().addScaledVector(right, sideSign * -0.1), fov: 40 };
      }
      case 'two_shot': {
        const a = subject ?? this.actors.visibleActors()[0];
        const b = a ? (spec.over ? other : this.nearestOther(a)) : undefined;
        if (!a || !b) return this.wide(spec);
        const pa = a.getChestWorldPosition(new THREE.Vector3());
        const pb = b.getChestWorldPosition(new THREE.Vector3());
        const mid = pa.clone().add(pb).multiplyScalar(0.5);
        const axis = this.tmpB.subVectors(pb, pa).setY(0);
        const span = Math.max(0.8, axis.length());
        axis.normalize();
        const perp = this.tmpC.crossVectors(UP, axis).normalize();
        // Lado da câmera: aquele para onde os atores (em média) estão voltados.
        // Se eles se encaram (soma ~0), usa +Z do mundo como referência.
        const facing = a.getForward(new THREE.Vector3()).add(b.getForward(new THREE.Vector3()));
        const ref = facing.lengthSq() > 0.04 ? facing : new THREE.Vector3(0, 0, 1);
        if (ref.dot(perp) < 0) perp.negate();
        if (spec.side === 'left') perp.negate();
        // Em quadro vertical, abre um pouco a lente e recua até os dois caberem na largura.
        const fov = this.camera.aspect < 1 ? 55 : 45;
        const dist = Math.max(span * 1.25 + 1.6, this.fitDistance(span / 2 + 0.55, fov));
        const position = mid.clone().addScaledVector(perp, dist).add(new THREE.Vector3(0, 0.25, 0));
        return { position, target: mid.add(new THREE.Vector3(0, 0.1, 0)), fov };
      }
      case 'low_angle': {
        if (!subject) return this.wide(spec);
        const head = subject.getHeadWorldPosition(new THREE.Vector3());
        const root = subject.root.position.clone();
        const position = this.clearOrbit(subject, root, 1.85, sideSign, 0.35);
        return { position, target: head.add(new THREE.Vector3(0, 0.1, 0)), fov: 48 };
      }
      case 'wide':
      default:
        return this.wide(spec);
    }
  }

  /**
   * Posição de câmera orbitando à frente do sujeito, desviando de oclusão:
   * testa ângulos crescentes (lado preferido primeiro) até a linha de visão
   * até o rosto não passar por outro ator. Determinístico (só depende das posições).
   */
  private clearOrbit(subject: Actor, anchor: THREE.Vector3, dist: number, sideSign: number, yOffset: number): THREE.Vector3 {
    const fwd = subject.getForward(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const face = subject.getHeadWorldPosition(new THREE.Vector3());
    const others = this.actors.visibleActors().filter((a) => a !== subject);
    const base = Math.atan(0.3);
    const angles = [base, 0.6, 0.95, 1.3, -base, -0.6, -0.95, -1.3].map((a) => a * sideSign);

    const candidate = (angle: number) =>
      anchor
        .clone()
        .addScaledVector(fwd, Math.cos(angle) * dist)
        .addScaledVector(right, Math.sin(angle) * dist)
        .add(new THREE.Vector3(0, yOffset, 0));

    const seg = new THREE.Line3();
    const closest = new THREE.Vector3();
    const probe = new THREE.Vector3();
    const blocked = (cam: THREE.Vector3) => {
      seg.set(cam, face);
      for (const o of others) {
        for (const p of [o.getHeadWorldPosition(probe).clone(), o.getChestWorldPosition(probe).clone()]) {
          seg.closestPointToPoint(p, true, closest);
          if (closest.distanceTo(p) < 0.32) return true;
        }
      }
      return false;
    };

    for (const a of angles) {
      const cam = candidate(a);
      if (!blocked(cam)) return cam;
    }
    return candidate(angles[0]);
  }

  /**
   * Plano de inserção (B-roll): enquadra um ponto/objeto de perto, levemente de cima.
   * Props não têm "frente", então a câmera vem do lado dos atores — como o lado de quem
   * olha para o objeto. Só depende das posições: não usa a câmera atual, ou o plano
   * giraria quadro a quadro em torno do objeto e o seek deixaria de ser reversível.
   */
  private insert(point: THREE.Vector3, dist: number, sideSign: number): { position: THREE.Vector3; target: THREE.Vector3; fov: number } {
    const dir = this.tmpB.set(0, 0, 0);
    for (const a of this.actors.visibleActors()) dir.add(this.tmpA.subVectors(a.root.position, point));
    dir.setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    const right = this.tmpC.crossVectors(UP, dir).normalize();
    const position = point
      .clone()
      .addScaledVector(dir, dist)
      .addScaledVector(right, sideSign * dist * 0.25)
      .add(new THREE.Vector3(0, dist * 0.45, 0));
    return { position, target: point.clone(), fov: 40 };
  }

  /** Plano geral: enquadra todos os atores visíveis (ou o sujeito). */
  private wide(spec: CameraShotSpec): { position: THREE.Vector3; target: THREE.Vector3; fov: number } {
    const subject = spec.subject ? this.actors.getActor(spec.subject) : undefined;
    const group = subject ? [subject] : this.actors.visibleActors();
    if (!group.length) return { position: new THREE.Vector3(0, 2.2, 8), target: new THREE.Vector3(0, 1, 0), fov: DEFAULT_FOV };

    const center = new THREE.Vector3();
    const facing = new THREE.Vector3();
    for (const a of group) {
      center.add(a.getChestWorldPosition(this.tmpA));
      facing.add(a.getForward(this.tmpB));
    }
    center.divideScalar(group.length);
    let radius = 1;
    for (const a of group) radius = Math.max(radius, a.root.position.distanceTo(this.tmpA.set(center.x, a.root.position.y, center.z)) + 0.8);
    if (facing.lengthSq() < 1e-4) facing.set(0, 0, 1);
    facing.setY(0).normalize();
    const right = this.tmpC.crossVectors(facing, UP).normalize();
    const sideSign = spec.side === 'left' ? -1 : 1;
    const dist = Math.max(radius * 2.6 + 3, this.fitDistance(radius + 0.3, DEFAULT_FOV));
    const position = center
      .clone()
      .addScaledVector(facing, dist)
      .addScaledVector(right, sideSign * dist * 0.3)
      .add(new THREE.Vector3(0, 1.4 + radius * 0.3, 0));
    return { position, target: center, fov: DEFAULT_FOV };
  }

  /** Distância para `halfWidth` metros caberem na metade da largura do quadro. */
  private fitDistance(halfWidth: number, fov: number): number {
    return halfWidth / (Math.tan((fov * DEG2RAD) / 2) * this.camera.aspect);
  }

  /** 1 em 16:9 ou mais largo; menor em quadros mais estreitos (9:16 ≈ 0.32). */
  private narrowness(): number {
    return Math.min(1, this.camera.aspect / REFERENCE_ASPECT);
  }

  private nearestOther(subject: Actor | undefined): Actor | undefined {
    if (!subject) return undefined;
    let best: Actor | undefined;
    let bestD = Infinity;
    for (const a of this.actors.visibleActors()) {
      if (a === subject) continue;
      const d = a.root.position.distanceToSquared(subject.root.position);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /** CAMERA_SHAKE: amplitude = intensity * e^(-decay * t), ruído determinístico. */
  private applyShake(pose: CameraPose, shakes: ShakeState[], time: number): void {
    if (!shakes.length) return;
    const rot = new THREE.Euler();
    const offset = new THREE.Vector3();
    for (const s of shakes) {
      const amp = s.intensity * Math.exp(-s.decay * s.localTime);
      if (amp < 1e-4) continue;
      const x = time * s.frequency;
      rot.x += noise1D(x, s.seed + 1) * amp * 0.05;
      rot.y += noise1D(x, s.seed + 2) * amp * 0.05;
      rot.z += noise1D(x, s.seed + 3) * amp * 0.03;
      offset.x += noise1D(x, s.seed + 4) * amp * 0.06;
      offset.y += noise1D(x, s.seed + 5) * amp * 0.06;
    }
    pose.position.add(offset.applyQuaternion(pose.quaternion));
    pose.quaternion.multiply(new THREE.Quaternion().setFromEuler(rot));
  }
}

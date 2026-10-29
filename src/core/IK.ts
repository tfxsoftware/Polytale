import * as THREE from 'three';
import { clamp } from '../utils/math';
import type { ArmChain } from './ActorRig';

/* ========================================================================== */
/*  IK de dois ossos                                                          */
/* ========================================================================== */

const _ikA = new THREE.Vector3();
const _ikB = new THREE.Vector3();
const _ikC = new THREE.Vector3();
const _ikT = new THREE.Vector3();
const _ikP = new THREE.Vector3();
const _ikE = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
const _ikTmp = new THREE.Vector3();
const _ikCur = new THREE.Vector3();
const _ikDes = new THREE.Vector3();
const _ikQ1 = new THREE.Quaternion();
const _ikQ2 = new THREE.Quaternion();
const _ikQ3 = new THREE.Quaternion();

/** Gira `bone` (em espaço de mundo) para que o filho em `childWorld` aponte para `desiredWorld`. */
function aimBone(bone: THREE.Object3D, childWorld: THREE.Vector3, desiredWorld: THREE.Vector3): void {
  bone.getWorldPosition(_ikTmp);
  _ikCur.subVectors(childWorld, _ikTmp);
  _ikDes.subVectors(desiredWorld, _ikTmp);
  if (_ikCur.lengthSq() < 1e-10 || _ikDes.lengthSq() < 1e-10) return;
  const delta = _ikQ1.setFromUnitVectors(_ikCur.normalize(), _ikDes.normalize());
  const world = bone.getWorldQuaternion(_ikQ2).premultiply(delta);
  const parent = bone.parent ? bone.parent.getWorldQuaternion(_ikQ3) : _ikQ3.identity();
  bone.quaternion.copy(parent.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/**
 * IK analítico de dois ossos (lei dos cossenos) independente dos eixos do rig:
 * funciona no personagem procedural e em esqueletos GLTF (Mixamo/RPM).
 * `pole` (ponto no mundo) define para onde o cotovelo aponta. `weight` mistura
 * suavemente a pose atual (0) com a solução (1) — sem "estalos" ao ligar/desligar.
 */
export function solveTwoBoneIK(chain: ArmChain, target: THREE.Vector3, pole: THREE.Vector3, weight: number): void {
  const { upper, lower, end } = chain;
  upper.getWorldPosition(_ikA);
  lower.getWorldPosition(_ikB);
  end.getWorldPosition(_ikC);
  const l1 = _ikA.distanceTo(_ikB);
  const l2 = _ikB.distanceTo(_ikC);
  if (l1 < 1e-5 || l2 < 1e-5) return;

  _ikT.copy(_ikC).lerp(target, weight);
  _ikP.copy(_ikB).lerp(pole, weight);

  _ikDir.subVectors(_ikT, _ikA);
  const raw = _ikDir.length();
  if (raw < 1e-5) return;
  _ikDir.divideScalar(raw);
  const dist = clamp(raw, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);

  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);

  // Direção do cotovelo: componente do pole perpendicular ao eixo ombro->alvo.
  const bend = _ikP.sub(_ikA);
  bend.addScaledVector(_ikDir, -bend.dot(_ikDir));
  if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0).addScaledVector(_ikDir, _ikDir.y);
  bend.normalize();

  _ikE.copy(_ikA)
    .addScaledVector(_ikDir, cosA * l1)
    .addScaledVector(bend, sinA * l1);
  const wrist = _ikTmp.copy(_ikA).addScaledVector(_ikDir, dist).clone();

  aimBone(upper, _ikB, _ikE);
  lower.getWorldPosition(_ikB);
  end.getWorldPosition(_ikC);
  aimBone(lower, _ikC, wrist);
}

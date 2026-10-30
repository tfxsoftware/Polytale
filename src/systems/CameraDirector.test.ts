import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CameraDirector, type ActorProvider } from './CameraDirector';
import type { CameraValue, FrameState } from '../timeline/types';

function director(camera: THREE.PerspectiveCamera): CameraDirector {
  const provider: ActorProvider = {
    getActor: () => undefined,
    visibleActors: () => [],
    propPosition: (id, out) => (id === 'bule' ? out.set(1, 0.8, -2) : null),
  };
  return new CameraDirector(camera, provider);
}

const frameOf = (camera: CameraValue, time: number) => ({ camera, shakes: [], time }) as unknown as FrameState;

describe('CameraDirector', () => {
  it('plano de inserção num prop é estável entre quadros (não gira em torno do objeto)', () => {
    const camera = new THREE.PerspectiveCamera();
    const d = director(camera);
    const frame = frameOf({ kind: 'shot', spec: { preset: 'close_up', subject: 'bule' }, start: 0 }, 1);
    d.apply(frame);
    const first = camera.position.clone();
    for (let i = 0; i < 5; i++) d.apply(frame);
    expect(camera.position.distanceTo(first)).toBeLessThan(1e-6);
  });

  it('posiciona a câmera de uma tela num plano customizado', () => {
    const camera = new THREE.PerspectiveCamera();
    const d = director(new THREE.PerspectiveCamera());
    d.setShots([{ id: 'corredor', position: [1, 2, 3], lookAt: [1, 2, 0], fov: 30 }]);
    expect(d.poseShot('corredor', 0, camera)).toBe(true);
    expect(camera.position.toArray()).toEqual([1, 2, 3]);
    expect(camera.fov).toBe(30);
    expect(d.poseShot('nao-existe', 0, camera)).toBe(false);
  });
});

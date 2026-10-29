import type { StoryScript } from '../timeline/types';

/**
 * Demo: "A Chama Antiga".
 * Demonstra spawn de objetos, caminhada, cortes/transições/presets de câmera,
 * diálogos com lipsync (Kael: Web Speech API; Iara: voz procedural via
 * AnalyserNode), expressões, gestos, olhar, luzes, tremor, flash e fades —
 * e o corpo: sentar/levantar, poses, alcance por IK (mãos na fogueira),
 * gesto por keyframes, apontar, aperto de mão, pegar, entregar e mão no ombro.
 */
export const defaultScript: StoryScript = {
  meta: {
    title: 'A Chama Antiga',
    author: 'Polytale',
    duration: 60,
  },
  scene: {
    background: '#1b2244',
    sky: { top: '#060a1c', bottom: '#1b2244' },
    fog: { color: '#1b2244', near: 10, far: 38 },
    ground: { color: '#3a5232', color2: '#33492c', size: 160, tiles: 64 },
    lights: [
      { id: 'night', type: 'hemisphere', color: '#8b9be0', groundColor: '#2a2018', intensity: 1.3 },
      { id: 'moon', type: 'directional', color: '#a9bcff', intensity: 1.6, position: [-8, 14, -6], castShadow: true },
      { id: 'fire', type: 'point', color: '#ff8a3d', intensity: 9, position: [0, 0.9, 0], distance: 14, castShadow: true, flicker: 0.35 },
      { id: 'spirit', type: 'point', color: '#5ff0e0', intensity: 0, position: [1.9, 1.6, 1.0], distance: 7 },
      { id: 'storm', type: 'directional', color: '#dfe8ff', intensity: 0, position: [4, 20, -10], castShadow: false },
    ],
    props: [
      { prop: 'pine', position: [-7, 0, -5], scale: 1.4 },
      { prop: 'pine', position: [-3, 0, -9], scale: 1.8 },
      { prop: 'pine', position: [3.5, 0, -8], scale: 1.5 },
      { prop: 'pine', position: [8, 0, -4], scale: 1.7 },
      { prop: 'pine', position: [9, 0, 3], scale: 1.3 },
      { prop: 'pine', position: [-9.5, 0, 2], scale: 1.6 },
      { prop: 'tree', position: [6, 0, -1], scale: 1.2 },
      { prop: 'tree', position: [-5, 0, -2.5], scale: 1.1 },
      { prop: 'pine', position: [-12, 0, -8], scale: 2.0 },
      { prop: 'pine', position: [12, 0, -9], scale: 2.1 },
      { prop: 'rock', position: [2.6, 0, -1.8], scale: 1.1 },
      { prop: 'rock', position: [-2.8, 0, -1.2], scale: 0.8 },
      { prop: 'rock', position: [4.2, 0, 2.6], scale: 0.6 },
      { prop: 'crate', position: [-3.2, 0, 0.4], rotation: 25, scale: 0.8 },
      { prop: 'stool', position: [-2.1, 0, 1.6] },
    ],
  },
  fx: {
    retro: true,
    settings: { pixelSize: 3, colorLevels: 32, dither: 1, scanlines: 0.25 },
  },
  gestures: {
    // Gesto por keyframes: braços sobem à frente e se abrem (conjurar).
    conjure: {
      duration: 1.8,
      keyframes: [
        { t: 0, pose: { shoulderL: [0, 0, 10], shoulderR: [0, 0, -10], elbowL: [-10, 0, 0], elbowR: [-10, 0, 0] } },
        { t: 0.35, pose: { shoulderL: [-115, 0, 20], shoulderR: [-115, 0, -20], elbowL: [-25, 0, 0], elbowR: [-25, 0, 0], head: [-14, 0, 0] } },
        { t: 0.7, pose: { shoulderL: [-75, 0, 55], shoulderR: [-75, 0, -55], elbowL: [-5, 0, 0], elbowR: [-5, 0, 0], head: [-6, 0, 0] } },
        { t: 1, pose: { shoulderL: [0, 0, 10], shoulderR: [0, 0, -10], elbowL: [-10, 0, 0], elbowR: [-10, 0, 0] } },
      ],
    },
  },
  cameras: [
    { id: 'establishing', position: [10, 6.5, 13], lookAt: [0, 0.8, 0], fov: 46, handheld: 0.2 },
    { id: 'fire_low', position: [1.4, 0.45, 2.4], lookAt: [0, 0.55, 0], fov: 55, handheld: 0.4 },
    { id: 'sky', position: [0.5, 1.2, 4.5], lookAt: [0, 9, -10], fov: 60, handheld: 0.6 },
  ],
  timeline: [
    /* ---------------- Abertura ---------------- */
    { time: 0, type: 'FADE_SCREEN', to: 1, duration: 0, color: '#000000' },
    { time: 0.1, type: 'FADE_SCREEN', to: 0, duration: 2.5 },
    { time: 0, type: 'PLAY_SOUND', src: 'procedural:wind', loop: true, volume: 0.45 },
    { time: 0, type: 'PLAY_SOUND', src: 'procedural:fire', loop: true, volume: 0.35 },
    { time: 0, type: 'SPAWN_OBJECT', target: 'fogueira', object: { kind: 'prop', prop: 'campfire' }, position: [0, 0, 0] },
    {
      time: 0,
      type: 'SPAWN_OBJECT',
      target: 'kael',
      object: {
        kind: 'actor',
        name: 'Kael',
        color: '#ffd166',
        height: 1.78,
        palette: { skin: '#d9a066', hair: '#2b1a10', shirt: '#7a3b2e', pants: '#3a3f55', shoes: '#22160e', eyes: '#2a1a0e' },
        voice: { engine: 'speech', lang: 'pt-BR', rate: 1.05, pitch: 0.9 },
      },
      position: [-6, 0, 5],
      rotation: [0, 131, 0],
    },
    { time: 0, type: 'CAMERA_CUT', shot: 'establishing' },
    { time: 0.6, type: 'TRANSFORM_OBJECT', target: 'kael', position: [-1.6, 0, 1.2], duration: 4.4, easing: 'easeInOutSine', label: 'Kael caminha' },
    { time: 1.6, type: 'CAMERA_TRANSITION', preset: 'medium', subject: 'kael', side: 'left', duration: 3.2, easing: 'easeInOutCubic' },
    { time: 3.0, type: 'SET_LOOK_TARGET', target: 'kael', lookAt: 'fogueira' },
    { time: 4.6, type: 'SET_EXPRESSION', target: 'kael', expression: 'thinking', intensity: 0.8, duration: 0.6 },
    { time: 5.0, type: 'INTERACT', target: 'kael', interaction: 'sit', position: [-2.1, 0, 1.6], facing: 127, seatHeight: 0.45 },

    /* ---------------- Kael chega ---------------- */
    { time: 5.2, type: 'CAMERA_CUT', preset: 'close_up', subject: 'kael', side: 'left' },
    { time: 5.3, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'kael', text: 'Finalmente... uma fogueira. Achei que esta floresta não tinha fim.' },
    { time: 7.4, type: 'SET_EXPRESSION', target: 'kael', expression: 'happy', intensity: 0.7, duration: 0.8 },
    { time: 7.6, type: 'REACH', target: 'kael', hand: 'both', to: [0, 0.75, 0], duration: 0.9, hold: 2.2, label: 'mãos na fogueira' },

    /* ---------------- Iara aparece ---------------- */
    { time: 11.0, type: 'CAMERA_CUT', preset: 'two_shot', subject: 'kael', over: 'iara' },
    {
      time: 11.0,
      type: 'SPAWN_OBJECT',
      target: 'iara',
      object: {
        kind: 'actor',
        name: 'Iara',
        color: '#5ff0e0',
        height: 1.68,
        palette: { skin: '#8fd3c8', hair: '#e8f4ff', shirt: '#2f6f8f', pants: '#24485e', shoes: '#173040', eyes: '#0b3d3a' },
        voice: { engine: 'babble', pitch: 235, rate: 1.0, timbre: 1.22, volume: 0.9 },
      },
      position: [1.8, 0, 1.0],
      rotation: [0, -81, 0],
    },
    { time: 11.0, type: 'FLASH_SCREEN', color: '#9ff7ff', intensity: 0.9, duration: 0.7 },
    { time: 11.0, type: 'PLAY_SOUND', src: 'procedural:chime', volume: 0.8 },
    { time: 11.0, type: 'CAMERA_SHAKE', intensity: 0.35, decay: 3.5 },
    { time: 11.0, type: 'SET_LIGHT', target: 'spirit', intensity: 4, duration: 1.5, easing: 'easeOutCubic' },
    { time: 11.1, type: 'SET_EXPRESSION', target: 'kael', expression: 'surprised', duration: 0.25 },
    { time: 11.1, type: 'INTERACT', target: 'kael', interaction: 'stand' },
    { time: 11.2, type: 'SET_LOOK_TARGET', target: 'kael', lookAt: 'iara' },
    { time: 11.4, type: 'TRANSFORM_OBJECT', target: 'kael', rotation: [0, 99, 0], duration: 0.7, easing: 'easeOutQuad' },
    { time: 11.2, type: 'SET_LOOK_TARGET', target: 'iara', lookAt: 'kael' },

    { time: 12.6, type: 'CAMERA_CUT', preset: 'over_shoulder', subject: 'iara', over: 'kael', side: 'right' },
    { time: 12.6, type: 'PLAY_GESTURE', target: 'iara', gesture: 'bow', duration: 1.8 },
    { time: 12.8, type: 'SET_EXPRESSION', target: 'iara', expression: 'happy', intensity: 0.5, duration: 0.6 },
    { time: 13.0, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'iara', text: 'Viajante. Poucos encontram o caminho até a chama antiga.' },

    /* ---------------- Diálogo ---------------- */
    { time: 18.0, type: 'CAMERA_CUT', preset: 'over_shoulder', subject: 'kael', over: 'iara', side: 'left' },
    { time: 18.0, type: 'SET_EXPRESSION', target: 'kael', expression: 'thinking', intensity: 0.6, duration: 0.5 },
    { time: 18.1, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'kael', text: 'Quem... quem é você?' },
    { time: 18.4, type: 'PLAY_GESTURE', target: 'kael', gesture: 'shrug' },

    { time: 20.4, type: 'CAMERA_CUT', preset: 'close_up', subject: 'iara', side: 'right' },
    { time: 20.4, type: 'SET_EXPRESSION', target: 'iara', expression: 'neutral', duration: 0.6 },
    { time: 20.5, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'iara', text: 'Sou Iara, guardiã desta clareira. A floresta me contou que você viria.' },
    { time: 22.4, type: 'INTERACT', target: 'iara', interaction: 'pointAt', with: 'kael', duration: 1.2 },
    { time: 22.0, type: 'SET_LIGHT', target: 'fire', intensity: 13, color: '#ffa04d', duration: 2 },

    { time: 26.9, type: 'CAMERA_CUT', preset: 'medium', subject: 'kael', side: 'left' },
    { time: 27.0, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'kael', text: 'Ela... te contou? Então você sabe o que estou procurando.' },
    { time: 26.6, type: 'INTERACT', target: 'kael', interaction: 'handshake', with: 'iara', label: 'Kael se aproxima' },
    { time: 29.3, type: 'CAMERA_CUT', preset: 'two_shot', subject: 'kael', over: 'iara' },

    { time: 31.8, type: 'CAMERA_TRANSITION', preset: 'over_shoulder', subject: 'iara', over: 'kael', side: 'right', duration: 1.2, easing: 'easeOutCubic' },
    { time: 31.8, type: 'SET_LIGHT', target: 'moon', intensity: 0.7, color: '#7484dc', duration: 2.5 },
    { time: 31.9, type: 'SET_EXPRESSION', target: 'iara', expression: 'thinking', intensity: 0.7, duration: 0.8 },
    { time: 31.9, type: 'SET_POSE', target: 'iara', pose: 'armsCrossed', duration: 0.8 },
    { time: 32.0, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'iara', text: 'Sei. Mas o que você procura também procura você.' },

    /* ---------------- Trovão ---------------- */
    { time: 36.6, type: 'CAMERA_CUT', shot: 'sky' },
    { time: 36.6, type: 'FLASH_SCREEN', color: '#ffffff', intensity: 1, duration: 0.5 },
    { time: 36.6, type: 'CAMERA_SHAKE', intensity: 1.0, frequency: 22, decay: 2.2 },
    { time: 36.6, type: 'PLAY_SOUND', src: 'procedural:thunder', volume: 1 },
    { time: 36.6, type: 'SET_LIGHT', target: 'storm', intensity: 7, duration: 0 },
    { time: 36.7, type: 'SET_LIGHT', target: 'storm', intensity: 0, duration: 0.8, easing: 'easeOutQuad' },
    { time: 36.6, type: 'SET_LOOK_TARGET', target: 'kael', lookAt: [0, 12, -10] },
    { time: 36.7, type: 'SET_LOOK_TARGET', target: 'iara', lookAt: [0, 12, -10] },
    { time: 36.6, type: 'SET_EXPRESSION', target: 'kael', expression: 'surprised', duration: 0.15 },
    { time: 36.6, type: 'SET_POSE', target: 'iara', pose: 'rest', duration: 0.35 },

    { time: 37.9, type: 'CAMERA_CUT', preset: 'close_up', subject: 'kael', side: 'left' },
    { time: 37.9, type: 'SET_LOOK_TARGET', target: 'kael', lookAt: 'iara' },
    { time: 38.0, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'kael', text: 'O que foi isso?!' },

    { time: 39.6, type: 'CAMERA_TRANSITION', preset: 'two_shot', subject: 'kael', over: 'iara', duration: 2.2, easing: 'easeInOutSine' },
    { time: 39.6, type: 'SET_LOOK_TARGET', target: 'iara', lookAt: 'kael' },
    { time: 39.7, type: 'SET_EXPRESSION', target: 'iara', expression: 'happy', intensity: 0.8, duration: 0.6 },
    { time: 39.8, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'iara', text: 'O começo da sua jornada. Descanse. Ao amanhecer, partimos.' },
    { time: 41.0, type: 'PLAY_GESTURE', target: 'iara', gesture: 'nod' },
    { time: 41.5, type: 'SET_EXPRESSION', target: 'kael', expression: 'happy', intensity: 0.9, duration: 0.8 },

    /* ---------------- Encerramento ---------------- */
    /* ---------------- O presente ---------------- */
    { time: 45.2, type: 'CAMERA_CUT', preset: 'medium', subject: 'iara', side: 'right' },
    { time: 45.2, type: 'PLAY_GESTURE', target: 'iara', gesture: 'conjure' },
    { time: 45.3, type: 'SET_LOOK_TARGET', target: 'iara', lookAt: [1.75, 1.3, 0.45] },
    { time: 45.3, type: 'SET_LOOK_TARGET', target: 'kael', lookAt: [1.75, 1.3, 0.45] },
    { time: 46.0, type: 'SPAWN_OBJECT', target: 'orbe', object: { kind: 'prop', prop: 'orb', color: '#5ff0e0' }, position: [1.75, 1.3, 0.45] },
    { time: 46.0, type: 'FLASH_SCREEN', color: '#9ff7ff', intensity: 0.6, duration: 0.5 },
    { time: 46.0, type: 'PLAY_SOUND', src: 'procedural:chime', volume: 0.7 },
    { time: 46.0, type: 'SET_LIGHT', target: 'spirit', intensity: 6, duration: 0.3 },
    { time: 46.4, type: 'SET_LIGHT', target: 'spirit', intensity: 3, duration: 1.2 },
    { time: 46.6, type: 'CAMERA_TRANSITION', preset: 'two_shot', subject: 'kael', over: 'iara', duration: 1.6, easing: 'easeInOutSine' },
    { time: 46.6, type: 'INTERACT', target: 'iara', interaction: 'pickUp', with: 'orbe' },
    { time: 48.6, type: 'INTERACT', target: 'iara', interaction: 'give', with: 'kael', object: 'orbe' },
    { time: 51.0, type: 'CAMERA_CUT', preset: 'over_shoulder', subject: 'iara', over: 'kael', side: 'right' },
    { time: 49.1, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'iara', text: 'Leve isto. A chama antiga vai te guiar.' },

    { time: 53.0, type: 'CAMERA_CUT', preset: 'close_up', subject: 'kael', side: 'left' },
    { time: 53.0, type: 'SET_EXPRESSION', target: 'kael', expression: 'happy', intensity: 1, duration: 0.5 },
    { time: 53.1, type: 'PLAY_AUDIO_WITH_LIPSYNC', target: 'kael', text: 'Obrigado, Iara. Não vou falhar.' },

    /* ---------------- Encerramento ---------------- */
    { time: 55.6, type: 'CAMERA_CUT', preset: 'two_shot', subject: 'kael', over: 'iara' },
    { time: 55.6, type: 'INTERACT', target: 'iara', interaction: 'handOnShoulder', with: 'kael', duration: 2.2 },
    { time: 56.4, type: 'PLAY_GESTURE', target: 'kael', gesture: 'nod' },
    { time: 57.2, type: 'CAMERA_TRANSITION', shot: 'fire_low', duration: 2.4, easing: 'easeInOutCubic' },
    { time: 57.4, type: 'SET_RETRO_FX', settings: { pixelSize: 6, scanlines: 0.45, colorLevels: 16 }, duration: 2 },
    { time: 57.6, type: 'FADE_SCREEN', to: 1, duration: 2.2, color: '#000000' },
  ],
};

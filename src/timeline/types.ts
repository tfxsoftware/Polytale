/**
 * StoryScript — formato declarativo (JSON) que descreve uma cena narrativa:
 * cenário, luzes, planos de câmera e uma lista de eventos no tempo.
 *
 * Todo o estado visual em um instante `t` é derivado deterministicamente
 * dos eventos (ver ActionRegistry). Por isso a timeline é reversível:
 * um seek para qualquer instante recalcula o estado completo da cena.
 */

export type Vec3 = [number, number, number];
/** Cor RGB normalizada (0..1, espaço sRGB). */
export type RGB = [number, number, number];

export const EASINGS = [
  'linear',
  'step',
  'easeInQuad',
  'easeOutQuad',
  'easeInOutQuad',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeInOutSine',
  'easeOutBack',
  'easeOutElastic',
  'easeOutBounce',
] as const;
export type EasingName = (typeof EASINGS)[number];

export const EXPRESSIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'thinking'] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const GESTURES = ['wave', 'point', 'shrug', 'nod', 'headShake', 'bow'] as const;
export type Gesture = (typeof GESTURES)[number];

export const CAMERA_PRESETS = ['wide', 'medium', 'close_up', 'over_shoulder', 'two_shot', 'low_angle'] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

export const PROCEDURAL_SOUNDS = ['procedural:wind', 'procedural:thunder', 'procedural:fire', 'procedural:chime'] as const;

/* -------------------------------------------------------------------------- */
/*  Corpo: articulações, poses, alcance (IK) e encaixes                        */
/* -------------------------------------------------------------------------- */

/** Articulações controláveis do personagem. */
export const JOINTS = [
  'hips',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'elbowL',
  'shoulderR',
  'elbowR',
  'hipL',
  'kneeL',
  'hipR',
  'kneeR',
] as const;
export type Joint = (typeof JOINTS)[number];

/** Pose: rotação Euler (graus) por articulação + quanto o quadril desce (metros). */
export type PoseDef = { [J in Joint]?: Vec3 } & { crouch?: number };

export const POSE_PRESETS = ['rest', 'sit', 'kneel', 'crouch', 'armsCrossed', 'handsOnHips', 'handOnChin', 'armsUp'] as const;
export type PosePreset = (typeof POSE_PRESETS)[number];

/** Gesto customizado: keyframes de pose ao longo do progresso (0..1). */
export interface GestureDef {
  duration: number;
  keyframes: { t: number; pose: PoseDef }[];
}

export type Hand = 'left' | 'right';

export const BODY_PARTS = ['head', 'chest', 'back', 'shoulderL', 'shoulderR', 'handL', 'handR', 'root'] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

/**
 * Alvo de alcance (IK do braço):
 * - id de objeto (ator = peito, prop = posição do prop);
 * - ponto [x, y, z];
 * - { target, part, offset, local } — parte do corpo de um ator ou objeto, com deslocamento;
 * - { midpoint: [a, b], height } — ponto médio entre dois objetos (aperto de mão, toca-aqui).
 */
export type ReachTarget =
  | string
  | Vec3
  | { target: string; part?: BodyPart; offset?: Vec3; local?: boolean }
  | { midpoint: [string, string]; height?: number; offset?: Vec3 };

export const SOCKETS = ['handR', 'handL', 'head', 'back', 'chest'] as const;
export type Socket = (typeof SOCKETS)[number];

export const INTERACTIONS = [
  'handshake',
  'highFive',
  'hug',
  'give',
  'pickUp',
  'putDown',
  'handOnShoulder',
  'push',
  'sit',
  'stand',
  'kneel',
  'pointAt',
] as const;
export type Interaction = (typeof INTERACTIONS)[number];

/** Proporções do personagem procedural (unidades de modelo, altura base 1.95). */
export const PROCEDURAL_RIG = {
  baseHeight: 1.95,
  hipHeight: 0.92,
  thigh: 0.45,
  shin: 0.42,
  upperArm: 0.3,
  forearm: 0.27,
} as const;

/* -------------------------------------------------------------------------- */
/*  Cenário                                                                   */
/* -------------------------------------------------------------------------- */

export interface FogDef {
  color: string;
  near: number;
  far: number;
}

export interface SkyDef {
  top: string;
  bottom: string;
}

export type LightKind = 'ambient' | 'hemisphere' | 'directional' | 'point' | 'spot';

export interface LightDef {
  id: string;
  type: LightKind;
  color?: string;
  /** Só para 'hemisphere'. */
  groundColor?: string;
  intensity?: number;
  position?: Vec3;
  /** Alvo para 'directional' e 'spot'. */
  target?: Vec3;
  castShadow?: boolean;
  /** Alcance para 'point'/'spot' (0 = infinito). */
  distance?: number;
  /** Ângulo de abertura em graus para 'spot'. */
  angle?: number;
  /** Oscilação procedural de intensidade (0..1) — ex.: chama de fogueira. */
  flicker?: number;
}

export interface GroundDef {
  color: string;
  color2?: string;
  size?: number;
  tiles?: number;
}

export type PropType =
  | 'tree'
  | 'pine'
  | 'rock'
  | 'crate'
  | 'campfire'
  | 'pillar'
  | 'lamp'
  | 'stool'
  | 'orb'
  | 'book'
  | 'cup'
  | 'model';

export interface PropDef {
  prop: PropType;
  color?: string;
  /** Apenas para prop = 'model'. */
  model?: string;
}

/** Cenografia estática (não endereçável pela timeline). */
export interface StaticPropDef extends PropDef {
  position: Vec3;
  /** Graus em torno do eixo Y. */
  rotation?: number;
  scale?: number;
}

export interface SceneDef {
  background?: string;
  sky?: SkyDef;
  fog?: FogDef;
  ground?: GroundDef;
  lights?: LightDef[];
  props?: StaticPropDef[];
}

/* -------------------------------------------------------------------------- */
/*  Objetos instanciáveis (SPAWN_OBJECT)                                       */
/* -------------------------------------------------------------------------- */

export interface ActorPalette {
  skin?: string;
  hair?: string;
  shirt?: string;
  pants?: string;
  shoes?: string;
  eyes?: string;
}

/**
 * - 'speech': Web Speech API (window.speechSynthesis), lipsync procedural estimado pelo texto.
 * - 'babble': sintetizador de formantes procedural renderizado em AudioBuffer (lipsync via AnalyserNode).
 * - 'none': mudo (apenas legenda e boca procedural).
 */
export type VoiceEngine = 'speech' | 'babble' | 'none';

export interface VoiceDef {
  engine?: VoiceEngine;
  /** Frequência fundamental (Hz) para 'babble'; para 'speech', 1 = normal. */
  pitch?: number;
  /** Velocidade (1 = normal). */
  rate?: number;
  /** Deslocamento de formantes para 'babble' (1 = adulto). */
  timbre?: number;
  volume?: number;
  /** Idioma para 'speech' (ex.: 'pt-BR'). */
  lang?: string;
}

export interface ActorObjectDef {
  kind: 'actor';
  name: string;
  /** Cor do nome nas legendas. */
  color?: string;
  /** GLTF/GLB opcional. Sem modelo é gerado um personagem low-poly procedural. */
  model?: string;
  palette?: ActorPalette;
  voice?: VoiceDef;
  /** Clipe GLTF tocado em loop por padrão. */
  idleClip?: string;
  /** Altura aproximada (m) usada no personagem procedural. */
  height?: number;
}

export interface PropObjectDef extends PropDef {
  kind: 'prop';
}

export type ObjectDef = ActorObjectDef | PropObjectDef;

/* -------------------------------------------------------------------------- */
/*  Câmera                                                                    */
/* -------------------------------------------------------------------------- */

/** Ponto no mundo ou relativo a um ator. */
export type PointRef =
  | Vec3
  | {
      actor: string;
      offset?: Vec3;
      /** Se true, `offset` é rotacionado pelo yaw do ator. */
      local?: boolean;
      anchor?: 'head' | 'chest' | 'root';
    };

/** Plano de câmera customizado, declarado em `cameras`. */
export interface CameraShotDef {
  id: string;
  position: PointRef;
  lookAt: PointRef;
  fov?: number;
  /** Graus. */
  roll?: number;
  /** Amplitude de "câmera na mão" (0..1). */
  handheld?: number;
}

/** Referência a um plano: id customizado ou preset dinâmico sobre atores. */
export interface CameraShotSpec {
  /** Id de um plano em `cameras`. */
  shot?: string;
  preset?: CameraPreset;
  /** Ator enquadrado pelo preset. */
  subject?: string;
  /** Ator de cujo ombro a câmera olha (over_shoulder) ou segundo ator (two_shot). */
  over?: string;
  side?: 'left' | 'right';
  fov?: number;
  /** Deslocamento extra da posição da câmera, em metros (espaço do mundo). */
  offset?: Vec3;
  handheld?: number;
}

/* -------------------------------------------------------------------------- */
/*  Efeitos                                                                   */
/* -------------------------------------------------------------------------- */

export interface RetroSettings {
  /** Tamanho do pixel virtual (downscale), em pixels de tela. */
  pixelSize: number;
  /** Níveis por canal (32 = cor 15-bit do PS1). */
  colorLevels: number;
  /** Intensidade do dithering Bayer 4x4 (0..1). */
  dither: number;
  scanlines: number;
  curvature: number;
  vignette: number;
  chromatic: number;
  noise: number;
  /** Intensidade do jitter de vértices do PS1 (0..1). */
  vertexSnap: number;
}

export interface FxDef {
  retro?: boolean;
  settings?: Partial<RetroSettings>;
}

/* -------------------------------------------------------------------------- */
/*  Eventos da timeline                                                       */
/* -------------------------------------------------------------------------- */

/** Alvo do olhar: id de ator, 'camera', ponto no mundo ou null (olhar livre). */
export type LookTarget = string | Vec3 | null;

interface EventBase {
  /** Instante de início em segundos. */
  time: number;
  /** Duração em segundos (0/omitido = ação instantânea). */
  duration?: number;
  easing?: EasingName;
  /** Rótulo opcional (para debug / mensagens de erro). */
  label?: string;
}

export interface SpawnObjectEvent extends EventBase {
  type: 'SPAWN_OBJECT';
  /** Id único do objeto. */
  target: string;
  /** Obrigatório no primeiro spawn de um id. */
  object?: ObjectDef;
  position?: Vec3;
  /** Euler em graus [x, y, z]. */
  rotation?: Vec3;
  scale?: number;
}

export interface DespawnObjectEvent extends EventBase {
  type: 'DESPAWN_OBJECT';
  target: string;
}

export interface TransformObjectEvent extends EventBase {
  type: 'TRANSFORM_OBJECT';
  target: string;
  position?: Vec3;
  /** Euler em graus [x, y, z] — interpolado pelo menor caminho. */
  rotation?: Vec3;
  scale?: number;
}

export interface PlayAudioWithLipsyncEvent extends EventBase {
  type: 'PLAY_AUDIO_WITH_LIPSYNC';
  /** Ator que fala. */
  target: string;
  /** Texto da legenda (e da fala sintetizada no fallback). */
  text: string;
  /** Arquivo de áudio (ex.: 'audio/fala01.mp3'). Sem ele usa a voz do ator. */
  audio?: string;
  volume?: number;
  /** Tempo extra da legenda na tela após a fala. */
  hold?: number;
}

export interface CameraCutEvent extends EventBase, CameraShotSpec {
  type: 'CAMERA_CUT';
}

export interface CameraTransitionEvent extends EventBase, CameraShotSpec {
  type: 'CAMERA_TRANSITION';
}

export interface CameraShakeEvent extends EventBase {
  type: 'CAMERA_SHAKE';
  /** Amplitude inicial (0.1 sutil, 1 forte). */
  intensity?: number;
  /** Hz do tremor. */
  frequency?: number;
  /** Constante de decaimento exponencial (amplitude = intensity * e^(-decay*t)). */
  decay?: number;
}

export interface SetLightEvent extends EventBase {
  type: 'SET_LIGHT';
  /** Id da luz em scene.lights. */
  target: string;
  color?: string;
  intensity?: number;
  position?: Vec3;
}

export interface SetLookTargetEvent extends EventBase {
  type: 'SET_LOOK_TARGET';
  /** Ator que olha. */
  target: string;
  lookAt: LookTarget;
}

export interface SetExpressionEvent extends EventBase {
  type: 'SET_EXPRESSION';
  target: string;
  expression: Expression;
  intensity?: number;
}

export interface PlayGestureEvent extends EventBase {
  type: 'PLAY_GESTURE';
  target: string;
  /** Gesto embutido ou nome de um gesto em `gestures` do script. */
  gesture: Gesture | (string & {});
}

export interface SetPoseEvent extends EventBase {
  type: 'SET_POSE';
  target: string;
  /** Preset ou pose explícita. 'rest' devolve o corpo à animação procedural. */
  pose: PosePreset | PoseDef;
  /** Se true, mantém articulações da pose anterior que esta não define. */
  merge?: boolean;
  /** Altura do assento (m) para o preset 'sit'. */
  seatHeight?: number;
}

export interface ReachEvent extends EventBase {
  type: 'REACH';
  /** Ator que estende o braço. */
  target: string;
  hand?: Hand | 'both';
  /** Alvo da mão; null recolhe o braço. */
  to: ReachTarget | null;
  /** Balanço vertical da mão (0..1) — ex.: aperto de mão. */
  shake?: number;
  /** Se informado, recolhe o braço automaticamente após este tempo (s). */
  hold?: number;
}

export interface AttachObjectEvent extends EventBase {
  type: 'ATTACH_OBJECT';
  /** Prop a ser preso. */
  target: string;
  /** Ator que segura. */
  to: string;
  socket?: Socket;
  /** Deslocamento no espaço do encaixe (m). */
  offset?: Vec3;
  /** Rotação Euler (graus) no espaço do encaixe. */
  rotation?: Vec3;
}

export interface DetachObjectEvent extends EventBase {
  type: 'DETACH_OBJECT';
  target: string;
  /** Onde o objeto pousa (padrão: no chão, à frente de quem segurava). */
  position?: Vec3;
  rotation?: Vec3;
}

export interface InteractEvent extends EventBase {
  type: 'INTERACT';
  /** Ator que inicia a interação. */
  target: string;
  interaction: Interaction;
  /** Outro ator (handshake, hug, give, push...) ou objeto/ponto (pickUp, pointAt, sit). */
  with?: string;
  /** Objeto envolvido (give: o que é entregue; putDown: o que é largado). */
  object?: string;
  /** Posição (sit: assento; putDown: onde largar; pointAt: ponto). */
  position?: Vec3;
  /** Yaw final (graus) para 'sit'/'kneel'. */
  facing?: number;
  seatHeight?: number;
  /** Se false, não caminha até o outro antes de interagir (padrão true). */
  approach?: boolean;
}

export interface PlayAnimationEvent extends EventBase {
  type: 'PLAY_ANIMATION';
  target: string;
  /** Nome do clipe GLTF. */
  clip: string;
  loop?: boolean;
  /** Crossfade em segundos. */
  fade?: number;
}

export interface SetRetroFxEvent extends EventBase {
  type: 'SET_RETRO_FX';
  enabled?: boolean;
  settings?: Partial<RetroSettings>;
}

export interface FadeScreenEvent extends EventBase {
  type: 'FADE_SCREEN';
  /** 0 = cena visível, 1 = tela coberta pela cor. */
  to: number;
  color?: string;
}

export interface FlashScreenEvent extends EventBase {
  type: 'FLASH_SCREEN';
  color?: string;
  intensity?: number;
}

export interface PlaySoundEvent extends EventBase {
  type: 'PLAY_SOUND';
  /** URL ou um dos PROCEDURAL_SOUNDS. */
  src: string;
  volume?: number;
  loop?: boolean;
}

export type StoryEvent =
  | SpawnObjectEvent
  | DespawnObjectEvent
  | TransformObjectEvent
  | PlayAudioWithLipsyncEvent
  | CameraCutEvent
  | CameraTransitionEvent
  | CameraShakeEvent
  | SetLightEvent
  | SetLookTargetEvent
  | SetExpressionEvent
  | PlayGestureEvent
  | SetPoseEvent
  | ReachEvent
  | AttachObjectEvent
  | DetachObjectEvent
  | InteractEvent
  | PlayAnimationEvent
  | SetRetroFxEvent
  | FadeScreenEvent
  | FlashScreenEvent
  | PlaySoundEvent;

export type EventType = StoryEvent['type'];
export type EventOf<K extends EventType> = Extract<StoryEvent, { type: K }>;

export interface StoryMeta {
  title: string;
  author?: string;
  /** Duração mínima; por padrão é o fim do último evento. */
  duration?: number;
  loop?: boolean;
}

export interface StoryScript {
  meta: StoryMeta;
  scene?: SceneDef;
  fx?: FxDef;
  cameras?: CameraShotDef[];
  /** Gestos customizados por keyframes, usados por PLAY_GESTURE. */
  gestures?: Record<string, GestureDef>;
  timeline: StoryEvent[];
}

/* -------------------------------------------------------------------------- */
/*  Estado de quadro (saída de ActionRegistry.evaluate)                        */
/* -------------------------------------------------------------------------- */

export type ExpressionWeights = Record<Expression, number>;

export interface SocketRef {
  actor: string;
  socket: Socket;
  offset: Vec3;
  rotation: Vec3;
}

/** Encaixe de um objeto: transição de `from` para `to` (null = solto no mundo). */
export interface AttachValue {
  from: SocketRef | null;
  to: SocketRef | null;
  alpha: number;
}

export interface ObjectFrame {
  position: Vec3;
  /** Euler em graus. */
  rotation: Vec3;
  scale: number;
  visible: boolean;
  attach: AttachValue;
}

export interface PoseFrame {
  joints: Record<Joint, { rot: Vec3; w: number }>;
  crouch: number;
}

export interface ReachFrame {
  target: ReachTarget | null;
  /** Alvo anterior (transição entre alvos com o braço estendido). */
  prev: ReachTarget | null;
  /** 0..1 de `prev` para `target`. */
  blend: number;
  /** 0 = braço livre (procedural), 1 = mão no alvo. */
  weight: number;
  shake: number;
}

export interface ClipState {
  name: string;
  loop: boolean;
  startAt: number;
  fade: number;
  prev: { name: string; loop: boolean; startAt: number } | null;
}

export interface ActorFrame {
  expression: ExpressionWeights;
  lookAt: LookTarget;
  gesture: { name: string; progress: number } | null;
  clip: ClipState | null;
  pose: PoseFrame;
  reach: Record<Hand, ReachFrame>;
}

export interface LightFrame {
  color: RGB;
  intensity: number;
  position: Vec3;
}

/** Valor da câmera: um plano, ou mistura (possivelmente aninhada) entre planos. */
export type CameraValue =
  | { kind: 'shot'; spec: CameraShotSpec }
  | { kind: 'blend'; from: CameraValue; to: CameraValue; alpha: number };

export interface ShakeState {
  intensity: number;
  frequency: number;
  decay: number;
  /** Segundos desde o início do tremor. */
  localTime: number;
  /** Semente para o ruído (estável por evento). */
  seed: number;
}

export interface ActiveDialogue {
  key: string;
  actorId: string;
  text: string;
  audio?: string;
  volume: number;
  start: number;
  /** Tempo de fala (sem o hold). */
  speakDuration: number;
  localTime: number;
}

export interface ActiveSound {
  key: string;
  src: string;
  volume: number;
  loop: boolean;
  start: number;
  duration: number;
  localTime: number;
}

export interface FxFrame {
  retro: boolean;
  settings: RetroSettings;
  fade: number;
  fadeColor: RGB;
  flash: number;
  flashColor: RGB;
}

export interface FrameState {
  time: number;
  objects: Record<string, ObjectFrame>;
  actors: Record<string, ActorFrame>;
  lights: Record<string, LightFrame>;
  camera: CameraValue;
  shakes: ShakeState[];
  fx: FxFrame;
  dialogues: ActiveDialogue[];
  sounds: ActiveSound[];
}

export const DEFAULT_RETRO_SETTINGS: RetroSettings = {
  pixelSize: 3,
  colorLevels: 32,
  dither: 1,
  scanlines: 0.25,
  curvature: 0.08,
  vignette: 0.35,
  chromatic: 0.0012,
  noise: 0.035,
  vertexSnap: 1,
};

/** Caracteres falados por segundo usados para estimar a duração das falas. */
export const CHARS_PER_SECOND = 13.5;

/** Duração estimada de uma fala: ~1s para cada 12–15 caracteres (mínimo 1.2s). */
export function estimateSpeechDuration(text: string, rate = 1): number {
  const chars = text.trim().length;
  return Math.max(1.2, chars / (CHARS_PER_SECOND * Math.max(0.1, rate)));
}

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

export const PROCEDURAL_SOUNDS = [
  'procedural:wind',
  'procedural:thunder',
  'procedural:fire',
  'procedural:chime',
  'procedural:drip',
  'procedural:hum',
  'procedural:water',
  'procedural:switch',
  'procedural:door',
] as const;

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
  /**
   * Padrão projetado (gobo/cookie), só para 'spot': `'blinds' | 'window' | 'leaves'`
   * (gerados por procedimento) ou a URL de uma imagem própria.
   */
  cookie?: string;
}

export const LIGHT_COOKIE_PRESETS = ['blinds', 'window', 'leaves'] as const;

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
  | 'table'
  | 'chair'
  | 'bookshelf'
  | 'bed'
  | 'rug'
  | 'candle'
  | 'door'
  | 'orb'
  | 'book'
  | 'cup'
  | 'model'
  | 'particles'
  | 'screen';

export const PARTICLE_PRESETS = ['steam', 'smoke', 'dust', 'sparks'] as const;
export type ParticlePreset = (typeof PARTICLE_PRESETS)[number];

/** Apenas para prop = 'particles'. Determinístico por seed e tempo: o seek permanece reversível. */
export interface ParticlesDef {
  preset: ParticlePreset;
  /** Número de partículas. Padrão depende do preset. */
  count?: number;
}

export const SCREEN_EFFECTS = ['lcd', 'dots', 'crt'] as const;
export type ScreenEffect = (typeof SCREEN_EFFECTS)[number];

/**
 * Apenas para prop = 'screen'. Tela/monitor que mostra uma imagem ou vídeo (detectado pela
 * extensão: .mp4/.webm/.ogg tocam como vídeo, o resto como imagem estática).
 * Limitação: vídeo toca em loop por conta própria, fora do controle do relógio da história
 * (como a voz nativa do navegador) — não é capturado pela exportação nem reversível no seek.
 */
export interface ScreenDef {
  src: string;
  /** Metros. Padrão 1.6 × 0.9 (16:9). */
  width?: number;
  height?: number;
  /** Só para vídeo. Padrão true. */
  loop?: boolean;
  effect?: ScreenEffect;
}

export interface PropDef {
  prop: PropType;
  color?: string;
  /** Apenas para prop = 'model'. */
  model?: string;
  particles?: ParticlesDef;
  screen?: ScreenDef;
}

/** Cenografia estática (não endereçável pela timeline). */
export interface StaticPropDef extends PropDef {
  position: Vec3;
  /** Graus em torno do eixo Y. */
  rotation?: number;
  scale?: number;
}

export type WallSide = 'north' | 'south' | 'east' | 'west';

/** Abertura numa parede do cômodo. `offset` = deslocamento do centro ao longo da parede (m). */
export interface WallOpening {
  wall: WallSide;
  offset?: number;
  width?: number;
}

/**
 * Ambiente interno (cômodo) centrado na origem. Norte = -Z, Sul = +Z, Leste = +X, Oeste = -X.
 * As paredes só são visíveis por dentro: câmeras do lado de fora enxergam através delas.
 */
export interface RoomDef {
  width: number;
  depth: number;
  height?: number;
  wallColor?: string;
  floorColor?: string;
  floor?: 'wood' | 'stone' | 'tiles';
  ceiling?: boolean;
  doors?: WallOpening[];
  windows?: WallOpening[];
}

export interface SceneDef {
  background?: string;
  sky?: SkyDef;
  fog?: FogDef;
  ground?: GroundDef;
  lights?: LightDef[];
  props?: StaticPropDef[];
  room?: RoomDef;
  /**
   * Hora do dia (0–24). Quando definida, a engine cria sol/lua, céu e névoa
   * automáticos e permite SET_TIME_OF_DAY. Combina com `lights` do script.
   */
  timeOfDay?: number;
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
  /** Cor de acessórios (chapéu, capa, cachecol, mochila...). */
  accent?: string;
  /**
   * URL de uma imagem (PNG com transparência) pintada sobre o rosto procedural
   * (sobrancelhas, barba por fazer, dentes...), sem precisar de um modelo GLTF
   * completo. Fica atrás dos olhos/boca procedurais, que continuam animando.
   */
  faceTexture?: string;
}

export const BODY_BUILDS = ['slim', 'average', 'athletic', 'heavy'] as const;
export type BodyBuild = (typeof BODY_BUILDS)[number];

export const HAIR_STYLES = ['short', 'long', 'ponytail', 'bun', 'spiky', 'mohawk', 'bald'] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

/** 'screen': cabeça-visor (robô) — olhos/boca desenhados num canvas emissivo em vez de morphs. */
export const HEAD_SHAPES = ['box', 'round', 'egg', 'bulb', 'pear', 'cone', 'can', 'wide', 'screen'] as const;
export type HeadShape = (typeof HEAD_SHAPES)[number];

export const OUTFITS = ['casual', 'robe', 'dress'] as const;
export type Outfit = (typeof OUTFITS)[number];

export const ACCESSORIES = [
  'hat',
  'wizardHat',
  'cap',
  'crown',
  'glasses',
  'beard',
  'mustache',
  'scarf',
  'backpack',
  'cape',
] as const;
export type Accessory = (typeof ACCESSORIES)[number];

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
  /** Tipo de corpo do personagem procedural. */
  build?: BodyBuild;
  /** Formato da cabeça do personagem procedural. */
  headShape?: HeadShape;
  hair?: HairStyle;
  outfit?: Outfit;
  accessories?: Accessory[];
  /**
   * Visual das legendas deste ator, por cima do bloco `subtitles` do roteiro
   * (ex.: fonte itálica para um personagem, serifada para outro).
   */
  subtitle?: ActorSubtitleStyle;
}

export interface ActorSubtitleStyle {
  /** Família de fonte CSS do texto falado por este ator. */
  font?: string;
  /** Cor do texto falado por este ator (o nome continua usando `color`). */
  color?: string;
  /** Multiplicador do tamanho do texto deste ator (substitui `subtitles.size`). */
  size?: number;
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
  /**
   * Deriva lenta e contínua enquanto o plano estiver ativo (dolly-in / pan),
   * em vez de uma câmera estática. Aplicada por segundo desde o início do plano.
   */
  drift?: CameraDriftSpec;
}

/** `push`: metros/s na direção do alvo (positivo aproxima). `pan`: graus/s em torno do alvo (eixo Y). */
export interface CameraDriftSpec {
  push?: number;
  pan?: number;
  /** Depois desse tempo (s) a deriva para no valor atingido. Padrão: sem limite. */
  duration?: number;
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

export const COLOR_GRADES = ['none', 'warm', 'cool', 'noir'] as const;
export type ColorGrade = (typeof COLOR_GRADES)[number];

/** Desfoque de profundidade (bokeh). Independente do retro FX. */
export interface DofDef {
  /** Abertura: quanto maior, mais forte o desfoque fora de foco. Padrão 0.025. */
  aperture?: number;
  /** Distância de foco (m). Sem isso, segue automaticamente o alvo do plano de câmera atual. */
  focus?: number;
}

/** Brilho (bloom) em áreas claras/emissivas. Independente do retro FX. */
export interface BloomDef {
  /** Intensidade. Padrão 0.6. */
  strength?: number;
  /** Raio de espalhamento. Padrão 0.4. */
  radius?: number;
  /** Luminância mínima para brilhar (0..1). Padrão 0.85. */
  threshold?: number;
}

export interface FxDef {
  retro?: boolean;
  settings?: Partial<RetroSettings>;
  /** Correção de cor independente do retro FX (também funciona com ele desligado). Padrão 'none'. */
  grade?: ColorGrade;
  /** Presença = ligado; campos opcionais usam os padrões. */
  dof?: DofDef;
  bloom?: BloomDef;
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
  /** false = fala sem legenda (o áudio e o lipsync continuam). */
  subtitle?: boolean;
  /**
   * Id de um objeto (prop ou ator) citado nesta fala. Com `meta.autoCamera`, a cobertura
   * automática corta para um plano de inserção (B-roll) nele no meio da fala.
   */
  cutaway?: string;
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

export interface SetTimeOfDayEvent extends EventBase {
  type: 'SET_TIME_OF_DAY';
  /** Hora alvo (0–24). O tempo sempre avança (de 22 para 2 passa pela meia-noite). */
  hour: number;
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

export const SOUND_BUSES = ['sfx', 'music'] as const;
export type SoundBus = (typeof SOUND_BUSES)[number];

export interface PlaySoundEvent extends EventBase {
  type: 'PLAY_SOUND';
  /** URL ou um dos PROCEDURAL_SOUNDS. */
  src: string;
  volume?: number;
  loop?: boolean;
  /** 'sfx' (padrão) ou 'music' — a trilha 'music' abaixa automaticamente enquanto alguém fala. */
  bus?: SoundBus;
}

export interface ShowTitleEvent extends EventBase {
  type: 'SHOW_TITLE';
  title: string;
  subtitle?: string;
  /** Segundos em tela (padrão 3). */
  duration?: number;
  /** true = só o texto (com sombra), sem a faixa escura — para sobrepor a uma cena em andamento. Padrão false. */
  overlay?: boolean;
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
  | SetTimeOfDayEvent
  | FadeScreenEvent
  | FlashScreenEvent
  | PlaySoundEvent
  | ShowTitleEvent;

export type EventType = StoryEvent['type'];
export type EventOf<K extends EventType> = Extract<StoryEvent, { type: K }>;

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const WATERMARK_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'] as const;
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];

/** Marca d'água fixa sobre a cena (tela e vídeo exportado). `text` e/ou `image` — pelo menos um. */
export interface WatermarkDef {
  text?: string;
  /** URL/data URI de uma imagem (logo), desenhada ao lado do texto. */
  image?: string;
  /** Padrão 'bottom-right'. */
  position?: WatermarkPosition;
  /** 0..1. Padrão 0.8. */
  opacity?: number;
  /** Tamanho do texto em px (720p); escala com o quadro como as legendas. Padrão 22. */
  size?: number;
  color?: string;
}

/**
 * Cobertura automática: gera `CAMERA_CUT`s a partir das falas (`PLAY_AUDIO_WITH_LIPSYNC`) — plano do
 * ator que fala, plano reação de quem escuta, e um plano geral de tempos em tempos. Eventos de câmera
 * explícitos no roteiro sempre têm prioridade (nenhum corte é gerado perto deles). `true` usa os padrões.
 */
export interface AutoCameraDef {
  /** Divide falas mais longas que isto (s) com um corte de reação no meio. Padrão 4. */
  maxShotSeconds?: number;
  /** A cada quantas falas um plano geral reestabelece a cena. 0 = nunca. Padrão 4. */
  wideEvery?: number;
}

export interface StoryMeta {
  title: string;
  author?: string;
  /** Duração mínima; por padrão é o fim do último evento. */
  duration?: number;
  loop?: boolean;
  /**
   * Formato do quadro: '16:9' (paisagem), '9:16' (vertical: Reels, TikTok, Shorts)
   * ou '1:1'. A tela mostra o quadro com tarjas e o vídeo sai em 1080p nesse
   * formato. Sem `aspect`, a cena ocupa a janela inteira.
   */
  aspect?: AspectRatio;
  watermark?: WatermarkDef;
  /** Cobertura automática de câmera para todo capítulo que não definir a sua própria. */
  autoCamera?: boolean | AutoCameraDef;
}

/** Capítulo: uma cena completa (cenário próprio) dentro de uma história maior. */
export interface ChapterDef {
  title: string;
  /** Cenário/efeitos/câmeras do capítulo; se omitidos, herdam os do topo do script. */
  scene?: SceneDef;
  fx?: FxDef;
  cameras?: CameraShotDef[];
  gestures?: Record<string, GestureDef>;
  timeline: StoryEvent[];
  /** Duração mínima do capítulo (s). */
  duration?: number;
  /** Entrada do capítulo: 'fade' (padrão, escurece e clareia) ou 'cut'. */
  transition?: 'fade' | 'cut';
  /** Cartela com o título no início do capítulo (padrão true). */
  showTitle?: boolean;
  /** Cobertura automática de câmera; se omitido, herda de `meta.autoCamera`. */
  autoCamera?: boolean | AutoCameraDef;
}

export const SUBTITLE_STYLES = ['box', 'plain', 'outline'] as const;
export const SUBTITLE_POSITIONS = ['bottom', 'top', 'center', 'speaker'] as const;
export const SUBTITLE_MODES = ['typewriter', 'words', 'chunk'] as const;

/** Visual das legendas (tela e vídeo exportado). */
export interface SubtitleDef {
  /** false = sem legendas. Padrão true. */
  enabled?: boolean;
  /** 'box' = caixa estilo RPG (padrão); 'plain' = texto de cinema com contorno; 'outline' = contorno + sombra projetada. */
  style?: (typeof SUBTITLE_STYLES)[number];
  /** 'bottom' (padrão), 'top', 'center' ou 'speaker' (balão sobre a cabeça de quem fala). */
  position?: (typeof SUBTITLE_POSITIONS)[number];
  /** Distância extra da borda em px (em 'speaker': acima da cabeça). Padrão 0. */
  margin?: number;
  /** Mostra o nome de quem fala. Padrão true. */
  showName?: boolean;
  /** Revela o texto letra a letra. Padrão true. Ignorado quando `mode` não é 'typewriter'. */
  typewriter?: boolean;
  /**
   * Como o texto da fala aparece: 'typewriter' (a linha inteira, letra a letra — padrão);
   * 'words' (grupos de até `maxWords` palavras que crescem palavra a palavra e são
   * substituídos pelo próximo grupo, estilo TikTok/Reels); 'chunk' (como 'words', mas cada
   * grupo aparece de uma vez, sem revelação progressiva).
   */
  mode?: (typeof SUBTITLE_MODES)[number];
  /** Palavras por grupo nos modos 'words' (1–4 típico) e 'chunk' (6–8 típico). Padrão 3. */
  maxWords?: number;
  /** Multiplicador do tamanho do texto (1 = padrão). */
  size?: number;
  color?: string;
  /** Fundo e borda da caixa (style 'box'). */
  background?: string;
  border?: string;
  /** Família de fonte CSS (padrão 'VT323'). */
  font?: string;
}

export interface StoryScript {
  /** Caminho/URL do JSON Schema (autocompletar em editores); ignorado pela engine. */
  $schema?: string;
  meta: StoryMeta;
  subtitles?: SubtitleDef;
  scene?: SceneDef;
  fx?: FxDef;
  cameras?: CameraShotDef[];
  /** Gestos customizados por keyframes, usados por PLAY_GESTURE. */
  gestures?: Record<string, GestureDef>;
  /**
   * Elenco reutilizável: um SPAWN_OBJECT sem `object` cujo `target` esteja aqui
   * usa esta definição (evita repetir o personagem em cada capítulo).
   */
  cast?: Record<string, ObjectDef>;
  /** Cena única. Obrigatório quando não há `chapters`. */
  timeline?: StoryEvent[];
  /** História em capítulos, tocados em sequência. */
  chapters?: ChapterDef[];
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
  | { kind: 'shot'; spec: CameraShotSpec; /** Instante (s) em que o plano começou, para a deriva (`drift`). */ start: number }
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
  /** Se a fala aparece nas legendas. */
  subtitle: boolean;
}

export interface ActiveSound {
  key: string;
  src: string;
  volume: number;
  loop: boolean;
  start: number;
  duration: number;
  localTime: number;
  bus: SoundBus;
}

/** `focus: null` = segue automaticamente o alvo do plano de câmera atual. */
export interface ResolvedDof {
  aperture: number;
  focus: number | null;
}

export interface ResolvedBloom {
  strength: number;
  radius: number;
  threshold: number;
}

export interface FxFrame {
  retro: boolean;
  settings: RetroSettings;
  grade: ColorGrade;
  dof: ResolvedDof | null;
  bloom: ResolvedBloom | null;
  fade: number;
  fadeColor: RGB;
  flash: number;
  flashColor: RGB;
}

/** Cartela de título ativa (chapter automático ou SHOW_TITLE explícito). */
export interface TitleCardFrame {
  title: string;
  subtitle: string;
  /** 0..1 ao longo da exibição. */
  progress: number;
  overlay: boolean;
}

export interface FrameState {
  time: number;
  objects: Record<string, ObjectFrame>;
  actors: Record<string, ActorFrame>;
  lights: Record<string, LightFrame>;
  camera: CameraValue;
  shakes: ShakeState[];
  fx: FxFrame;
  /** Hora do dia (pode passar de 24; aplicar módulo). null = ciclo desligado. */
  hour: number | null;
  dialogues: ActiveDialogue[];
  sounds: ActiveSound[];
  /** Cartela de título de um evento SHOW_TITLE explícito (null = nenhuma ativa). */
  titleCard: TitleCardFrame | null;
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

/** `ScreenDef.src` toca como vídeo (pela extensão) em vez de imagem estática. */
export function isVideoSrc(src: string): boolean {
  return /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(src);
}

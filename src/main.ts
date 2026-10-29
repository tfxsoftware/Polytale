import * as THREE from 'three';
import { Engine } from './core/Engine';
import { SceneManager } from './core/SceneManager';
import { AssetLoader } from './core/AssetLoader';
import { loadDraft, saveDraft, scriptFromLocation } from './core/ScriptStorage';
import { ScriptHistory } from './core/ScriptHistory';
import { aspectValue, exportSize } from './core/VideoFormat';
import { Timeline } from './timeline/Timeline';
import { ActionRegistry, StoryScriptError } from './timeline/ActionRegistry';
import { compileProject, evaluateProject, type CompiledChapter, type CompiledProject } from './timeline/StoryProject';
import type { ActiveDialogue, ActorObjectDef, FrameState, StoryScript } from './timeline/types';
import { CameraDirector } from './systems/CameraDirector';
import { AudioLipsync } from './systems/AudioLipsync';
import { PostProcessing } from './systems/PostProcessing';
import { Recorder } from './systems/Recorder';
import { ControlPanel } from './ui/ControlPanel';
import { TimelineEditor } from './ui/TimelineEditor';
import { TimelineView } from './ui/TimelineView';
import { GeneratorPanel } from './ui/GeneratorPanel';
import { DialogueBox } from './ui/DialogueBox';
import { SettingsPanel } from './ui/SettingsPanel';
import { resolveSubtitles, type ScreenPoint, type SpeakerInfo, type SubtitleStyle } from './ui/SubtitleRenderer';
import { resolveWatermark, type WatermarkStyle } from './ui/Watermark';
import { TitleCard, type TitleCardState } from './ui/TitleCard';
import { ExportOverlay } from './ui/ExportOverlay';
import { defaultScript } from './config/defaultScript';

/* -------------------------------------------------------------------------- */
/*  DOM                                                                       */
/* -------------------------------------------------------------------------- */

const app = document.getElementById('app');
if (!app) throw new Error('#app não encontrado');
const viewport = document.createElement('div');
viewport.className = 'viewport';
const ui = document.createElement('div');
ui.className = 'ui-layer';
app.append(viewport, ui);

/* -------------------------------------------------------------------------- */
/*  Sistemas                                                                  */
/* -------------------------------------------------------------------------- */

const engine = new Engine(viewport);
const sceneManager = new SceneManager();
const timeline = new Timeline();
const registry = new ActionRegistry();
const audio = new AudioLipsync();
const assets = new AssetLoader(audio.context);
const director = new CameraDirector(engine.camera, sceneManager);
const post = new PostProcessing(engine.renderer, sceneManager.scene, engine.camera);
const recorder = new Recorder(engine.canvas, audio.context, audio.output);
const history = new ScriptHistory();

let project: CompiledProject | null = null;
let chapter: CompiledChapter | null = null;
let builtChapter = -1;
let currentScript: unknown = defaultScript;
let lastFrame: FrameState | null = null;
let overlay: { dialogues: ActiveDialogue[]; titleCard: TitleCardState | null } = { dialogues: [], titleCard: null };
let resumeAfterScrub = false;
/** Legendas do roteiro; `subtitlesHidden` é o atalho L (vale para a tela e o vídeo). */
let subtitles: SubtitleStyle = resolveSubtitles(undefined);
let subtitlesHidden = false;
let watermark: WatermarkStyle | null = null;

const speaker = (actorId: string): SpeakerInfo => {
  const def = chapter?.story.objects.get(actorId);
  if (def?.kind !== 'actor') return { name: actorId, color: '#ffffff' };
  return { name: def.name, color: def.color ?? '#ffffff', font: def.subtitle?.font, textColor: def.subtitle?.color, size: def.subtitle?.size };
};

const headTop = new THREE.Vector3();

/** Topo da cabeça do ator na tela (0..1); null se estiver atrás da câmera ou fora de quadro. */
const speakerAnchor = (actorId: string): ScreenPoint | null => {
  const p = sceneManager.actorHeadTop(actorId, headTop);
  if (!p) return null;
  p.project(engine.camera);
  if (p.z > 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) return null;
  return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
};

// Legendas e cartela ficam dentro do quadro (acompanham as tarjas de meta.aspect).
const titleCard = new TitleCard(viewport);
const dialogue = new DialogueBox(viewport, speaker);

const panel = new ControlPanel(ui, {
  onTogglePlay: () => {
    void audio.unlock();
    timeline.toggle();
  },
  onRestart: () => timeline.seek(0),
  onSeek: (t) => timeline.seek(t),
  onScrubStart: () => {
    resumeAfterScrub = timeline.playing;
    timeline.pause();
  },
  onScrubEnd: () => {
    if (resumeAfterScrub) timeline.play();
    resumeAfterScrub = false;
  },
  onStep: (d) => timeline.step(d),
  onToggleRetro: () => post.toggleUser(),
  onToggleMute: () => {
    audio.setMuted(!audio.muted);
    return audio.muted;
  },
  onRate: (r) => timeline.setRate(r),
  onOpenEditor: () => {
    timeline.pause();
    editor.open(currentScript);
  },
  onExportVideo: () => void exportVideo(),
  onOpenGenerator: () => {
    timeline.pause();
    void generator.open();
  },
  onToggleSubtitles: () => {
    subtitlesHidden = !subtitlesHidden;
    applySubtitles();
    panel.setStatus(subtitlesHidden ? 'Legendas ocultas (L para mostrar).' : 'Legendas visíveis.');
  },
  onOpenSettings: () => {
    if (isScript(currentScript)) settings.toggle(currentScript.subtitles);
  },
  onToggleTracks: () => {
    if (isScript(currentScript)) tracks.toggle(currentScript, chapter?.index ?? 0);
  },
  onUndo: () => void stepHistory('undo'),
  onRedo: () => void stepHistory('redo'),
});

const settings = new SettingsPanel(ui, {
  onSubtitlesChange: (def) => {
    if (!isScript(currentScript) || !project) return;
    // Só muda a apresentação: atualiza o roteiro sem recompilar a história.
    const next: StoryScript = { ...currentScript, subtitles: def };
    if (!def) delete next.subtitles;
    currentScript = next;
    project.script = next;
    applySubtitles();
    saveDraft(next);
    history.record(next, 'subtitles');
    if (tracks.isOpen) tracks.setScript(next, chapter?.index ?? 0);
  },
  onAspectChange: (aspect) => {
    if (!isScript(currentScript) || !project) return;
    // Os presets de câmera leem a proporção a cada quadro: não precisa recompilar.
    const meta = { ...currentScript.meta, aspect };
    if (!aspect) delete meta.aspect;
    const next: StoryScript = { ...currentScript, meta };
    currentScript = next;
    project.script = next;
    applyFormat();
    saveDraft(next);
    history.record(next);
    if (tracks.isOpen) tracks.setScript(next, chapter?.index ?? 0);
  },
});

const editor = new TimelineEditor(ui, {
  onApply: (raw) => applyScript(raw),
  getDefault: () => defaultScript,
});

const tracks = new TimelineView(ui, {
  onChange: async (script) => {
    const errors = await loadStory(script, { keepTime: timeline.time, persist: true, fromTracks: true });
    if (!errors.length) history.record(script);
    return errors;
  },
  onSeek: (index, local) => {
    const c = project?.chapters[index];
    if (c) timeline.seek(c.start + local);
  },
  onOpen: () => timeline.pause(),
});

const generator = new GeneratorPanel(ui, {
  validate: (script) => {
    try {
      compileProject(registry, script);
      return [];
    } catch (err) {
      return err instanceof StoryScriptError ? err.errors : [err instanceof Error ? err.message : String(err)];
    }
  },
  onScript: async (script) => {
    const errors = await applyScript(script);
    if (errors.length) throw new Error(errors[0]);
    panel.setStatus('Roteiro gerado pela IA aplicado — aperte ▶ para assistir.');
  },
});

function applySubtitles(): void {
  const style = resolveSubtitles(project?.script.subtitles);
  subtitles = subtitlesHidden ? { ...style, enabled: false } : style;
  dialogue.setStyle(subtitles);
}

function applyWatermark(): void {
  watermark = resolveWatermark(project?.script.meta.watermark);
  dialogue.setWatermark(watermark);
}

/** meta.aspect: quadro com tarjas na tela e legendas na mesma escala do vídeo. */
function applyFormat(): void {
  const aspect = project?.script.meta.aspect;
  viewport.classList.toggle('is-framed', !!aspect);
  if (aspect) viewport.style.setProperty('--frame-aspect', String(aspectValue(aspect)));
  else viewport.style.removeProperty('--frame-aspect');
  dialogue.setFramed(!!aspect);
  settings.setAspect(aspect);
}

function isScript(v: unknown): v is StoryScript {
  return typeof v === 'object' && v !== null && 'meta' in v;
}

/* -------------------------------------------------------------------------- */
/*  Carregamento de histórias                                                 */
/* -------------------------------------------------------------------------- */

async function applyScript(raw: unknown): Promise<string[]> {
  const errors = await loadStory(raw, { persist: true });
  if (!errors.length) history.record(raw);
  if (!errors.length && isScript(raw) && tracks.isOpen) tracks.setScript(raw, 0);
  return errors;
}

let historyBusy = false;

/** Desfaz/refaz: recarrega a versão anterior/seguinte mantendo a posição da timeline. */
async function stepHistory(direction: 'undo' | 'redo'): Promise<void> {
  if (historyBusy || recorder.recording) return;
  const script = direction === 'undo' ? history.undo() : history.redo();
  if (!script) {
    panel.setStatus(direction === 'undo' ? 'Nada para desfazer.' : 'Nada para refazer.');
    return;
  }
  historyBusy = true;
  try {
    const errors = await loadStory(script, { keepTime: timeline.time, persist: true });
    if (errors.length) {
      // Volta o ponteiro do histórico para a versão que continua carregada.
      if (direction === 'undo') history.redo();
      else history.undo();
      panel.setStatus(`Não foi possível ${direction === 'undo' ? 'desfazer' : 'refazer'}: ${errors[0]}`, 'error');
      return;
    }
    if (isScript(script)) {
      if (tracks.isOpen) tracks.setScript(script, chapter?.index ?? 0);
      if (settings.isOpen) settings.refresh(script.subtitles);
    }
    panel.setStatus(direction === 'undo' ? 'Desfeito (Ctrl+Shift+Z refaz).' : 'Refeito.');
  } finally {
    historyBusy = false;
  }
}

interface LoadOptions {
  /** Mantém a posição da timeline (ex.: edição nas trilhas). */
  keepTime?: number;
  /** Salva como rascunho local se der certo. */
  persist?: boolean;
  fromTracks?: boolean;
}

/** Valida, carrega assets e compila todos os capítulos. Retorna erros (vazio = ok). */
async function loadStory(raw: unknown, options: LoadOptions = {}): Promise<string[]> {
  if (!isScript(raw)) return ['o StoryScript deve ser um objeto JSON com "meta"'];
  timeline.pause();
  try {
    panel.setStatus('Carregando assets…');
    const result = await assets.preload(AssetLoader.manifestOf(raw), (p) => {
      if (p.total) panel.setStatus(`Carregando assets ${p.loaded}/${p.total}…`);
    });
    for (const [url, buffer] of assets.loadedAudio()) audio.registerBuffer(url, buffer);

    const compiled = compileProject(registry, raw, {
      speechDuration: (ev, actor) => audio.durationFor(ev, actor),
      soundDuration: (src) => audio.soundDuration(src),
    });
    compiled.warnings.forEach((w) => console.warn(`[StoryScript] ${w}`));

    project = compiled;
    applySubtitles();
    applyWatermark();
    applyFormat();
    builtChapter = -1; // força reconstruir a cena do capítulo atual
    currentScript = raw;
    timeline.setDuration(compiled.duration);
    timeline.setLoop(raw.meta.loop ?? false);
    timeline.seek(Math.min(options.keepTime ?? 0, compiled.duration));
    panel.setTitle(raw.meta.title);
    panel.setMarkers(compiled.markers, compiled.duration);
    panel.setStatus(result.failed.length ? `Assets ausentes (fallback procedural): ${result.failed.join(', ')}` : null);
    if (options.persist) saveDraft(raw);
    return [];
  } catch (err) {
    const errors = err instanceof StoryScriptError ? err.errors : [err instanceof Error ? err.message : String(err)];
    panel.setStatus(null);
    if (!(err instanceof StoryScriptError)) console.error(err);
    return errors;
  }
}

/** Monta a cena de um capítulo (quando o tempo entra num capítulo diferente). */
function ensureChapter(next: CompiledChapter): void {
  chapter = next;
  if (next.index === builtChapter) return;
  const actors: [string, ActorObjectDef][] = [];
  for (const [id, def] of next.story.objects) if (def.kind === 'actor') actors.push([id, def]);
  audio.configureActors(actors);
  sceneManager.build(next.story, assets);
  director.setShots(next.story.shots.values());
  sceneManager.prewarm(engine.renderer, engine.camera);
  dialogue.clear();
  builtChapter = next.index;
}

/* -------------------------------------------------------------------------- */
/*  Vídeo                                                                     */
/* -------------------------------------------------------------------------- */

const exportOverlay = new ExportOverlay(ui, { onCancel: () => void finishExport(false) });
/** Velocidade e loop do usuário, restaurados ao fim da geração. */
let exportRestore: { rate: number; loop: boolean } | null = null;

/**
 * Toca a história do início ao fim gravando o canvas + áudio; baixa o vídeo no final.
 * Com meta.aspect, renderiza em 1080p no formato escolhido, seja qual for a janela.
 */
async function exportVideo(): Promise<void> {
  if (recorder.recording || !project) return;
  if (!Recorder.supported()) {
    panel.setStatus('Este navegador não consegue gerar vídeo (MediaRecorder).', 'error');
    return;
  }
  await audio.unlock();
  tracks.close();
  settings.close();
  exportRestore = { rate: timeline.rate, loop: timeline.loop };
  timeline.pause();
  timeline.setRate(1);
  timeline.setLoop(false);
  audio.setSpeechAsBabble(true);
  timeline.seek(0);
  const aspect = project.script.meta.aspect;
  if (aspect) {
    const size = exportSize(aspect);
    const shown = engine.renderer.getDrawingBufferSize(new THREE.Vector2()).height;
    engine.setRenderSize(size);
    // Pixels PS1 do mesmo tamanho relativo que na tela.
    post.setPixelScale(size.height / Math.max(1, shown));
  }
  recorder.start(30);
  timeline.play();
  panel.setStatus(null);
  exportOverlay.show();
}

async function finishExport(save: boolean): Promise<void> {
  if (!recorder.recording) return;
  timeline.pause();
  const blob = await recorder.stop();
  engine.setRenderSize(null);
  post.setPixelScale(1);
  exportOverlay.hide();
  audio.setSpeechAsBabble(false);
  if (exportRestore) {
    timeline.setRate(exportRestore.rate);
    timeline.setLoop(exportRestore.loop);
    exportRestore = null;
  }
  if (!save) panel.setStatus('Geração do vídeo cancelada.');
  else if (blob && blob.size > 0) {
    Recorder.download(blob, project?.script.meta.title ?? 'polytale');
    const lufs = recorder.measuredLUFS;
    const loudness = lufs !== null && Number.isFinite(lufs) ? ` · ≈${lufs.toFixed(1)} LUFS (alvo: -14)` : '';
    panel.setStatus(`Vídeo baixado (${(blob.size / 1024 / 1024).toFixed(1)} MB${loudness}).`);
  } else panel.setStatus('Não foi possível gerar o vídeo.', 'error');
}

timeline.on('end', () => {
  if (recorder.recording) void finishExport(true);
});

/* -------------------------------------------------------------------------- */
/*  Loop                                                                      */
/* -------------------------------------------------------------------------- */

const cameraPosition = new THREE.Vector3();

engine.onUpdate((dt, elapsed) => {
  if (!project) return;

  // 1. Relógio mestre -> capítulo ativo + estado determinístico da cena.
  timeline.update(dt);
  const pf = evaluateProject(registry, project, timeline.time);
  ensureChapter(pf.chapter);
  const frame = pf.frame;
  lastFrame = frame;

  // 2. Timeline -> objetos/luzes/céu.
  sceneManager.applyFrame(frame);

  // 3. Áudio alinhado à timeline + análise FFT/RMS.
  audio.sync(frame, timeline.playing, timeline.rate, timeline.discontinuity);
  audio.update(dt, frame, timeline.playing);

  // 4. Vida procedural dos atores (respiração, piscar, olhar, poses, IK, lipsync).
  sceneManager.update(dt, frame, (id) => audio.getState(id), director.getPosition(cameraPosition));

  // 5. Câmera, efeitos e UI.
  director.apply(frame);
  post.applyFrame(frame.fx, elapsed, director.getFocusDistance());
  dialogue.render(frame.dialogues, speakerAnchor);
  titleCard.render(pf.titleCard);
  overlay = { dialogues: frame.dialogues, titleCard: pf.titleCard };
  panel.update(timeline.snapshot(), engine.fps);
  if (recorder.recording) exportOverlay.setProgress(timeline.time, timeline.duration);
  tracks.setPlayhead(pf.chapter.index, frame.time);
});

engine.onResize((w, h) => post.setSize(w, h));
engine.setRenderer((dt) => {
  post.render(dt);
  // Copiado logo após o render (antes do navegador limpar o buffer WebGL).
  recorder.captureFrame({ ...overlay, subtitles, watermark, speaker, anchor: speakerAnchor });
});

/* -------------------------------------------------------------------------- */
/*  Bootstrap                                                                 */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    /** Acesso de depuração pelo console do navegador. */
    narrative?: {
      engine: Engine;
      timeline: Timeline;
      registry: ActionRegistry;
      sceneManager: SceneManager;
      audio: AudioLipsync;
      post: PostProcessing;
      director: CameraDirector;
      recorder: Recorder;
      loadStory: (raw: unknown) => Promise<string[]>;
      frame: () => FrameState | null;
      project: () => CompiledProject | null;
      chapter: () => CompiledChapter | null;
      /** Compatibilidade: história do capítulo atual. */
      story: () => CompiledChapter['story'] | null;
    };
  }
}

window.narrative = {
  engine,
  timeline,
  registry,
  sceneManager,
  audio,
  post,
  director,
  recorder,
  loadStory: (raw) => loadStory(raw),
  frame: () => lastFrame,
  project: () => project,
  chapter: () => chapter,
  story: () => chapter?.story ?? null,
};

/** Ordem: roteiro do link (#story=) > último rascunho deste navegador > demo. */
async function bootstrap(): Promise<void> {
  engine.start();
  const fromLink = await scriptFromLocation();
  const candidates: [unknown, string][] = [];
  if (fromLink) candidates.push([fromLink, 'link']);
  const draft = loadDraft();
  if (draft && !fromLink) candidates.push([draft, 'rascunho']);
  candidates.push([defaultScript, 'demo']);

  for (const [raw, source] of candidates) {
    const errors = await loadStory(raw);
    if (!errors.length) {
      history.reset(raw);
      const title = isScript(raw) ? raw.meta.title : 'Polytale';
      if (source === 'rascunho') panel.setStatus('Último roteiro editado restaurado (Restaurar demo no editor volta ao original).');
      panel.showStartScreen(title, () => {
        void audio.unlock();
        timeline.play();
      });
      return;
    }
    console.warn(`[bootstrap] roteiro do ${source} inválido:`, errors);
    if (source === 'demo') panel.setStatus(`Erro no script padrão: ${errors[0]}`, 'error');
  }
}

void bootstrap();

import * as THREE from 'three';
import { Engine } from './core/Engine';
import { SceneManager } from './core/SceneManager';
import { AssetLoader } from './core/AssetLoader';
import { Timeline } from './timeline/Timeline';
import { ActionRegistry, StoryScriptError, type CompiledStory } from './timeline/ActionRegistry';
import type { ActorObjectDef, FrameState, StoryScript } from './timeline/types';
import { CameraDirector } from './systems/CameraDirector';
import { AudioLipsync } from './systems/AudioLipsync';
import { PostProcessing } from './systems/PostProcessing';
import { ControlPanel } from './ui/ControlPanel';
import { TimelineEditor } from './ui/TimelineEditor';
import { DialogueBox } from './ui/DialogueBox';
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

let story: CompiledStory | null = null;
let currentScript: unknown = defaultScript;
let lastFrame: FrameState | null = null;
let resumeAfterScrub = false;

const dialogue = new DialogueBox(ui, (actorId) => {
  const def = story?.objects.get(actorId);
  return def?.kind === 'actor' ? { name: def.name, color: def.color ?? '#ffffff' } : { name: actorId, color: '#ffffff' };
});

const panel = new ControlPanel(ui, {
  onTogglePlay: () => {
    void audio.unlock();
    timeline.toggle();
  },
  onRestart: () => {
    timeline.seek(0);
  },
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
});

const editor = new TimelineEditor(ui, {
  onApply: async (raw) => {
    const errors = await loadStory(raw);
    if (!errors.length) currentScript = raw;
    return errors;
  },
  getDefault: () => defaultScript,
});

/* -------------------------------------------------------------------------- */
/*  Carregamento de histórias                                                 */
/* -------------------------------------------------------------------------- */

/** Valida, carrega assets, compila e monta a cena. Retorna erros (vazio = ok). */
async function loadStory(raw: unknown): Promise<string[]> {
  const structural = registry.validateStructure(raw);
  if (structural.length) return structural;
  const script = raw as StoryScript;

  timeline.pause();
  try {
    panel.setStatus('Carregando assets…');
    const result = await assets.preload(AssetLoader.manifestOf(script), (p) => {
      if (p.total) panel.setStatus(`Carregando assets ${p.loaded}/${p.total}…`);
    });
    for (const [url, buffer] of assets.loadedAudio()) audio.registerBuffer(url, buffer);

    const compiled = registry.compile(script, {
      speechDuration: (ev, actor) => audio.durationFor(ev, actor),
      soundDuration: (src) => audio.soundDuration(src),
    });
    compiled.warnings.forEach((w) => console.warn(`[StoryScript] ${w}`));

    const actors: [string, ActorObjectDef][] = [];
    for (const [id, def] of compiled.objects) if (def.kind === 'actor') actors.push([id, def]);
    audio.configureActors(actors);
    sceneManager.build(compiled, assets);
    director.setShots(compiled.shots.values());
    dialogue.clear();

    story = compiled;
    timeline.setDuration(compiled.duration);
    timeline.setLoop(script.meta.loop ?? false);
    timeline.seek(0);
    panel.setTitle(script.meta.title);
    panel.setMarkers(compiled.markers, compiled.duration);
    panel.setStatus(result.failed.length ? `Assets ausentes (fallback procedural): ${result.failed.join(', ')}` : null);
    return [];
  } catch (err) {
    const errors = err instanceof StoryScriptError ? err.errors : [err instanceof Error ? err.message : String(err)];
    panel.setStatus(null);
    if (!(err instanceof StoryScriptError)) console.error(err);
    return errors;
  }
}

/* -------------------------------------------------------------------------- */
/*  Loop                                                                      */
/* -------------------------------------------------------------------------- */

const cameraPosition = new THREE.Vector3();

engine.onUpdate((dt, elapsed) => {
  if (!story) return;

  // 1. Relógio mestre -> estado determinístico da cena.
  timeline.update(dt);
  const frame = registry.evaluate(story, timeline.time);
  lastFrame = frame;

  // 2. Timeline -> objetos/luzes.
  sceneManager.applyFrame(frame);

  // 3. Áudio alinhado à timeline + análise FFT/RMS.
  audio.sync(frame, timeline.playing, timeline.rate, timeline.discontinuity);
  audio.update(dt, frame, timeline.playing);

  // 4. Vida procedural dos atores (respiração, piscar, olhar, lipsync).
  sceneManager.update(dt, frame, (id) => audio.getState(id), director.getPosition(cameraPosition));

  // 5. Câmera, efeitos e UI.
  director.apply(frame);
  post.applyFrame(frame.fx, elapsed);
  dialogue.render(frame.dialogues);
  panel.update(timeline.snapshot(), engine.fps);
});

engine.onResize((w, h) => post.setSize(w, h));
engine.setRenderer((dt) => post.render(dt));

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
      loadStory: (raw: unknown) => Promise<string[]>;
      frame: () => FrameState | null;
      story: () => CompiledStory | null;
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
  loadStory,
  frame: () => lastFrame,
  story: () => story,
};

engine.start();
void loadStory(defaultScript).then((errors) => {
  if (errors.length) {
    panel.setStatus(`Erro no script padrão: ${errors[0]}`, 'error');
    return;
  }
  panel.showStartScreen(defaultScript.meta.title, () => {
    void audio.unlock();
    timeline.play();
  });
});

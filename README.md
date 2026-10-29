# Polytale

**A 3D storytelling engine with a PS1 / late-90s look.** You describe a scene as JSON (a
*StoryScript*) and the engine handles the rest: low-poly characters with a life of their own,
lip-synced dialogue with subtitles, camera direction, physical interactions between characters,
and a retro shader with pixelation, dithering and scanlines.

Built with **Vite + TypeScript + Three.js**. It needs no external assets: characters, scenery,
voices and sounds can all be procedural.

---

## Highlights

- **Declarative scripts**: a whole scene is a JSON document (`StoryScript`) of timed events.
- **Reversible timeline**: scene state is computed as a function of time, so you can drag the
  scrubber backwards and forwards freely.
- **Living characters**: breathing, random blinking, eye saccades, automatic walk cycles, facial
  expressions driven by *morph targets*, and gestures.
- **Body & interactions**: poses (sit, kneel, arms crossed...), hands reaching targets via IK,
  holding and handing over objects, and ready-made interactions (`handshake`, `hug`, `give`,
  `pickUp`, `push`...).
- **Character variety**: body builds, head shapes (egg, bulb, cone, can...), hair styles, outfits (robe, dress) and accessories (hats, glasses,
  beard, scarf, backpack, a cape that sways as they walk).
- **Chapters**: multi-scene stories with their own sets, fade transitions, title cards and a shared
  `cast`.
- **Sets**: outdoor scenes with an automatic day/night cycle (sky, sun/moon, stars) or interiors built
  from a `room` (walls you can see through from outside, doors, windows) plus furniture.
- **Lip-synced dialogue**: a 512-bin `AnalyserNode` (RMS energy drives `jawOpen`), a procedural
  90s-game "babble" voice, a `speechSynthesis` fallback, and RPG-style subtitles.
- **Camera direction**: presets (`wide`, `medium`, `close_up`, `over_shoulder`, `two_shot`,
  `low_angle`) that track actors and avoid occlusion, lerp/slerp transitions, and camera shake
  with exponential decay.
- **PS1 visuals**: a GLSL shader with downscaling, 4x4 Bayer dithering, 15-bit color, scanlines and
  CRT curvature, plus *vertex snapping* (the PlayStation vertex wobble).
- **Built-in editors**: a JSON editor (open/save files, copy a shareable link) and a visual
  track editor with draggable events and a per-event inspector.
- **Video export**: one click records the whole story to `.webm` with audio, subtitles and title cards.
- **AI script generation**: paste a story and Claude turns it into a validated StoryScript.
- **LLM-ready**: [`skills.md`](./skills.md) teaches an AI to turn free-form scripts into valid
  StoryScript (written in Portuguese).

---

## Getting started

Requires **Node.js 20.19+** (or 22.12+).

```bash
npm install
npm run dev        # dev server (http://localhost:5173)
npm run build      # typecheck + production build into dist/
npm run preview    # serve the build
npm run typecheck  # TypeScript only
npm test           # unit tests (Vitest); npm run test:watch for watch mode
```

Open the page and click **PRESS START**. The click is needed for the browser to allow audio.
The demo *A Chama Antiga* ("The Ancient Flame", 60 s, in Portuguese) starts playing.

### Controls

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Back / forward 1 s (`Shift`: 5 s) |
| `Home` | Back to start |
| `1`–`5` | Playback speed (0.25x – 2x) |
| `R` | Toggle Retro FX |
| `M` | Mute |
| `E` | Open the StoryScript editor (`Ctrl+Enter` applies, `Esc` closes) |
| `T` | Toggle the visual track editor |
| `G` | Generate a script with AI |
| `V` | Record a `.webm` video from start to end (press again to stop early) |
| `O` | Options: subtitle style editor with live preview (saved into the script) |
| `L` | Show / hide subtitles (also applies to recordings) |
| `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) | Undo / redo script changes (JSON editor, track editor, AI generation, subtitle options) |

Your last applied script is kept in the browser and restored on reload ("Restaurar demo" in the editor
brings the demo back). A shared link (`#story=...`) loads the script embedded in the URL.

In the browser console, `window.narrative` exposes the engine, timeline, registry, scene and audio
for debugging. Example: `narrative.timeline.seek(12)`.

---

## StoryScript in 30 seconds

```json
{
  "meta": { "title": "First Meeting", "duration": 9 },
  "timeline": [
    { "time": 0, "type": "SPAWN_OBJECT", "target": "ana",
      "object": { "kind": "actor", "name": "Ana", "voice": { "engine": "speech", "lang": "en-US" } },
      "position": [-2, 0, 0], "rotation": [0, 90, 0] },
    { "time": 0, "type": "SPAWN_OBJECT", "target": "leo",
      "object": { "kind": "actor", "name": "Leo", "voice": { "engine": "babble", "pitch": 130 } },
      "position": [2, 0, 0], "rotation": [0, -90, 0] },
    { "time": 0, "type": "CAMERA_CUT", "preset": "wide" },
    { "time": 0.5, "type": "INTERACT", "target": "ana", "interaction": "handshake", "with": "leo" },
    { "time": 3.5, "type": "CAMERA_CUT", "preset": "close_up", "subject": "ana" },
    { "time": 3.6, "type": "PLAY_AUDIO_WITH_LIPSYNC", "target": "ana", "text": "Nice to meet you, I'm Ana!" },
    { "time": 3.6, "type": "SET_EXPRESSION", "target": "ana", "expression": "happy" },
    { "time": 7.0, "type": "FADE_SCREEN", "to": 1, "duration": 2 }
  ]
}
```

Open the editor (`E`), paste the JSON and apply it.

Longer stories use `chapters` (each with its own `scene` and `timeline`) and a `cast` of reusable
characters — see section 3.7 of `skills.md`.

### Action catalog

| Group | Actions |
|---|---|
| Objects | `SPAWN_OBJECT`, `DESPAWN_OBJECT`, `TRANSFORM_OBJECT` |
| Dialogue & sound | `PLAY_AUDIO_WITH_LIPSYNC`, `PLAY_SOUND` |
| Camera | `CAMERA_CUT`, `CAMERA_TRANSITION`, `CAMERA_SHAKE` |
| Acting | `SET_LOOK_TARGET`, `SET_EXPRESSION`, `PLAY_GESTURE`, `PLAY_ANIMATION` |
| Body | `SET_POSE`, `REACH`, `ATTACH_OBJECT`, `DETACH_OBJECT`, `INTERACT` |
| Light & effects | `SET_LIGHT`, `SET_TIME_OF_DAY`, `SET_RETRO_FX`, `FADE_SCREEN`, `FLASH_SCREEN` |

Subtitles are styled in the **⚙ OPÇÕES** panel (`O`), which writes an optional top-level `subtitles` block (`style: "box" | "plain"`,
`position`, `showName`, `typewriter`, `size`, `color`, `background`, `border`, `font`, or
`enabled: false` to turn them off); a single line can opt out with `"subtitle": false`. The same
style is used on screen and in exported videos.

The full reference (fields, accepted values, directing rules, and a dialogue timing guide of
roughly 1 s per 12–15 characters) is in **[`skills.md`](./skills.md)**.

### Generating scripts with AI

Press `G` (or **✦ IA**), paste a story and click **Gerar**. The app calls Claude (`claude-opus-5-5`)
with [`skills.md`](./skills.md) as a cached system prompt, validates the JSON with the engine's
compiler and, if there are errors, sends them back to the model to fix (up to 3 attempts).

Two ways to provide the API key:

- **Recommended — server-side key:** create `.env.local` (see `.env.example`) with
  `ANTHROPIC_API_KEY=...` and run `npm run dev` or `npm run preview`. Vite proxies the requests and adds
  the key on the server; it never reaches the browser or the bundle.
- **Bring your own key:** on a static build without the proxy, the panel asks for a key and calls the
  API straight from the browser (optionally remembered in that browser only). Fine for personal use;
  don't ship a public site this way.

The panel also opts into server-side refusal fallbacks (`fallbacks: "default"`), so a declined request
is retried on Anthropic's recommended fallback model. You can also paste `skills.md` into any LLM chat
and use the JSON it returns.

### Recording video

Press `V` (or **● REC**): the story restarts, plays to the end and downloads a `.webm` (VP9/VP8 +
Opus) with subtitles and chapter title cards burned in. Voices using the `babble` engine, audio files
and procedural sounds are recorded; `speech` voices (`window.speechSynthesis`) are played by the
operating system and can't be captured.

---

## Architecture

```
Engine (loop, delta time)
  └─ Timeline.update(dt) ─► global time t
       └─ evaluateProject(t) ─► active chapter (scene rebuilt when it changes) + transitions/title card
            └─ ActionRegistry.evaluate(chapter, t − start) ─► FrameState (complete, pure scene state)
            ├─ SceneManager.applyFrame ─► actors, props, lights
            ├─ AudioLipsync.sync/update ─► audio sources aligned to t + FFT/RMS analysis
            ├─ SceneManager.update ─► Actor.update(dt): breathing, blinking, gaze, pose, IK, morphs
            ├─ CameraDirector.apply ─► shot / shot blend + shake
            ├─ PostProcessing ─► RenderPass → OutputPass (ACES) → retro shader
            ├─ Recorder ─► copies each rendered frame + subtitles into the video
            └─ DialogueBox / TitleCard / ControlPanel / TimelineView
```

- **Compilation:** `ActionRegistry.compile()` validates the script, expands macros (`INTERACT`,
  `REACH` with `hold`) and turns events into per-channel segments (`object:kael:position`,
  `actor:iara:pose`...). Each segment's start value is sampled from its channel at the event's time,
  so interruptions are smooth and seeking is deterministic.
- **Evaluation:** `evaluate(t)` is a pure function. That's what makes the timeline reversible.
- **Separation:** Timeline and ActionRegistry know nothing about Three.js, so all the logic can be
  tested in Node without a GPU.

### Project layout

```
src/
├── config/defaultScript.ts      # "A Chama Antiga" demo
├── core/
│   ├── Engine.ts                # renderer (shadows + ACES), loop, resize, delta time
│   ├── SceneManager.ts          # scenery, lights, props, actors, attachments, IK targets
│   ├── Actor.ts                 # character: morphs, procedural life, poses, two-bone IK
│   ├── CharacterStyle.ts        # body builds, hair, outfits, accessories
│   ├── Environment.ts           # day/night cycle, rooms, furniture
│   ├── ScriptStorage.ts         # open/save .json, shareable links, local draft
│   └── AssetLoader.ts           # cached GLTF, audio and texture loading
├── timeline/
│   ├── Timeline.ts              # master clock (play/pause/seek/rate/loop)
│   ├── ActionRegistry.ts        # validation, compilation, easings and evaluation
│   ├── poses.ts                 # pose presets and keyframed gestures
│   ├── interactions.ts          # INTERACT macros
│   ├── StoryProject.ts          # chapters: compilation, global clock, transitions
│   └── types.ts                 # StoryScript and FrameState types
├── systems/
│   ├── CameraDirector.ts        # presets, transitions, occlusion avoidance, shake
│   ├── AudioLipsync.ts          # Web Audio, AnalyserNode, procedural voice, speechSynthesis
│   ├── PostProcessing.ts        # EffectComposer + PS1 shader + vertex snapping
│   ├── Recorder.ts              # MediaRecorder video export with burned-in subtitles
│   └── ScriptGenerator.ts       # Claude API (SDK) script generation + validation loop
├── ui/
│   ├── ControlPanel.ts          # play/pause, scrubber with markers, Retro FX
│   ├── TimelineEditor.ts        # JSON editing modal (open/save/link)
│   ├── TimelineView.ts          # visual track editor
│   ├── GeneratorPanel.ts        # "generate with AI" modal
│   ├── TitleCard.ts             # chapter title cards
│   └── DialogueBox.ts           # typewriter-style subtitles
├── utils/math.ts                # noise, deterministic PRNG, helpers
└── main.ts                      # bootstrap and per-frame orchestration
public/
├── models/                      # .glb / .gltf
└── audio/                       # .mp3 / .wav
skills.md                        # LLM skill: free-form script → StoryScript (also the generator's prompt)
.env.example                     # ANTHROPIC_API_KEY for the dev/preview proxy
```

### Extending

To add an action, register a handler. It can write to channels (`tracks`), create time windows
(`interval`) or emit other events (`expand`):

```ts
registry.register('SET_LOOK_TARGET', { /* validate, tracks, interval, expand */ });
```

To type new actions, add the event to the `StoryEvent` union in `src/timeline/types.ts`.

---

## Custom assets

- **Models:** put files in `public/models/` and set `"model": "models/hero.glb"` on the actor.
  Morph targets with ARKit / Ready Player Me names (`jawOpen`, `eyeBlinkLeft`, `mouthSmile`...)
  are supported, as are Mixamo-style bones for poses and IK.
- **Audio:** put files in `public/audio/` and set `"audio": "audio/line01.mp3"` on a dialogue line.
  The file's real duration is used on the timeline.
- A missing asset doesn't break the story: the engine falls back to procedural content and shows a
  notice in the panel.

---

## Known limitations

- GLTF support is implemented but there's no test model in the repo yet. Poses and IK on external
  skeletons are approximate.
- Characters walk in straight lines (no obstacle avoidance) and bodies don't collide.
- The `speechSynthesis` voice depends on the voices installed on the system and doesn't go through
  the analyser (its lip sync is estimated from the text).
- Dropped objects "fall" by interpolation, not physics. That's intentional, to keep the timeline
  reversible.
- Video export records in real time and depends on the browser's `MediaRecorder` (Chrome/Edge/Firefox);
  `speech` voices aren't captured.
- Each chapter starts fresh: positions, poses and held objects don't carry over between chapters.

---

## License

TBD.

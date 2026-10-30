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
  beard, scarf, backpack, a cape that sways as they walk). A `palette.faceTexture` image can paint
  brows/stubble/detail onto a procedural face without a full GLTF model, and `headShape: "screen"`
  makes a robot whose glowing face reacts to expressions and speech.
- **Chapters**: multi-scene stories with their own sets, fade transitions, title cards and a shared
  `cast`.
- **Sets**: outdoor scenes with an automatic day/night cycle (sky, sun/moon, stars) or interiors built
  from a `room` (walls you can see through from outside, doors, windows) plus furniture, and
  deterministic `particles` props (steam, smoke, dust, sparks). `screen` props show images, video or
  a live feed from any camera shot, and spot lights can project `cookie` patterns (blinds, window,
  leaves). `scene.backdrop` and frameless screens add painted 2D layers.
- **Lip-synced dialogue**: a 512-bin `AnalyserNode` drives `jawOpen` from RMS energy and `mouthWide`/
  `mouthPucker` (visemes) from the spectral balance, a procedural 90s-game "babble" voice with its own
  text-driven visemes, a `speechSynthesis` fallback, and RPG-style subtitles.
- **Camera direction**: presets (`wide`, `medium`, `close_up`, `over_shoulder`, `two_shot`,
  `low_angle`) that track actors and avoid occlusion, lerp/slerp transitions, continuous
  dolly-in/pan `drift`, camera shake with exponential decay, and an opt-in `meta.autoCamera` pass that
  generates coverage (speaker/reaction/wide cuts on word boundaries, each with a slow drift, plus prop
  inserts via `cutaway`) from the dialogue — explicit camera events always win.
- **PS1 visuals**: a GLSL shader with downscaling, 4x4 Bayer dithering, 15-bit color, scanlines and
  CRT curvature, plus *vertex snapping* (the PlayStation vertex wobble) and a color grade (`fx.grade`:
  warm, cool, noir), depth of field (`fx.dof`) and bloom (`fx.bloom`) independent of the retro look.
- **Audio mixing**: a `music` sound bus that automatically ducks under dialogue, and an approximate
  automatic -14 LUFS loudness correction on export.
- **Built-in editors**: a JSON editor (open/save files, copy a shareable link) and a visual
  track editor with draggable events and a per-event inspector.
- **Video export**: one click records the whole story to `.mp4` (falling back to `.webm` if the browser
  can't encode MP4) with audio, subtitles, title cards and an optional watermark.
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
npm run schema     # regenerate schema/storyscript.schema.json after changing src/timeline/types.ts
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
| `V` | Download the story as a `.webm` video (`Esc` cancels) |
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

### Examples

[`examples/`](./examples) has ready-to-open scripts (editor → open file), each showing off different features:

| File | Shows |
|---|---|
| `encontro-no-parque.json` | `INTERACT` (high five, pick up, give, hug, sit) and speech-bubble subtitles |
| `o-mapa.json` | `chapters` + `cast`, sunset with `SET_TIME_OF_DAY`, an interior `room` with furniture |
| `the-last-original-part.json` | A 3:40 single-scene 9:16 dialogue using nearly everything: `autoCamera` with `cutaway`, a live CCTV `screen`, `dots`/`crt` effects, `backdrop`, blinds `cookie`, `dof`/`bloom`/`grade`, particles, a screen-faced robot, `faceTexture`/`outfitTexture`, chunk captions and a watermark |
| `tempestade.json` | Lightning (`SET_LIGHT` + flash + shake + thunder), `SET_RETRO_FX`, a custom gesture, `babble` voice |
| `ultimo-cafe.json` | Vertical 9:16 video (`meta.aspect`) for Reels/TikTok: close-ups, `pickUp` + `give`, an interior `room` |

Every file in `examples/` is compiled and checked for reversible seeking by the test suite, so new examples double as tests.

### JSON Schema

[`schema/storyscript.schema.json`](./schema/storyscript.schema.json) is generated from `src/timeline/types.ts`
(`npm run schema`; a test fails if it is stale). Add `"$schema": "../schema/storyscript.schema.json"` (path relative to
your file) to a script to get autocomplete and inline errors in VS Code and other editors. The engine ignores the key.

### Action catalog

| Group | Actions |
|---|---|
| Objects | `SPAWN_OBJECT`, `DESPAWN_OBJECT`, `TRANSFORM_OBJECT` |
| Dialogue & sound | `PLAY_AUDIO_WITH_LIPSYNC`, `PLAY_SOUND` (`bus: "sfx" \| "music"`) |
| Camera | `CAMERA_CUT`, `CAMERA_TRANSITION`, `CAMERA_SHAKE` |
| Acting | `SET_LOOK_TARGET`, `SET_EXPRESSION`, `PLAY_GESTURE`, `PLAY_ANIMATION` |
| Body | `SET_POSE`, `REACH`, `ATTACH_OBJECT`, `DETACH_OBJECT`, `INTERACT` |
| Light & effects | `SET_LIGHT`, `SET_TIME_OF_DAY`, `SET_RETRO_FX`, `FADE_SCREEN`, `FLASH_SCREEN`, `SHOW_TITLE` |

Subtitles are styled in the **⚙ OPÇÕES** panel (`O`), which writes an optional top-level `subtitles` block (`style: "box" | "plain" | "outline"`,
`position: "bottom" | "top" | "center" | "speaker"` (speech bubble that follows the speaker's head), `margin`, `showName`,
`mode: "typewriter" | "words" | "chunk"` (letter-by-letter, TikTok-style word groups, or whole phrase chunks — with `maxWords`
per group), `typewriter`, `size`, `color`, `background`, `border`, `font`, or `enabled: false` to turn them off); a single line
can opt out with `"subtitle": false`. The same style is used on screen and in exported videos. A `subtitle: { font, color, size }`
block on an actor in `cast` overrides the global style for that character's lines only (the name tag keeps using `color`).

A `meta.watermark` block (`text` and/or `image`, `position`, `opacity`, `size`, `color`) draws a fixed mark over the scene,
also on screen and in exported videos.

`SHOW_TITLE` (`title`, `subtitle?`, `duration?`, `overlay?`) shows a title card at any point in the timeline, not just at a
chapter's start — the scene keeps playing underneath. `overlay: true` drops the dark band for text-with-shadow over the
running scene (good for an outro/credits card); the default banded look matches the automatic chapter-start cards.

`meta.autoCamera` (or per-chapter) turns on generated coverage: a `CAMERA_CUT` per `PLAY_AUDIO_WITH_LIPSYNC` line — close-up
on the speaker, an occasional reaction shot on the nearest other actor, over-the-shoulder, and a wide re-establishing shot
every `wideEvery` lines (`maxShotSeconds` splits a long line with a mid-line reaction cut). Any `CAMERA_CUT`/`CAMERA_TRANSITION`
you place by hand always wins over a generated one near the same time.

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

### Downloading a video

Press `V` (or **⬇ VÍDEO**): the story plays once from start to end in real time (at 1x, without looping)
while a progress card shows how far along it is, then a `.mp4` (H.264 + AAC, the format Instagram,
TikTok and WhatsApp accept directly — falling back to `.webm`/VP9+Opus if the browser can't encode MP4)
with subtitles, chapter title cards and an optional watermark burned in downloads automatically.
`Esc` or **CANCELAR** stops without saving.
Keep the tab visible while it runs: browsers pause hidden tabs.

Audio files, procedural sounds and `babble` voices are recorded as-is. `speech` voices
(`window.speechSynthesis`) are played by the operating system and can't be captured, so while the video
is generated they are swapped for a `babble` voice stretched to the same line length.

A `PLAY_SOUND` with `bus: "music"` ducks automatically (-8 dB) while any dialogue is speaking, and
comes back up once it's quiet — no manual mixing needed for a constant music/ambience bed.

Exports target -14 LUFS, the level most platforms normalize to. The first pass measures the mix (BS.1770
style K-weighting with gating); if it's more than 1 LU off, the story plays a second time with makeup
gain and a limiter, so an export can take up to twice the story's length. The status message after a
download shows the final reading (e.g. `≈-14.2 LUFS`). The correction only touches the file, not your
speakers.

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
│   ├── Actor.ts                 # character: procedural life, poses, gaze, lipsync
│   ├── ActorRig.ts              # procedural and GLTF rigs (bones, sockets, meshes)
│   ├── ActorFace.ts             # morph targets, expression presets, face geometry
│   ├── IK.ts                    # two-bone IK
│   ├── ScriptHistory.ts         # undo/redo of applied scripts
│   ├── CharacterStyle.ts        # body builds, hair, outfits, accessories
│   ├── Environment.ts           # day/night cycle, rooms, furniture
│   ├── ScriptStorage.ts         # open/save .json, shareable links, local draft
│   └── AssetLoader.ts           # cached GLTF, audio and texture loading
├── timeline/
│   ├── Timeline.ts              # master clock (play/pause/seek/rate/loop)
│   ├── ActionRegistry.ts        # validation, compilation and evaluation
│   ├── handlers.ts              # one handler per action type (validate / tracks / interval / expand)
│   ├── compileTypes.ts          # handler contracts, CompiledStory, StoryScriptError
│   ├── easing.ts                # easings and interpolators
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
│   ├── ExportOverlay.ts         # "generating video" progress card
│   └── DialogueBox.ts           # typewriter-style subtitles
├── utils/math.ts                # noise, deterministic PRNG, helpers
└── main.ts                      # bootstrap and per-frame orchestration
public/
├── models/                      # .glb / .gltf
└── audio/                       # .mp3 / .wav
examples/                        # sample scripts (also test fixtures)
schema/storyscript.schema.json   # generated JSON Schema for StoryScript
scripts/schema.ts                # schema generator (npm run schema)
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

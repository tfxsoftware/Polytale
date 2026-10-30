# Improvements

Gaps found by comparing Polytale's output with a reference video (vertical 9:16, 3 min, a 3D
character talking to pixel-art "gremlins"). Only items that fit the current architecture are listed,
roughly in order of impact vs. effort.

**Status:** every item is in, but these parts are still open:

- 8: `outfitTexture` isn't implemented (`faceTexture` is).
- 6: `screen` video plays on its own clock, so it doesn't follow seeking or sync in exports (images
  and `camera` feeds do). Screen effects are texture overlays, not shaders.

## 1. Word-group captions

The reference reveals whole words (`Are` → `Are you` → `Are you guys`) in groups of 1–4 words, then
clears and starts the next group (TikTok/Reels style). White text, dark outline, no box.

- Add a subtitle mode alongside the per-character typewriter, e.g.
  `subtitles: { mode: "words", maxWords: 3 }`.
- Word timing: spread the line's `speakDuration` across its words, weighted by word length (same
  estimate `estimateSpeechDuration` already uses). Must stay a pure function of time so seeking still works.
- Outline/stroke style (`style: "outline"`) as a third option next to `box` and `plain`.
- Files: `src/ui/SubtitleRenderer.ts` (`revealedChars` → a word-group equivalent),
  `src/timeline/types.ts`, `src/ui/SettingsPanel.ts`, schema.

## 2. Per-actor subtitle style

Each speaker has their own font (human: italic pixel font; gremlin: serif).

- Optional `subtitle: { font, color, size }` on `ActorObjectDef`, overriding the global `subtitles` block.

## 3. Auto-coverage (generated cuts)

The reference cuts every 2–4 s, on word boundaries, between speaker close-up, listener reaction and
cutaways. Polytale can do this today, but only with hand-placed `CAMERA_CUT` events.

- A compile-time pass (opt-in, e.g. `meta.autoCamera: true` or per chapter) that walks the
  `PLAY_AUDIO_WITH_LIPSYNC` events and emits `CAMERA_CUT`s: speaker `close_up` / `over_shoulder`,
  occasional listener reaction shot, `wide` re-establishing shot every N cuts.
- Explicit camera events in the script always win over generated ones.
- Max shot length (~4 s) splits long lines with a reaction shot mid-sentence.

## 4. Camera drift / push-in

Almost no shot in the reference is static: slow push-ins, slight drifts, and occasional long
pull-back reveals.

- `drift` on `CameraShotSpec`: `{ push?: number, pan?: number, duration? }`, i.e. a slow offset
  applied over the life of the shot. Also used by auto-coverage (3) with small random values per cut.
- Files: `src/systems/CameraDirector.ts`, `src/timeline/types.ts`.

## 5. Projected light patterns (cookies / gobos)

The blinds' striped shadow across faces, bodies and floor is the reference's signature look.

- `cookie?: "blinds" | "window" | "leaves" | string` on spot lights → procedural `CanvasTexture`
  assigned to `SpotLight.map` (supported by Three.js r180).
- Files: `src/core/Environment.ts` / `SceneManager.ts` (light creation), `types.ts`.

## 6. Screens: images, video and live camera feeds

Monitors show other scenes, a wall of TVs shows faces, a giant face sits on a dot-matrix billboard.

- `screen` prop kind (or `screen` field on props) with `src`: image URL, video URL, or
  `{ camera: <shotId> }` rendered to a `WebGLRenderTarget` (render-to-texture, low resolution to keep
  it cheap and on-style).
- Optional screen effect: `"lcd" | "dots" | "crt"` (simple shader on the screen material).
- 2D backdrop layers: an image plane parented to the camera or placed in the scene, for painted or
  pixel-art backgrounds.

## 7. Visemes in lip-sync

Lip-sync only drives `jawOpen` from RMS energy. The face already has `mouthWide`, `mouthPucker`,
`mouthSmile` morphs (`src/core/ActorFace.ts`).

- Cheap version: spectral centroid / band energies from the existing `AnalyserNode` → mix
  `mouthWide` (bright, "ee") vs `mouthPucker` (dark, "oo").
- Text-driven version for babble/speech voices: map the subtitle text's vowels to shapes over the
  line's duration (deterministic, works when seeking).

## 8. Image textures on procedural actors

The reference uses painted faces (brows, stubble, teeth). Allow `palette.faceTexture` (and maybe
`outfitTexture`) on procedural actors so a drawn face can be applied without a full GLTF model.

## 9. Watermark overlay

`meta.watermark: { text, image?, position, opacity }` drawn by the same overlay path as subtitles,
so it appears on screen and in exported videos.

## 10. Title over a running scene

The reference ends with a title over the scene while it keeps playing, then fades to a logo card.
Check `TitleCard` and add an `overlay: true` mode if it only works as a full-screen card.

## 11. Audio: music ducking and loudness

The reference sits at -14 LUFS integrated with a 3.5 LU loudness range, and never falls silent
(constant music/ambience bed).

- `PLAY_SOUND` gets `bus: "music"`; the music bus ducks automatically (e.g. -8 dB) while any dialogue
  is active.
- Export: target -14 LUFS (measure during recording, apply makeup gain, or offer a normalized
  re-render).

## 12. MP4 export

Prefer `video/mp4;codecs=avc1` in `Recorder` `MIME_CANDIDATES` when the browser supports it (recent
Chrome does), falling back to WebM. Reels/TikTok take MP4 directly.

---

Items 13–18 come from a second reference by the same creator (diner scene, same 9:16 format, no
pixelation: warm, glossy, shallow-focus look).

## 13. Phrase-chunk captions (extends 1)

This reference shows 2-line chunks of ~6–8 words that swap in whole (no per-word reveal), in a bold
cream serif with a dark outline and drop shadow, the same font for every speaker.

- Same mechanism as 1 with `reveal: "word" | "chunk"` and a larger `maxWords`.
- Drop shadow as part of the outline style.

## 14. Insert shots / B-roll cutaways (extends 3)

Mid-line cuts to objects the dialogue mentions: "same dish" → burger close-up, "same fire" → the
grill, "an actual person back there" → the empty kitchen hatch, "nature" → exterior, "made humans"
→ a framed photo. The video also opens on an exterior establishing shot.

- `INSERT_SHOT` (or `CAMERA_CUT` with `subject` set to a prop id) plus a `close_up` preset that
  works on props, not only actors.
- Auto-coverage (3) can use them if lines carry an optional `cutaway: "<propId>"` hint.
- The AI script generator (`src/systems/ScriptGenerator.ts`) is well placed to add those hints,
  since it reads the dialogue.

## 15. Depth of field and bloom

Close-ups have a blurred background, and windows, the sunset and highlights glow.

- Add a bokeh/DOF pass (focus on the shot's `subject`, automatic per preset) and a bloom pass to
  `src/systems/PostProcessing.ts`, independent of the retro FX so a scene can use either look.
- `fx.dof: { aperture, focus? }`, `fx.bloom: { strength, threshold }`.

## 16. Particles: steam and smoke

Steam rises from the burger and the grill.

- Small `particles` prop kind with presets (`steam`, `smoke`, `dust`, `sparks`), deterministic per
  seed and time so seeking stays reversible.

## 17. Screen faces

Both robots have a screen for a face (glowing eyes, `^ ^` happy eyes, visor). Expressions swap the
face image.

- Procedural `headShape: "screen"` (or a `faceStyle: "screen"`) whose `SET_EXPRESSION` and lip-sync
  draw onto an emissive `CanvasTexture` instead of driving morphs. Reuses the screen texture
  work from 6.

## 18. Color grade presets

A warm sunset grade with lifted shadows. ACES tone mapping is already on (`src/core/Engine.ts:49`).

- `fx.grade: "warm" | "cool" | "noir" | ...` as a small color-matrix/curve pass, or a 3D LUT.

## Not planned (for now)

- Per-object retro style (pixel art vs. smooth 3D vs. halftone in the same frame): would need
  per-layer rendering and compositing. Large change. Revisit after 6.

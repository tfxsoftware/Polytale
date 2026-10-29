import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { ColorGrade, FxFrame, RetroSettings } from '../timeline/types';
import { DEFAULT_RETRO_SETTINGS } from '../timeline/types';

/* ========================================================================== */
/*  Correção de cor (fx.grade)                                               */
/* ========================================================================== */

interface GradeSpec {
  tint: [number, number, number];
  lift: [number, number, number];
  saturation: number;
}

/** Pequenos presets de tint/lift/saturação, independentes do retro FX. */
const GRADE_PRESETS: Record<ColorGrade, GradeSpec> = {
  none: { tint: [1, 1, 1], lift: [0, 0, 0], saturation: 1 },
  // Pôr do sol: quente, sombras levemente levantadas, leve ganho de saturação.
  warm: { tint: [1.08, 1.0, 0.9], lift: [0.02, 0.012, 0], saturation: 1.08 },
  cool: { tint: [0.95, 1.0, 1.08], lift: [0, 0.006, 0.016], saturation: 1.0 },
  // Quase dessaturado, com uma leve tonalidade fria (clássico noir).
  noir: { tint: [0.97, 0.97, 1.0], lift: [0, 0, 0.01], saturation: 0.05 },
};

/* ========================================================================== */
/*  Vertex snapping (jitter de vértices do PS1)                               */
/* ========================================================================== */

/** Uniforms compartilhados por todos os materiais "PS1". */
const snapUniforms = {
  uSnapResolution: { value: new THREE.Vector2(320, 240) },
  uSnapAmount: { value: 1 },
};

/**
 * Injeta "vertex snapping" no vertex shader de um material: a posição em
 * clip-space é quantizada para uma grade de baixa resolução, imitando a
 * GTE do PlayStation (sem subpixel precision) — os vértices "tremem".
 */
export function applyPS1VertexSnap(material: THREE.Material): void {
  if (material.userData.ps1Snap) return;
  material.userData.ps1Snap = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uSnapResolution = snapUniforms.uSnapResolution;
    shader.uniforms.uSnapAmount = snapUniforms.uSnapAmount;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uSnapResolution;\nuniform float uSnapAmount;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        if (uSnapAmount > 0.0) {
          vec4 snapped = gl_Position;
          snapped.xyz /= snapped.w;
          vec2 grid = uSnapResolution * 0.5;
          snapped.xy = floor(snapped.xy * grid + 0.5) / grid;
          snapped.xyz *= snapped.w;
          gl_Position = mix(gl_Position, snapped, uSnapAmount);
        }`,
      );
  };
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|ps1snap`;
  material.needsUpdate = true;
}

/* ========================================================================== */
/*  Shader retrô                                                              */
/* ========================================================================== */

const RetroShader = {
  name: 'RetroPS1Shader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uEnabled: { value: 1 },
    uPixelSize: { value: DEFAULT_RETRO_SETTINGS.pixelSize },
    uColorLevels: { value: DEFAULT_RETRO_SETTINGS.colorLevels },
    uDither: { value: DEFAULT_RETRO_SETTINGS.dither },
    uScanlines: { value: DEFAULT_RETRO_SETTINGS.scanlines },
    uCurvature: { value: DEFAULT_RETRO_SETTINGS.curvature },
    uVignette: { value: DEFAULT_RETRO_SETTINGS.vignette },
    uChromatic: { value: DEFAULT_RETRO_SETTINGS.chromatic },
    uNoise: { value: DEFAULT_RETRO_SETTINGS.noise },
    uGradeTint: { value: new THREE.Vector3(1, 1, 1) },
    uGradeLift: { value: new THREE.Vector3(0, 0, 0) },
    uGradeSat: { value: 1 },
    uFade: { value: 0 },
    uFadeColor: { value: new THREE.Color(0, 0, 0) },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uEnabled;
    uniform float uPixelSize;
    uniform float uColorLevels;
    uniform float uDither;
    uniform float uScanlines;
    uniform float uCurvature;
    uniform float uVignette;
    uniform float uChromatic;
    uniform float uNoise;
    uniform vec3 uGradeTint;
    uniform vec3 uGradeLift;
    uniform float uGradeSat;
    uniform float uFade;
    uniform vec3 uFadeColor;
    uniform float uFlash;
    uniform vec3 uFlashColor;

    varying vec2 vUv;

    // Correção de cor independente do retro FX: satura/dessatura, aplica tingimento e levanta as sombras.
    vec3 grade(vec3 c) {
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, uGradeSat);
      return c * uGradeTint + uGradeLift;
    }

    // Matriz de Bayer 4x4 (valores normalizados em [0, 1)).
    float bayer4x4(vec2 p) {
      int x = int(mod(p.x, 4.0));
      int y = int(mod(p.y, 4.0));
      int i = x + y * 4;
      float m[16] = float[16](
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
      );
      return m[i] / 16.0;
    }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    // Distorção de barril (tubo CRT).
    vec2 curve(vec2 uv, float k) {
      vec2 c = uv * 2.0 - 1.0;
      c *= 1.0 + k * dot(c, c) * 0.25;
      return c * 0.5 + 0.5;
    }

    void main() {
      vec2 uv = vUv;

      if (uEnabled < 0.5) {
        vec3 col = texture2D(tDiffuse, uv).rgb;
        col = grade(col);
        col = mix(col, uFadeColor, uFade);
        col += uFlashColor * uFlash;
        gl_FragColor = vec4(col, 1.0);
        return;
      }

      uv = curve(uv, uCurvature);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      // 1) Downscaling / pixelation: amostra no centro do "pixel virtual".
      vec2 virtualRes = max(vec2(1.0), floor(uResolution / max(1.0, uPixelSize)));
      vec2 cell = floor(uv * virtualRes);
      vec2 suv = (cell + 0.5) / virtualRes;

      // Aberração cromática leve (radial).
      vec2 dir = suv - 0.5;
      float r = texture2D(tDiffuse, suv + dir * uChromatic * 8.0).r;
      float g = texture2D(tDiffuse, suv).g;
      float b = texture2D(tDiffuse, suv - dir * uChromatic * 8.0).b;
      vec3 col = vec3(r, g, b);
      col = grade(col);

      // Fade/flash antes da quantização => transições também ficam "dithered".
      col = mix(col, uFadeColor, uFade);
      col += uFlashColor * uFlash;

      // Ruído de sinal analógico.
      col += (hash(cell + fract(uTime) * 91.0) - 0.5) * uNoise;

      // 2) Dithering Bayer 4x4 + 3) Quantização de cor (32 níveis = 15-bit do PS1).
      float levels = max(2.0, uColorLevels) - 1.0;
      float threshold = mix(0.5, bayer4x4(cell), clamp(uDither, 0.0, 1.0));
      col = floor(clamp(col, 0.0, 1.0) * levels + threshold) / levels;

      // 4) Scanlines CRT (por linha de tela real) + máscara de abertura sutil.
      float line = 0.5 + 0.5 * cos(gl_FragCoord.y * 3.14159265);
      col *= 1.0 - uScanlines * line * 0.6;
      float mask = mod(gl_FragCoord.x, 3.0);
      col *= 1.0 - uScanlines * 0.12 * step(2.0, mask);

      // Vinheta.
      vec2 v = uv * (1.0 - uv.yx);
      float vig = pow(clamp(v.x * v.y * 16.0, 0.0, 1.0), uVignette * 0.5);
      col *= mix(1.0, vig, step(0.001, uVignette));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* ========================================================================== */
/*  PostProcessing                                                            */
/* ========================================================================== */

/**
 * Pipeline: RenderPass -> BokehPass (dof) -> UnrealBloomPass -> OutputPass (tone mapping ACES + sRGB)
 * -> RetroPass. DOF e bloom ficam antes do tone mapping (cor linear) e são independentes do retro FX;
 * o shader retrô roda por último, sobre cores já em sRGB, para que a quantização 15-bit e o dithering
 * correspondam ao que aparece na tela.
 */
export class PostProcessing {
  readonly composer: EffectComposer;
  private readonly retroPass: ShaderPass;
  private readonly bokehPass: BokehPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly size = new THREE.Vector2();
  /** Interruptor do usuário (botão Retro FX); combina com o estado da timeline. */
  private _userEnabled = true;
  private timelineEnabled = true;
  private settings: RetroSettings = { ...DEFAULT_RETRO_SETTINGS };
  /** Multiplica o pixelSize: mantém o tamanho dos "pixels" PS1 quando a resolução muda (exportação). */
  private pixelScale = 1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    // DOF e bloom operam na cor linear, antes do tone mapping (OutputPass) — independentes do retro FX,
    // que roda por último, já em sRGB.
    this.bokehPass = new BokehPass(scene, camera, { focus: 3, aperture: 0.025, maxblur: 0.01 });
    this.bokehPass.enabled = false;
    this.composer.addPass(this.bokehPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.4, 0.85);
    this.bloomPass.enabled = false;
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.retroPass = new ShaderPass(RetroShader);
    this.composer.addPass(this.retroPass);
    this.syncSize();
  }

  get userEnabled(): boolean {
    return this._userEnabled;
  }

  get active(): boolean {
    return this._userEnabled && this.timelineEnabled;
  }

  setUserEnabled(enabled: boolean): void {
    this._userEnabled = enabled;
    this.updateUniforms();
  }

  toggleUser(): boolean {
    this.setUserEnabled(!this._userEnabled);
    return this._userEnabled;
  }

  setSize(width: number, height: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
    this.syncSize();
  }

  setPixelScale(scale: number): void {
    this.pixelScale = Math.max(0.1, scale);
    this.updateUniforms();
  }

  /** Aplica o estado de efeitos da timeline (retro, parâmetros, grade, dof, bloom, fade, flash). */
  applyFrame(fx: FxFrame, elapsed: number, focusDistance: number): void {
    this.timelineEnabled = fx.retro;
    this.settings = fx.settings;
    const u = this.retroPass.uniforms;
    u.uTime.value = elapsed;
    const grade = GRADE_PRESETS[fx.grade] ?? GRADE_PRESETS.none;
    (u.uGradeTint.value as THREE.Vector3).set(...grade.tint);
    (u.uGradeLift.value as THREE.Vector3).set(...grade.lift);
    u.uGradeSat.value = grade.saturation;
    u.uFade.value = fx.fade;
    (u.uFadeColor.value as THREE.Color).setRGB(fx.fadeColor[0], fx.fadeColor[1], fx.fadeColor[2]);
    u.uFlash.value = fx.flash;
    (u.uFlashColor.value as THREE.Color).setRGB(fx.flashColor[0], fx.flashColor[1], fx.flashColor[2]);

    this.bokehPass.enabled = !!fx.dof;
    if (fx.dof) {
      // @types/three tipa `uniforms` como `object` (lacuna da lib); os nomes vêm do BokehShader.
      const bokeh = this.bokehPass.uniforms as Record<'focus' | 'aperture' | 'aspect', { value: number }>;
      bokeh.focus.value = fx.dof.focus ?? focusDistance;
      bokeh.aperture.value = fx.dof.aperture;
      bokeh.aspect.value = this.camera.aspect;
    }
    this.bloomPass.enabled = !!fx.bloom;
    if (fx.bloom) {
      this.bloomPass.strength = fx.bloom.strength;
      this.bloomPass.radius = fx.bloom.radius;
      this.bloomPass.threshold = fx.bloom.threshold;
    }

    this.updateUniforms();
  }

  render(deltaTime: number): void {
    this.composer.render(deltaTime);
  }

  dispose(): void {
    this.composer.dispose();
  }

  private syncSize(): void {
    this.renderer.getDrawingBufferSize(this.size);
    (this.retroPass.uniforms.uResolution.value as THREE.Vector2).copy(this.size);
    this.updateUniforms();
  }

  private updateUniforms(): void {
    const u = this.retroPass.uniforms;
    const s = this.settings;
    const on = this.active;
    u.uEnabled.value = on ? 1 : 0;
    const px = Math.max(1, s.pixelSize * this.pixelScale);
    u.uPixelSize.value = px;
    u.uColorLevels.value = s.colorLevels;
    u.uDither.value = s.dither;
    u.uScanlines.value = s.scanlines;
    u.uCurvature.value = s.curvature;
    u.uVignette.value = s.vignette;
    u.uChromatic.value = s.chromatic;
    u.uNoise.value = s.noise;
    // Grade de snapping proporcional à resolução virtual.
    snapUniforms.uSnapResolution.value.set(Math.max(64, this.size.x / px), Math.max(48, this.size.y / px));
    snapUniforms.uSnapAmount.value = on ? s.vertexSnap : 0;
  }
}

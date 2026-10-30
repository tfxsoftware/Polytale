import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { ColorGrade, FxFrame, RetroSettings, VisualStyle } from '../timeline/types';
import { DEFAULT_RETRO_SETTINGS } from '../timeline/types';
import { hexToRgb } from '../utils/math';

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
/*  Estilos visuais                                                           */
/* ========================================================================== */

const STYLE_IDS: Record<VisualStyle, number> = { ps1: 0, pixel: 1, halftone: 2, toon: 3 };

/** Tamanho da célula de cada estilo: fração do lado menor da imagem, igual na tela e na exportação. */
const STYLE_CELLS: Record<VisualStyle, number> = { ps1: 1, pixel: 1 / 200, halftone: 1 / 120, toon: 1 / 720 };

/** Paleta Sweetie 16 (cores em sRGB, como a imagem nesse ponto do pipeline). */
const PIXEL_PALETTE = [
  '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
  '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
].map((hex) => new THREE.Vector3(...hexToRgb(hex)));

/* ========================================================================== */
/*  Materiais: vertex snapping (PS1) e faixas de sombra (toon)                */
/* ========================================================================== */

/** Uniforms compartilhados por todos os materiais da cena. */
const materialUniforms = {
  uSnapResolution: { value: new THREE.Vector2(320, 240) },
  uSnapAmount: { value: 1 },
  uToon: { value: 0 },
};

/**
 * Injeta os efeitos de estilo no shader de um material. Vertex snapping: a posição
 * em clip-space é quantizada para uma grade de baixa resolução, imitando a GTE do
 * PlayStation (sem subpixel precision) — os vértices "tremem". Toon: em materiais
 * iluminados, a intensidade da luz é reduzida a poucas faixas.
 */
export function applyStyleShader(material: THREE.Material): void {
  if (material.userData.styleShader) return;
  material.userData.styleShader = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uSnapResolution = materialUniforms.uSnapResolution;
    shader.uniforms.uSnapAmount = materialUniforms.uSnapAmount;
    shader.uniforms.uToon = materialUniforms.uToon;
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
    if (!shader.fragmentShader.includes('#include <lights_fragment_end>')) return;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uToon;')
      .replace(
        '#include <opaque_fragment>',
        `if (uToon > 0.5) {
          vec3 lumaWeights = vec3(0.2126, 0.7152, 0.0722);
          float light = dot(outgoingLight, lumaWeights) / max(dot(diffuseColor.rgb, lumaWeights), 0.001);
          float band = max(floor(light * 3.0 + 0.5) / 3.0, 1.0 / 3.0);
          outgoingLight *= band / max(light, 0.001);
        }
        #include <opaque_fragment>`,
      );
  };
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|stylefx`;
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
    uStyle: { value: 0 },
    uStyleCell: { value: 1 },
    uPalette: { value: PIXEL_PALETTE },
    tDepth: { value: null as THREE.Texture | null },
    uNear: { value: 0.1 },
    uFar: { value: 100 },
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
    uniform float uStyle;
    uniform float uStyleCell;
    uniform vec3 uPalette[16];
    uniform sampler2D tDepth;
    uniform float uNear;
    uniform float uFar;
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

    // Paletas e tintas têm poucos tons escuros: sem levantar as sombras, uma cena noturna vira uma cor só.
    vec3 liftShadows(vec3 c) {
      return pow(clamp(c, 0.0, 1.0), vec3(0.55));
    }

    // Cor da cena com grade, fade e flash, sem estilização.
    vec3 shade(vec2 uv) {
      vec3 col = grade(texture2D(tDiffuse, uv).rgb);
      col = mix(col, uFadeColor, uFade);
      return col + uFlashColor * uFlash;
    }

    // 1/z varia linearmente em um plano, então a segunda derivada só acende em quinas e silhuetas
    // (um chão em ângulo rasante não vira contorno).
    float inverseDepth(vec2 uv) {
      float depth = texture2D(tDepth, uv).x;
      return (uFar - depth * (uFar - uNear)) / (uNear * uFar);
    }

    float outline(vec2 uv, vec2 offset) {
      float center = inverseDepth(uv);
      vec2 dx = vec2(offset.x, 0.0);
      vec2 dy = vec2(0.0, offset.y);
      float h = abs(inverseDepth(uv + dx) + inverseDepth(uv - dx) - 2.0 * center);
      float v = abs(inverseDepth(uv + dy) + inverseDepth(uv - dy) - 2.0 * center);
      return smoothstep(0.02, 0.06, max(h, v) / max(center, 1e-5));
    }

    vec3 pixelArt(vec2 uv) {
      vec2 virtualRes = max(vec2(1.0), floor(uResolution / uStyleCell));
      vec2 cell = floor(uv * virtualRes);
      vec2 suv = (cell + 0.5) / virtualRes;
      vec3 col = liftShadows(shade(suv)) * (1.0 - 0.75 * outline(suv, 1.0 / virtualRes));
      col += (bayer4x4(cell) - 0.5) * 0.16;
      vec3 best = uPalette[0];
      float bestDist = 1e9;
      for (int i = 0; i < 16; i++) {
        vec3 d = col - uPalette[i];
        float dist = dot(d, d);
        if (dist < bestDist) {
          bestDist = dist;
          best = uPalette[i];
        }
      }
      return best;
    }

    // Cobertura de uma tinta: cada ponto da retícula amostra a cor no próprio centro.
    float screenDot(vec2 uv, float angle, int ink) {
      float c = cos(angle);
      float s = sin(angle);
      mat2 rotate = mat2(c, -s, s, c);
      vec2 grid = rotate * (uv * uResolution) / uStyleCell;
      vec2 center = (floor(grid) + 0.5) * uStyleCell;
      vec3 rgb = liftShadows(shade((center * rotate) / uResolution));
      float k = 1.0 - max(rgb.r, max(rgb.g, rgb.b));
      float amount = ink == 3 ? k : (1.0 - rgb[ink] - k) / max(1.0 - k, 0.001);
      if (amount < 0.02) return 0.0;
      float radius = sqrt(amount) * 0.72;
      float aa = 1.0 / uStyleCell;
      return 1.0 - smoothstep(radius - aa, radius + aa, length(fract(grid) - 0.5));
    }

    vec3 halftone(vec2 uv) {
      vec3 col = vec3(0.97, 0.95, 0.9);
      col *= mix(vec3(1.0), vec3(0.0, 0.68, 0.94), screenDot(uv, 0.2618, 0));
      col *= mix(vec3(1.0), vec3(0.93, 0.0, 0.55), screenDot(uv, 1.309, 1));
      col *= mix(vec3(1.0), vec3(1.0, 0.95, 0.0), screenDot(uv, 0.0, 2));
      col *= mix(vec3(1.0), vec3(0.1), screenDot(uv, 0.7854, 3));
      return col * (1.0 - outline(uv, 1.5 / uResolution));
    }

    vec3 toon(vec2 uv) {
      return shade(uv) * (1.0 - outline(uv, uStyleCell / uResolution));
    }

    void main() {
      vec2 uv = vUv;

      if (uEnabled < 0.5) {
        gl_FragColor = vec4(shade(uv), 1.0);
        return;
      }
      if (uStyle > 0.5) {
        vec3 styled = uStyle < 1.5 ? pixelArt(uv) : uStyle < 2.5 ? halftone(uv) : toon(uv);
        gl_FragColor = vec4(styled, 1.0);
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
 * correspondam ao que aparece na tela. Os estilos com contorno leem a profundidade de um render
 * extra da cena, feito só enquanto um deles está ativo.
 */
export class PostProcessing {
  readonly composer: EffectComposer;
  private readonly retroPass: ShaderPass;
  private readonly bokehPass: BokehPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly size = new THREE.Vector2();
  private readonly depthTarget: THREE.WebGLRenderTarget;
  private style: VisualStyle = 'ps1';
  /** Interruptor do usuário (botão Retro FX); combina com o estado da timeline. */
  private _userEnabled = true;
  private timelineEnabled = true;
  private settings: RetroSettings = { ...DEFAULT_RETRO_SETTINGS };
  /** Multiplica o pixelSize: mantém o tamanho dos "pixels" PS1 quando a resolução muda (exportação). */
  private pixelScale = 1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
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
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
    this.retroPass.uniforms.tDepth.value = this.depthTarget.depthTexture;
    this.syncSize();
  }

  get userEnabled(): boolean {
    return this._userEnabled;
  }

  get active(): boolean {
    return this._userEnabled && (this.style !== 'ps1' || this.timelineEnabled);
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
    this.style = fx.style;
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
    if (this.active && this.style !== 'ps1') {
      this.renderer.setRenderTarget(this.depthTarget);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
    }
    this.composer.render(deltaTime);
  }

  dispose(): void {
    this.composer.dispose();
    this.depthTarget.depthTexture?.dispose();
    this.depthTarget.dispose();
  }

  private syncSize(): void {
    this.renderer.getDrawingBufferSize(this.size);
    (this.retroPass.uniforms.uResolution.value as THREE.Vector2).copy(this.size);
    this.depthTarget.setSize(this.size.x, this.size.y);
    this.updateUniforms();
  }

  private updateUniforms(): void {
    const u = this.retroPass.uniforms;
    const s = this.settings;
    const on = this.active;
    u.uEnabled.value = on ? 1 : 0;
    u.uStyle.value = STYLE_IDS[this.style] ?? 0;
    u.uStyleCell.value = Math.max(1, Math.min(this.size.x, this.size.y) * (STYLE_CELLS[this.style] ?? 1));
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
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
    materialUniforms.uSnapResolution.value.set(Math.max(64, this.size.x / px), Math.max(48, this.size.y / px));
    materialUniforms.uSnapAmount.value = on && this.style === 'ps1' ? s.vertexSnap : 0;
    materialUniforms.uToon.value = on && this.style === 'toon' ? 1 : 0;
  }
}

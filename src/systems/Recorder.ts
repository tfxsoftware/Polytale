import type { ActiveDialogue } from '../timeline/types';
import { drawSubtitles, subtitleInset, subtitleScale, visibleDialogues, type ScreenPoint, type SpeakerInfo, type SubtitleStyle } from '../ui/SubtitleRenderer';
import { titleCardOpacity, type TitleCardState } from '../ui/TitleCard';
import { drawWatermark, type WatermarkStyle } from '../ui/Watermark';
import { LoudnessMeter } from './Loudness';

export interface RecorderOverlay {
  dialogues: ActiveDialogue[];
  titleCard: TitleCardState | null;
  subtitles: SubtitleStyle;
  watermark: WatermarkStyle | null;
  speaker(actorId: string): SpeakerInfo;
  /** Topo da cabeça de cada ator na tela (legendas em balão). */
  anchor?(actorId: string): ScreenPoint | null;
}

/** MP4 (H.264/AAC) primeiro: é o que Instagram, TikTok e WhatsApp aceitam direto. */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/** Amostras guardadas pelo analisador do medidor: cobrem ~170 ms, ou seja, quadros de até ~6 fps sem perder áudio. */
const LOUDNESS_WINDOW = 8192;

/**
 * Grava a cena em .mp4 (ou .webm, se o navegador não gravar MP4): vídeo do canvas WebGL (com legendas e cartelas
 * desenhadas por cima) + áudio da mixagem da engine.
 *
 * Limite: a voz do `speechSynthesis` sai direto pelo sistema operacional e
 * não passa pelo Web Audio — por isso não entra na gravação. Vozes 'babble',
 * arquivos de áudio e sons procedurais entram.
 */
export class Recorder {
  private composite: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private recorder: MediaRecorder | null = null;
  private audioTap: MediaStreamAudioDestinationNode | null = null;
  private chunks: Blob[] = [];
  private stopped: Promise<Blob> | null = null;
  private startedAt = 0;
  private exportGain: GainNode | null = null;
  private loudnessAnalysers: AnalyserNode[] = [];
  private loudnessMeter: LoudnessMeter | null = null;
  private loudnessBuffers: Float32Array<ArrayBuffer>[] = [];
  private measuredUntil = 0;
  /** LUFS integrado medido na última gravação (o que foi para o arquivo); null antes/sem medição. */
  measuredLUFS: number | null = null;

  constructor(
    private readonly source: HTMLCanvasElement,
    private readonly audioContext: AudioContext,
    private readonly audioOutput: AudioNode,
  ) {}

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  /** Segundos gravados até agora. */
  get elapsed(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** `gain`: ganho linear aplicado só à gravação (a saída nas caixas de som não muda). */
  start(fps = 30, gain = 1): void {
    if (this.recording) return;
    if (!Recorder.supported()) throw new Error('Gravação não suportada neste navegador (MediaRecorder/captureStream).');

    const canvas = document.createElement('canvas');
    canvas.width = this.source.width;
    canvas.height = this.source.height;
    this.composite = canvas;
    this.ctx = canvas.getContext('2d');

    const stream = canvas.captureStream(fps);
    this.audioTap = this.audioContext.createMediaStreamDestination();
    this.exportGain = this.audioContext.createGain();
    this.exportGain.gain.value = gain;
    // Limitador: o ganho de correção não pode estourar nos picos.
    const limiter = this.audioContext.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    this.audioOutput.connect(this.exportGain).connect(limiter).connect(this.audioTap);
    for (const track of this.audioTap.stream.getAudioTracks()) stream.addTrack(track);

    // Mede depois do limitador, canal a canal: o mesmo sinal que vai para o arquivo.
    const splitter = this.audioContext.createChannelSplitter(2);
    limiter.connect(splitter);
    this.loudnessAnalysers = [0, 1].map((channel) => {
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = LOUDNESS_WINDOW;
      splitter.connect(analyser, channel);
      return analyser;
    });
    this.loudnessMeter = new LoudnessMeter(this.audioContext.sampleRate, 2);
    this.loudnessBuffers = this.loudnessAnalysers.map(() => new Float32Array(LOUDNESS_WINDOW));
    this.measuredUntil = this.audioContext.currentTime;
    this.measuredLUFS = null;

    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    // ~8 Mbps em 1080p; nunca abaixo de 4 Mbps (o dithering retrô pesa na compressão).
    const videoBitsPerSecond = Math.max(4_000_000, Math.round(canvas.width * canvas.height * 4));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond });
    this.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.stopped = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: mimeType || 'video/webm' }));
    });
    recorder.start(1000);
    this.recorder = recorder;
    this.startedAt = performance.now();
  }

  /** Copia o quadro recém-renderizado e desenha as legendas. Chamar logo após o render. */
  captureFrame(overlay: RecorderOverlay): void {
    if (!this.recording || !this.ctx || !this.composite) return;
    const { ctx, composite } = this;
    if (composite.width !== this.source.width || composite.height !== this.source.height) {
      composite.width = this.source.width;
      composite.height = this.source.height;
    }
    ctx.drawImage(this.source, 0, 0, composite.width, composite.height);
    this.drawTitleCard(overlay.titleCard);
    this.drawDialogues(visibleDialogues(overlay.dialogues, overlay.subtitles), overlay);
    if (overlay.watermark) drawWatermark(ctx, composite.width, composite.height, overlay.watermark);
    this.measureLoudness();
  }

  /** Lê só as amostras novas desde o último quadro: sem buracos nem amostras repetidas, seja qual for o fps. */
  private measureLoudness(): void {
    if (!this.loudnessMeter) return;
    const now = this.audioContext.currentTime;
    const fresh = Math.min(LOUDNESS_WINDOW, Math.round((now - this.measuredUntil) * this.audioContext.sampleRate));
    if (fresh <= 0) return;
    this.measuredUntil = now;
    this.loudnessAnalysers.forEach((analyser, i) => analyser.getFloatTimeDomainData(this.loudnessBuffers[i]));
    this.loudnessMeter.feed(...this.loudnessBuffers.map((b) => b.subarray(LOUDNESS_WINDOW - fresh)));
  }

  async stop(): Promise<Blob | null> {
    if (!this.recorder || !this.stopped) return null;
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    const blob = await this.stopped;
    if (this.exportGain) {
      try {
        this.audioOutput.disconnect(this.exportGain);
      } catch {
        /* já desconectado */
      }
    }
    this.measuredLUFS = this.loudnessMeter?.integrated ?? null;
    this.recorder = null;
    this.stopped = null;
    this.audioTap = null;
    this.composite = null;
    this.ctx = null;
    this.exportGain = null;
    this.loudnessAnalysers = [];
    this.loudnessMeter = null;
    this.loudnessBuffers = [];
    return blob;
  }

  static download(blob: Blob, title: string): void {
    const slug =
      title
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'polytale';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}.${blob.type.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------------------------------------------------------------------- */

  private scale(): number {
    return subtitleScale(this.composite?.width ?? 1280, this.composite?.height ?? 720);
  }

  private drawTitleCard(card: TitleCardState | null): void {
    if (!card || !this.ctx || !this.composite) return;
    const alpha = titleCardOpacity(card.progress);
    if (alpha <= 0.001) return;
    const { ctx, composite } = this;
    const k = this.scale();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (card.overlay) {
      // Sem faixa: texto com sombra projetada, perto da base, por cima da cena em andamento.
      const shadowed = (text: string, y: number, size: number, color: string) => {
        ctx.font = `${Math.round(size * k)}px VT323, ui-monospace, monospace`;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillText(text, composite.width / 2 + 2 * k, y + 2 * k);
        ctx.fillStyle = color;
        ctx.fillText(text, composite.width / 2, y);
      };
      shadowed(card.subtitle.toUpperCase(), composite.height * 0.84, 24, '#c9d1ff');
      let titleSize = 48;
      ctx.font = `${Math.round(titleSize * k)}px VT323, ui-monospace, monospace`;
      const fit = Math.min(1, (composite.width * 0.9) / Math.max(1, ctx.measureText(card.title).width));
      if (fit < 1) titleSize = Math.floor(titleSize * fit);
      shadowed(card.title, composite.height * 0.9, titleSize, '#ffd166');
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, composite.height * 0.36, composite.width, composite.height * 0.26);
      ctx.fillStyle = '#c9d1ff';
      ctx.font = `${Math.round(26 * k)}px VT323, ui-monospace, monospace`;
      ctx.fillText(card.subtitle.toUpperCase(), composite.width / 2, composite.height * 0.43);
      ctx.fillStyle = '#ffd166';
      // Encolhe o título se não couber na largura (quadro vertical).
      ctx.font = `${Math.round(64 * k)}px VT323, ui-monospace, monospace`;
      const fit = Math.min(1, (composite.width * 0.9) / Math.max(1, ctx.measureText(card.title).width));
      if (fit < 1) ctx.font = `${Math.floor(64 * k * fit)}px VT323, ui-monospace, monospace`;
      ctx.fillText(card.title, composite.width / 2, composite.height * 0.52);
    }
    ctx.restore();
  }

  private drawDialogues(dialogues: ActiveDialogue[], overlay: RecorderOverlay): void {
    if (!this.ctx || !this.composite) return;
    const k = this.scale();
    const { width, height } = this.composite;
    const style = overlay.subtitles;
    const inset = subtitleInset(style.position, width, height, k);
    const anchor = overlay.anchor?.bind(overlay);
    drawSubtitles(this.ctx, { width, height, scale: k, inset, time: performance.now() / 1000, anchor }, dialogues, style, overlay.speaker);
  }
}

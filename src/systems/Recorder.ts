import type { ActiveDialogue } from '../timeline/types';
import { drawSubtitles, visibleDialogues, type SpeakerInfo, type SubtitleStyle } from '../ui/SubtitleRenderer';
import { titleCardOpacity, type TitleCardState } from '../ui/TitleCard';

export interface RecorderOverlay {
  dialogues: ActiveDialogue[];
  titleCard: TitleCardState | null;
  subtitles: SubtitleStyle;
  speaker(actorId: string): SpeakerInfo;
}

const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

/**
 * Grava a cena em .webm: vídeo do canvas WebGL (com legendas e cartelas
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

  start(fps = 30): void {
    if (this.recording) return;
    if (!Recorder.supported()) throw new Error('Gravação não suportada neste navegador (MediaRecorder/captureStream).');

    const canvas = document.createElement('canvas');
    canvas.width = this.source.width;
    canvas.height = this.source.height;
    this.composite = canvas;
    this.ctx = canvas.getContext('2d');

    const stream = canvas.captureStream(fps);
    this.audioTap = this.audioContext.createMediaStreamDestination();
    this.audioOutput.connect(this.audioTap);
    for (const track of this.audioTap.stream.getAudioTracks()) stream.addTrack(track);

    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
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
    this.drawDialogues(visibleDialogues(overlay.dialogues, overlay.subtitles), overlay.subtitles, overlay.speaker);
  }

  async stop(): Promise<Blob | null> {
    if (!this.recorder || !this.stopped) return null;
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    const blob = await this.stopped;
    if (this.audioTap) {
      try {
        this.audioOutput.disconnect(this.audioTap);
      } catch {
        /* já desconectado */
      }
    }
    this.recorder = null;
    this.stopped = null;
    this.audioTap = null;
    this.composite = null;
    this.ctx = null;
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
    a.download = `${slug}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------------------------------------------------------------------- */

  private scale(): number {
    return Math.max(0.6, (this.composite?.height ?? 720) / 720);
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
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, composite.height * 0.36, composite.width, composite.height * 0.26);
    ctx.fillStyle = '#c9d1ff';
    ctx.font = `${Math.round(26 * k)}px VT323, ui-monospace, monospace`;
    ctx.fillText(card.subtitle.toUpperCase(), composite.width / 2, composite.height * 0.43);
    ctx.fillStyle = '#ffd166';
    ctx.font = `${Math.round(64 * k)}px VT323, ui-monospace, monospace`;
    ctx.fillText(card.title, composite.width / 2, composite.height * 0.52);
    ctx.restore();
  }

  private drawDialogues(dialogues: ActiveDialogue[], style: SubtitleStyle, speaker: (id: string) => SpeakerInfo): void {
    if (!this.ctx || !this.composite) return;
    const k = this.scale();
    const { width, height } = this.composite;
    drawSubtitles(this.ctx, { width, height, scale: k, inset: (style.position === 'top' ? 24 : 28) * k, time: performance.now() / 1000 }, dialogues, style, speaker);
  }
}

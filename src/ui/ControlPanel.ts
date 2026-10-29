import type { TimelineSnapshot } from '../timeline/Timeline';
import type { EventType } from '../timeline/types';

export interface ControlPanelCallbacks {
  onTogglePlay(): void;
  onRestart(): void;
  onSeek(time: number): void;
  onScrubStart(): void;
  onScrubEnd(): void;
  onStep(delta: number): void;
  onToggleRetro(): boolean;
  onToggleMute(): boolean;
  onRate(rate: number): void;
  onOpenEditor(): void;
  /** Liga/desliga a gravação; retorna se está gravando. */
  onToggleRecord(): Promise<boolean>;
  onOpenGenerator(): void;
  onToggleTracks(): void;
  onToggleSubtitles(): void;
  onOpenSettings(): void;
  onUndo(): void;
  onRedo(): void;
}

export interface TimelineMarker {
  time: number;
  type: EventType | 'CHAPTER';
  label: string;
}

const RATES = [0.25, 0.5, 1, 1.5, 2];

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function button(label: string, title: string, className = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `cp-btn ${className}`.trim();
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

/**
 * Overlay de controle: Play/Pause, reinício, scrubber com marcadores,
 * velocidade, mudo, botão Retro FX e acesso ao editor de script.
 * Atalhos: Espaço (play/pause), ←/→ (±1s, Shift ±5s), Home (início),
 * R (Retro FX), M (mudo), E (editor), O (opções), L (legendas), 1–5 (velocidade).
 */
export class ControlPanel {
  private readonly root: HTMLDivElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly retroBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly rateBtn: HTMLButtonElement;
  private readonly recBtn: HTMLButtonElement;
  private readonly scrubber: HTMLInputElement;
  private readonly markerLayer: HTMLDivElement;
  private readonly timeLabel: HTMLSpanElement;
  private readonly titleLabel: HTMLDivElement;
  private readonly fpsLabel: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private scrubbing = false;
  private duration = 0;
  private rateIndex = 2;

  constructor(
    parent: HTMLElement,
    private readonly cb: ControlPanelCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'control-panel';

    this.titleLabel = document.createElement('div');
    this.titleLabel.className = 'cp-title';

    this.status = document.createElement('div');
    this.status.className = 'cp-status';
    this.status.hidden = true;

    const row = document.createElement('div');
    row.className = 'cp-row';

    this.playBtn = button('▶', 'Play/Pause (Espaço)', 'cp-play');
    const restartBtn = button('|◀', 'Reiniciar (Home)');
    this.timeLabel = document.createElement('span');
    this.timeLabel.className = 'cp-time';

    const scrubWrap = document.createElement('div');
    scrubWrap.className = 'cp-scrub';
    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'cp-markers';
    this.scrubber = document.createElement('input');
    this.scrubber.type = 'range';
    this.scrubber.min = '0';
    this.scrubber.max = '1000';
    this.scrubber.step = '1';
    this.scrubber.value = '0';
    this.scrubber.setAttribute('aria-label', 'Posição na timeline');
    scrubWrap.append(this.markerLayer, this.scrubber);

    this.rateBtn = button('1x', 'Velocidade (1–5)');
    this.muteBtn = button('SOM', 'Mudo (M)');
    this.retroBtn = button('RETRO FX', 'Liga/desliga shader retrô (R)', 'cp-retro is-on');
    const editBtn = button('{ } SCRIPT', 'Editar StoryScript (E)');
    const tracksBtn = button('TRILHAS', 'Editor visual da timeline (T)');
    const aiBtn = button('✦ IA', 'Gerar roteiro com IA (G)');
    const settingsBtn = button('⚙ OPÇÕES', 'Opções de legenda (O)');
    this.recBtn = button('● REC', 'Gravar vídeo .webm do início ao fim (V)', 'cp-rec');
    this.fpsLabel = document.createElement('span');
    this.fpsLabel.className = 'cp-fps';

    row.append(
      this.playBtn,
      restartBtn,
      this.timeLabel,
      scrubWrap,
      this.rateBtn,
      this.muteBtn,
      this.retroBtn,
      editBtn,
      tracksBtn,
      aiBtn,
      settingsBtn,
      this.recBtn,
      this.fpsLabel,
    );
    this.root.append(this.titleLabel, this.status, row);
    parent.appendChild(this.root);

    this.playBtn.addEventListener('click', () => cb.onTogglePlay());
    restartBtn.addEventListener('click', () => cb.onRestart());
    this.rateBtn.addEventListener('click', () => this.cycleRate(1));
    this.muteBtn.addEventListener('click', () => this.setMuted(cb.onToggleMute()));
    this.retroBtn.addEventListener('click', () => this.setRetro(cb.onToggleRetro()));
    editBtn.addEventListener('click', () => cb.onOpenEditor());
    tracksBtn.addEventListener('click', () => cb.onToggleTracks());
    aiBtn.addEventListener('click', () => cb.onOpenGenerator());
    settingsBtn.addEventListener('click', () => cb.onOpenSettings());
    this.recBtn.addEventListener('click', () => void this.toggleRecord());

    this.scrubber.addEventListener('pointerdown', () => {
      this.scrubbing = true;
      cb.onScrubStart();
    });
    this.scrubber.addEventListener('input', () => cb.onSeek(this.scrubberTime()));
    const end = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      cb.onScrubEnd();
    };
    this.scrubber.addEventListener('pointerup', end);
    this.scrubber.addEventListener('change', end);

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  setTitle(title: string): void {
    this.titleLabel.textContent = title;
  }

  setMarkers(markers: TimelineMarker[], duration: number): void {
    this.duration = duration;
    this.markerLayer.replaceChildren(
      ...markers.map((m) => {
        const el = document.createElement('div');
        const kind =
          m.type === 'PLAY_AUDIO_WITH_LIPSYNC' ? 'is-dialogue' : m.type === 'INTERACT' ? 'is-interact' : m.type === 'CHAPTER' ? 'is-chapter' : 'is-camera';
        el.className = `cp-marker ${kind}`;
        el.style.left = `${(m.time / Math.max(0.001, duration)) * 100}%`;
        el.title = `${formatTime(m.time)} — ${m.label}`;
        return el;
      }),
    );
  }

  /** Atualizado a cada quadro. */
  update(s: TimelineSnapshot, fps: number): void {
    this.duration = s.duration;
    this.playBtn.textContent = s.playing ? '❚❚' : '▶';
    this.playBtn.classList.toggle('is-playing', s.playing);
    this.timeLabel.textContent = `${formatTime(s.time)} / ${formatTime(s.duration)}`;
    if (!this.scrubbing) this.scrubber.value = String(Math.round((s.time / Math.max(0.001, s.duration)) * 1000));
    this.fpsLabel.textContent = `${Math.round(fps)} fps`;
  }

  setRecording(on: boolean): void {
    this.recBtn.classList.toggle('is-recording', on);
    this.recBtn.textContent = on ? '■ PARAR' : '● REC';
  }

  private async toggleRecord(): Promise<void> {
    this.setRecording(await this.cb.onToggleRecord());
  }

  setRetro(on: boolean): void {
    this.retroBtn.classList.toggle('is-on', on);
  }

  setMuted(muted: boolean): void {
    this.muteBtn.textContent = muted ? 'MUDO' : 'SOM';
    this.muteBtn.classList.toggle('is-muted', muted);
  }

  /** Tela inicial "pressione start" (necessária para liberar o áudio por gesto do usuário). */
  showStartScreen(title: string, onStart: () => void): void {
    const overlay = document.createElement('button');
    overlay.type = 'button';
    overlay.className = 'start-screen';
    const t = document.createElement('div');
    t.className = 'start-title';
    t.textContent = title;
    const hint = document.createElement('div');
    hint.className = 'start-hint';
    hint.textContent = '▶ PRESS START';
    overlay.append(t, hint);
    overlay.addEventListener('click', () => {
      overlay.remove();
      onStart();
    });
    this.root.parentElement?.appendChild(overlay);
  }

  /** Mensagem de estado (carregando, erro...). `null` esconde. */
  setStatus(message: string | null, kind: 'info' | 'error' = 'info'): void {
    this.status.hidden = message === null;
    this.status.textContent = message ?? '';
    this.status.classList.toggle('is-error', kind === 'error');
  }

  private scrubberTime(): number {
    return (Number(this.scrubber.value) / 1000) * this.duration;
  }

  private cycleRate(dir: number): void {
    this.rateIndex = (this.rateIndex + dir + RATES.length) % RATES.length;
    this.applyRate();
  }

  private applyRate(): void {
    const r = RATES[this.rateIndex];
    this.rateBtn.textContent = `${r}x`;
    this.cb.onRate(r);
  }

  private onKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
    if (document.querySelector('.editor-backdrop:not([hidden])')) return;
    // Ctrl+Z desfaz; Ctrl+Shift+Z / Ctrl+Y refaz (campos de texto mantêm o desfazer nativo, acima).
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'z' || key === 'y') {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) this.cb.onRedo();
        else this.cb.onUndo();
      }
      return;
    }
    if (e.altKey) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.cb.onTogglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.cb.onStep(e.shiftKey ? -5 : -1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.cb.onStep(e.shiftKey ? 5 : 1);
        break;
      case 'Home':
        this.cb.onRestart();
        break;
      case 'r':
      case 'R':
        this.setRetro(this.cb.onToggleRetro());
        break;
      case 'm':
      case 'M':
        this.setMuted(this.cb.onToggleMute());
        break;
      case 'e':
      case 'E':
        this.cb.onOpenEditor();
        break;
      case 't':
      case 'T':
        this.cb.onToggleTracks();
        break;
      case 'g':
      case 'G':
        this.cb.onOpenGenerator();
        break;
      case 'o':
      case 'O':
        this.cb.onOpenSettings();
        break;
      case 'l':
      case 'L':
        this.cb.onToggleSubtitles();
        break;
      case 'v':
      case 'V':
        void this.toggleRecord();
        break;
      default:
        if (/^[1-5]$/.test(e.key)) {
          this.rateIndex = Number(e.key) - 1;
          this.applyRate();
        }
    }
  }
}

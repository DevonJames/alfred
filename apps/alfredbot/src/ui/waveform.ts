import type { ExpressionFace } from "@alfred/contracts";

type WaveStyle = {
  height: number;
  /** Center lift (negative) or drop (positive), as a fraction of height. */
  mouth: number;
  /** Right-side lift; wink / smirk. */
  skew: number;
  sharpness: number;
  color: readonly [number, number, number];
};

const CALM: WaveStyle = {
  height: 1,
  mouth: 0,
  skew: 0,
  sharpness: 0,
  color: [255, 179, 71],
};

function styleFor(face: ExpressionFace): WaveStyle {
  switch (face) {
    case "smile":
      return { height: 1.08, mouth: -0.1, skew: 0.03, sharpness: 0, color: [255, 196, 110] };
    case "wink":
      return { height: 0.95, mouth: -0.04, skew: 0.18, sharpness: 0, color: [255, 214, 150] };
    case "curious":
      return { height: 0.82, mouth: 0, skew: 0.02, sharpness: 0, color: [232, 196, 130] };
    case "surprised":
      return { height: 1.22, mouth: -0.02, skew: 0, sharpness: 0.1, color: [255, 236, 205] };
    case "frown":
      return { height: 0.88, mouth: 0.1, skew: 0, sharpness: 0.12, color: [230, 150, 78] };
    case "angry":
      return { height: 1.04, mouth: 0.07, skew: 0, sharpness: 0.45, color: [255, 118, 68] };
    case "sad":
      return { height: 0.62, mouth: 0.12, skew: 0, sharpness: 0, color: [198, 148, 92] };
    case "empathetic":
      return { height: 0.74, mouth: 0.05, skew: 0, sharpness: 0, color: [240, 186, 128] };
    default:
      return CALM;
  }
}

function rgba(color: readonly [number, number, number], a: number): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${a})`;
}

/** Talk-style oscilloscope, recolored for the black / amber face. */
export class LiveWaveform {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private audioCtx?: AudioContext;
  private analyser?: AnalyserNode;
  private source?: MediaStreamAudioSourceNode;
  private raf = 0;
  private running = false;
  private timeData = new Uint8Array(0);
  private smoothed = 0;
  private peak = 0.05;
  private speaking = false;
  private face: ExpressionFace = "calm";
  private onLevel?: (rms: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame(() => this.resize());
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.resize()).observe(this.canvas);
    }
  }

  setLevelHandler(handler: (rms: number) => void): void {
    this.onLevel = handler;
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (speaking || this.face !== "calm") this.ensureLoop();
    else if (!this.analyser) this.stopLoop();
  }

  setExpression(face: ExpressionFace): void {
    this.face = face;
    if (face !== "calm") this.ensureLoop();
    else if (!this.speaking && !this.analyser) this.stopLoop();
  }

  async attach(track: MediaStreamTrack): Promise<void> {
    this.releaseMeter();
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      this.ensureLoop();
      return;
    }
    this.audioCtx = new Ctx();
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
    this.source = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.35;
    this.source.connect(this.analyser);
    const silent = this.audioCtx.createGain();
    silent.gain.value = 0;
    this.analyser.connect(silent);
    silent.connect(this.audioCtx.destination);
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.timeData.fill(128);
    this.ensureLoop();
  }

  detach(): void {
    this.releaseMeter();
    if (!this.speaking && this.face === "calm") this.stopLoop();
  }

  private emoting(): boolean {
    return this.face !== "calm";
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 2 || h < 2) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.running) this.drawIdle();
  }

  private ensureLoop(): void {
    if (!this.timeData.length) {
      this.timeData = new Uint8Array(2048);
      this.timeData.fill(128);
    }
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  private stopLoop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.smoothed = 0;
    this.drawIdle();
  }

  private releaseMeter(): void {
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    void this.audioCtx?.close();
    this.source = undefined;
    this.analyser = undefined;
    this.audioCtx = undefined;
  }

  private loop = (): void => {
    if (!this.running) return;
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private drawIdle(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const g = this.ctx;
    g.clearRect(0, 0, w, h);
    g.lineWidth = 2;
    g.strokeStyle = "rgba(255, 179, 71, 0.38)";
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();
  }

  /** Lift a quiet remote track into range without slamming it to full scale. */
  private displayGain(rms: number): number {
    this.peak = Math.max(rms, this.peak * 0.994);
    if (this.peak < 0.0012) return this.speaking ? 7 : 0;
    return Math.min(9, 0.13 / this.peak);
  }

  private readLevel(): { rms: number; gain: number } {
    const analyser = this.analyser;
    let rms = 0;
    if (analyser && this.timeData.length) {
      analyser.getByteTimeDomainData(this.timeData);
      let sumSq = 0;
      for (let i = 0; i < this.timeData.length; i++) {
        const v = (this.timeData[i]! - 128) / 128;
        sumSq += v * v;
      }
      rms = Math.sqrt(sumSq / this.timeData.length);
    }
    return { rms, gain: this.displayGain(rms) };
  }

  private sampleY(x: number, w: number, h: number, gain: number, heightScale: number, style: WaveStyle): number {
    const x01 = w <= 1 ? 0 : x / (w - 1);
    const step = Math.max(1, Math.floor(this.timeData.length / Math.max(w, 1)));
    const raw = (this.timeData[Math.min(this.timeData.length - 1, Math.floor(x) * step)]! - 128) / 128;
    let v = Math.tanh(raw * Math.max(gain, 1) * 1.15);
    if (style.sharpness > 0.3) v = Math.sign(v) * Math.min(1, Math.abs(v) ** (1 - style.sharpness * 0.4));
    const mouth = Math.sin(x01 * Math.PI) * style.mouth * h;
    const skew = (x01 - 0.42) * style.skew * h;
    return h / 2 + v * heightScale * style.height + mouth + skew;
  }

  private draw(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 2 || h < 2) return;

    if (!this.timeData.length) {
      this.drawIdle();
      return;
    }
    if (this.audioCtx?.state === "suspended") void this.audioCtx.resume();
    const style = styleFor(this.face);
    const { rms, gain } = this.readLevel();
    const level = Math.min(0.85, rms * Math.max(gain, 1));
    this.smoothed = this.smoothed * 0.78 + level * 0.22;
    this.onLevel?.(this.smoothed);
    if (!this.speaking && !this.emoting() && this.smoothed < 0.012) {
      this.drawIdle();
      return;
    }

    const g = this.ctx;
    g.clearRect(0, 0, w, h);

    const bloom = g.createRadialGradient(w / 2, h / 2, 16, w / 2, h / 2, w * 0.45);
    bloom.addColorStop(0, rgba(style.color, 0.05 + this.smoothed * 0.22));
    bloom.addColorStop(1, rgba(style.color, 0));
    g.fillStyle = bloom;
    g.fillRect(0, 0, w, h);

    g.lineWidth = 4;
    g.strokeStyle = `rgba(255, 232, 196, ${0.8 + this.smoothed * 0.2})`;
    g.shadowColor = rgba(style.color, 0.9);
    g.shadowBlur = 14 + this.smoothed * 20;
    g.beginPath();
    const heightScale = h * 0.48 * (0.7 + this.smoothed * 0.55);
    for (let x = 0; x < w; x++) {
      const y = this.sampleY(x, w, h, gain, heightScale, style);
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;
  }
}

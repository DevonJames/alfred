/**
 * Live oscilloscope + spectral bars driven by Web Audio AnalyserNode
 * attached to Alfred's remote MediaStreamTrack (not a canned loop).
 */

export class LiveWaveform {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private audioCtx?: AudioContext;
  private analyser?: AnalyserNode;
  private source?: MediaStreamAudioSourceNode;
  private raf = 0;
  private running = false;
  private timeData = new Uint8Array(0);
  private freqData = new Uint8Array(0);
  private smoothed = 0;
  private phase = 0;
  private onLevel?: (rms: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
  }

  setLevelHandler(handler: (rms: number) => void): void {
    this.onLevel = handler;
  }

  async attach(track: MediaStreamTrack): Promise<void> {
    this.detach();
    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
    const stream = new MediaStream([track]);
    this.source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.source.connect(this.analyser);
    // Do not connect to destination — HTMLAudioElement already plays the track.
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.running = true;
    this.loop();
  }

  detach(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.analyser?.disconnect();
    } catch {
      /* ignore */
    }
    void this.audioCtx?.close();
    this.source = undefined;
    this.analyser = undefined;
    this.audioCtx = undefined;
    this.drawIdle();
  }

  private loop = (): void => {
    if (!this.running) return;
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private drawIdle(): void {
    const { width: w, height: h } = this.canvas;
    const g = this.ctx;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = "rgba(61, 255, 196, 0.25)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();
  }

  private draw(): void {
    const analyser = this.analyser;
    if (!analyser) {
      this.drawIdle();
      return;
    }

    analyser.getByteTimeDomainData(this.timeData);
    analyser.getByteFrequencyData(this.freqData);

    let sumSq = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i]! - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this.timeData.length);
    this.smoothed = this.smoothed * 0.82 + rms * 0.18;
    this.onLevel?.(this.smoothed);
    this.phase += 0.02 + this.smoothed * 0.35;

    const { width: w, height: h } = this.canvas;
    const g = this.ctx;
    g.clearRect(0, 0, w, h);

    // Soft phosphor bloom under the wave
    const bloom = g.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w * 0.45);
    bloom.addColorStop(0, `rgba(61, 255, 196, ${0.04 + this.smoothed * 0.25})`);
    bloom.addColorStop(1, "rgba(61, 255, 196, 0)");
    g.fillStyle = bloom;
    g.fillRect(0, 0, w, h);

    // Spectral bars (lower half mirror)
    const bars = 64;
    const barW = w / bars;
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor((i / bars) * this.freqData.length * 0.45);
      const mag = (this.freqData[idx] ?? 0) / 255;
      const bh = mag * h * 0.38;
      const x = i * barW;
      const alpha = 0.12 + mag * 0.45;
      g.fillStyle = `rgba(255, 179, 71, ${alpha})`;
      g.fillRect(x + 1, h / 2 - bh, barW - 2, bh);
      g.fillStyle = `rgba(61, 255, 196, ${alpha * 0.7})`;
      g.fillRect(x + 1, h / 2, barW - 2, bh * 0.85);
    }

    // Center oscilloscope
    g.lineWidth = 2.2;
    g.strokeStyle = `rgba(215, 246, 255, ${0.55 + this.smoothed})`;
    g.shadowColor = "rgba(61, 255, 196, 0.65)";
    g.shadowBlur = 12 + this.smoothed * 28;
    g.beginPath();
    const step = Math.max(1, Math.floor(this.timeData.length / w));
    for (let x = 0; x < w; x++) {
      const dataIndex = Math.min(this.timeData.length - 1, x * step);
      const v = (this.timeData[dataIndex]! - 128) / 128;
      const y = h / 2 + v * (h * 0.42) * (0.35 + this.smoothed * 2.2);
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;

    // Secondary phase-shifted ghost trail
    g.strokeStyle = `rgba(61, 255, 196, ${0.2 + this.smoothed * 0.35})`;
    g.lineWidth = 1.2;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const dataIndex = Math.min(this.timeData.length - 1, x * step);
      const v = (this.timeData[dataIndex]! - 128) / 128;
      const y =
        h / 2 +
        v * (h * 0.28) * (0.3 + this.smoothed * 1.6) +
        Math.sin(this.phase + x * 0.02) * (2 + this.smoothed * 8);
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();

    // Crosshair
    g.strokeStyle = "rgba(111, 143, 163, 0.35)";
    g.lineWidth = 1;
    g.setLineDash([4, 6]);
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();
    g.setLineDash([]);
  }
}

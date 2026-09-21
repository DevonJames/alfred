import type { ExpressionBody, ExpressionEvent, ExpressionFace } from "@alfred/contracts";

export type VoiceMood = "idle" | "listening" | "speaking" | "muted";

export class AlfredFace {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private raf = 0;
  private phase = 0;
  private mood: VoiceMood = "idle";
  private face: ExpressionFace = "calm";
  private body: ExpressionBody = "none";
  private winkUntil = 0;
  private bodyUntil = 0;
  private rms = 0;
  private blinkAmount = 0;
  private blinkEndsAt = 0;
  private nextBlinkAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame(() => this.resize());
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.resize()).observe(this.canvas);
    }
  }

  start(): void {
    const loop = () => {
      try {
        this.draw();
      } catch (err) {
        console.warn("alfredbot face draw failed", err);
      }
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  setMood(mood: VoiceMood): void {
    this.mood = mood;
  }

  setLevel(rms: number): void {
    this.rms = rms;
  }

  applyExpression(event: ExpressionEvent): void {
    if (event.type === "clear") {
      this.face = "calm";
      this.body = "none";
      this.winkUntil = 0;
      this.bodyUntil = 0;
      return;
    }
    this.face = event.face;
    this.body = event.body;
    if (event.face === "wink") this.winkUntil = performance.now() + 700;
    if (event.body !== "none") this.bodyUntil = performance.now() + 1_400;
  }

  current(): { face: ExpressionFace; body: ExpressionBody } {
    return { face: this.face, body: this.body };
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 2 || h < 2) return;
    const nextW = Math.round(w * dpr);
    const nextH = Math.round(h * dpr);
    if (this.canvas.width === nextW && this.canvas.height === nextH) return;
    this.canvas.width = nextW;
    this.canvas.height = nextH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 2 || h < 2) {
      this.resize();
      return;
    }
    const g = this.ctx;
    this.phase += 0.016;
    g.clearRect(0, 0, w, h);

    const now = performance.now();
    this.updateBlink(now);
    if (this.winkUntil && now > this.winkUntil && this.face === "wink") {
      this.face = "smile";
      this.winkUntil = 0;
    }
    if (this.bodyUntil && now > this.bodyUntil) {
      this.body = "none";
      this.bodyUntil = 0;
    }

    const tilt =
      this.body === "tilt"
        ? Math.sin(this.phase * 2.2) * 0.08
        : this.body === "nod"
          ? Math.sin(this.phase * 7) * 0.04
          : this.face === "curious"
            ? 0.05
            : 0;

    g.save();
    g.translate(w / 2, h / 2);
    g.rotate(tilt);
    g.translate(-w / 2, -h / 2);

    const cx = w / 2;
    const cy = h * 0.27;
    const eyeY = cy - h * 0.02 + 20;
    const eyeOffset = Math.min(w * 0.22, 210);

    this.drawEye(cx - eyeOffset, eyeY, "left");
    this.drawEye(cx + eyeOffset, eyeY, "right");
    this.drawBrows(cx, eyeY, eyeOffset);
    g.restore();
  }

  private updateBlink(now: number): void {
    const durationMs = 110;
    if (this.nextBlinkAt === 0) {
      this.nextBlinkAt = now + 1600 + Math.random() * 2800;
    }
    if (this.blinkEndsAt === 0 && this.mood !== "muted" && now >= this.nextBlinkAt) {
      this.blinkEndsAt = now + durationMs;
      this.nextBlinkAt = this.blinkEndsAt + 2200 + Math.random() * 3800;
    }
    if (!this.blinkEndsAt) {
      this.blinkAmount = 0;
      return;
    }
    const t = 1 - (this.blinkEndsAt - now) / durationMs;
    if (t >= 1) {
      this.blinkAmount = 0;
      this.blinkEndsAt = 0;
      return;
    }
    this.blinkAmount = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);
  }

  private openness(side: "left" | "right"): number {
    if (this.mood === "muted") return 0.12;
    if (this.face === "wink" && side === "right") return 0;
    if (this.winkUntil && side === "right") return 0;
    const base =
      this.mood === "speaking" ? 0.94 : this.mood === "listening" ? 0.88 : 0.82;
    const faceMod =
      this.face === "surprised"
        ? 0.08
        : this.face === "smile" || this.face === "curious"
          ? 0.02
          : this.face === "sad" || this.face === "empathetic"
            ? -0.12
            : this.face === "angry" || this.face === "frown"
              ? -0.1
              : 0;
    const open = Math.min(1, Math.max(0, base + faceMod));
    return open * (1 - this.blinkAmount);
  }

  private drawEye(x: number, y: number, side: "left" | "right"): void {
    const g = this.ctx;
    const open = this.openness(side);
    const scale = 1.2;
    const scleraR = 72 * scale;
    const lidMax = 66 * scale;
    const scleraRy = Math.max(1.2, lidMax * open);
    const clipRy = Math.max(0.5, scleraRy - 2);
    const irisR = 46 * scale;
    const pupilR =
      (this.face === "surprised" ? 16 : this.face === "curious" ? 20 : 18) * scale;
    const gazeX =
      (side === "left" ? -1 : 1) *
      (this.face === "curious" ? 7 : this.mood === "listening" ? 3 : 0);
    const gazeY = this.face === "sad" ? 6 : this.face === "surprised" ? -4 : 0;

    g.save();
    g.translate(x, y);

    const glow = g.createRadialGradient(0, 0, 8, 0, 0, scleraR * 1.55);
    glow.addColorStop(0, "rgba(255, 179, 71, 0.16)");
    glow.addColorStop(1, "rgba(255, 179, 71, 0)");
    g.fillStyle = glow;
    g.beginPath();
    g.arc(0, 0, scleraR * 1.55, 0, Math.PI * 2);
    g.fill();

    g.beginPath();
    g.ellipse(0, 0, scleraR, scleraRy, 0, 0, Math.PI * 2);
    g.fillStyle = "#3a2e1c";
    g.fill();
    g.strokeStyle = "rgba(255, 196, 120, 0.7)";
    g.lineWidth = 3;
    g.stroke();

    if (open > 0.08) {
      g.save();
      g.beginPath();
      g.ellipse(0, 0, scleraR - 2, clipRy, 0, 0, Math.PI * 2);
      g.clip();

      const iris = g.createRadialGradient(gazeX, gazeY, pupilR * 0.4, gazeX, gazeY, irisR);
      iris.addColorStop(0, "#ffd27a");
      iris.addColorStop(0.45, "#e0912c");
      iris.addColorStop(0.82, "#9a5814");
      iris.addColorStop(1, "#3d220c");
      g.beginPath();
      g.arc(gazeX, gazeY, irisR, 0, Math.PI * 2);
      g.fillStyle = iris;
      g.fill();

      g.beginPath();
      g.arc(gazeX, gazeY, pupilR, 0, Math.PI * 2);
      g.fillStyle = "#070503";
      g.fill();

      g.beginPath();
      g.arc(gazeX - irisR * 0.28, gazeY - irisR * 0.3, irisR * 0.14, 0, Math.PI * 2);
      g.fillStyle = "rgba(255, 244, 220, 0.72)";
      g.fill();
      g.restore();
    }

    if (open < 0.98) {
      const lid = (1 - open) * lidMax;
      g.fillStyle = "#000000";
      g.fillRect(-scleraR - 4, -lidMax - 6, (scleraR + 4) * 2, lid + 6);
      g.fillRect(-scleraR - 4, lidMax - lid, (scleraR + 4) * 2, lid + 6);
    }

    g.restore();
  }

  private drawBrows(cx: number, eyeY: number, offset: number): void {
    const g = this.ctx;
    const lift =
      this.face === "surprised" || this.face === "curious"
        ? -14
        : this.face === "sad" || this.face === "empathetic"
          ? 8
          : this.face === "angry" || this.face === "frown"
            ? 6
            : 0;
    const slope =
      this.face === "angry" || this.face === "frown"
        ? 11
        : this.face === "sad" || this.face === "empathetic"
          ? -8
          : this.face === "curious"
            ? 6
            : 0;

    g.strokeStyle = "rgba(255, 196, 120, 0.55)";
    g.lineWidth = 6;
    g.lineCap = "round";
    const browW = 43;
    const browY = 94;
    const browPeak = 110;
    for (const side of [-1, 1] as const) {
      const extra = this.face === "curious" && side === -1 ? -10 : 0;
      const x = cx + side * offset;
      g.beginPath();
      g.moveTo(x - browW, eyeY - browY + lift + side * slope + extra);
      g.quadraticCurveTo(x, eyeY - browPeak + lift + extra, x + browW, eyeY - browY + lift - side * slope + extra);
      g.stroke();
    }
  }
}

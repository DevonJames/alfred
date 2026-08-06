import type { VadSignal } from "@alfred/contracts";

/**
 * Lightweight energy VAD for immediate barge-in evidence.
 * Not turn policy — Flux/core still own end-of-turn decisions.
 */
export class EnergyVad {
  private speaking = false;
  private consecutiveSpeech = 0;
  private consecutiveSilence = 0;

  constructor(
    private readonly opts: {
      /** RMS threshold on Int16 PCM (0–32768). */
      threshold?: number;
      speechFrames?: number;
      silenceFrames?: number;
    } = {},
  ) {}

  /**
   * @returns VadSignal when state changes, otherwise undefined.
   */
  process(pcm: Int16Array, atMs: number): VadSignal | undefined {
    const threshold = this.opts.threshold ?? 500;
    const speechNeed = this.opts.speechFrames ?? 3;
    const silenceNeed = this.opts.silenceFrames ?? 8;

    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i] ?? 0;
      sum += s * s;
    }
    const rms = pcm.length ? Math.sqrt(sum / pcm.length) : 0;
    const active = rms >= threshold;

    if (active) {
      this.consecutiveSpeech += 1;
      this.consecutiveSilence = 0;
    } else {
      this.consecutiveSilence += 1;
      this.consecutiveSpeech = 0;
    }

    if (!this.speaking && this.consecutiveSpeech >= speechNeed) {
      this.speaking = true;
      return { speaking: true, confidence: Math.min(1, rms / 4000), atMs };
    }
    if (this.speaking && this.consecutiveSilence >= silenceNeed) {
      this.speaking = false;
      return { speaking: false, confidence: 0.8, atMs };
    }
    return undefined;
  }

  reset(): void {
    this.speaking = false;
    this.consecutiveSpeech = 0;
    this.consecutiveSilence = 0;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }
}

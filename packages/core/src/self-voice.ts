import type { AudioFrame } from "@alfred/contracts";

const DEFAULT_TARGET_RATE = 16_000;
/** Keep ~1.5s of reference audio at 16 kHz. */
const DEFAULT_MAX_REF_SAMPLES = 24_000;
/** Mic analysis window (~40 ms @ 16 kHz). */
const DEFAULT_WINDOW = 640;
/** Search ±40 ms of lag for acoustic delay. */
const DEFAULT_MAX_LAG = 640;
const DEFAULT_THRESHOLD = 0.6;

export interface SelfVoiceGateOptions {
  /** Mic / analysis sample rate (Alfred inbound is 16 kHz). */
  targetSampleRate?: number;
  maxReferenceSamples?: number;
  windowSamples?: number;
  maxLagSamples?: number;
  /** NCC score above this ⇒ treat mic as self-echo. */
  threshold?: number;
  /** When false, isSelfEcho always returns false. */
  enabled?: boolean;
  /** Clock for cooldown (ms). Defaults to Date.now. */
  nowMs?: () => number;
}

/**
 * Agent-side "know its own voice": compare inbound mic PCM to a ring buffer
 * of outbound TTS. High normalized cross-correlation ⇒ drop before STT.
 */
export class SelfVoiceGate {
  private readonly targetRate: number;
  private readonly maxRef: number;
  private readonly window: number;
  private readonly maxLag: number;
  private readonly threshold: number;
  private readonly enabled: boolean;
  private readonly nowMs: () => number;

  private ref: Float32Array;
  private refLen = 0;
  private armed = false;
  private armedUntilMs = 0;

  constructor(opts: SelfVoiceGateOptions = {}) {
    this.targetRate = opts.targetSampleRate ?? DEFAULT_TARGET_RATE;
    this.maxRef = opts.maxReferenceSamples ?? DEFAULT_MAX_REF_SAMPLES;
    this.window = opts.windowSamples ?? DEFAULT_WINDOW;
    this.maxLag = opts.maxLagSamples ?? DEFAULT_MAX_LAG;
    this.threshold =
      opts.threshold ??
      Number(process.env.ALFRED_SELF_VOICE_THRESHOLD ?? DEFAULT_THRESHOLD);
    this.enabled =
      opts.enabled ??
      (process.env.ALFRED_SELF_VOICE !== "0" && process.env.ALFRED_SELF_VOICE !== "false");
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.ref = new Float32Array(this.maxRef);
  }

  /** Begin treating high-similarity mic as self-echo. */
  arm(): void {
    this.armed = true;
    this.armedUntilMs = 0;
  }

  /**
   * Keep gating briefly after TTS ends (room echo), then auto-disarm.
   * Clears the speaking flag but retains the reference buffer.
   */
  armCooldown(ms: number): void {
    this.armed = true;
    this.armedUntilMs = this.nowMs() + Math.max(0, ms);
  }

  disarm(): void {
    this.armed = false;
    this.armedUntilMs = 0;
  }

  /** Drop reference audio (barge-in stop). */
  clear(): void {
    this.refLen = 0;
    this.disarm();
  }

  isArmed(): boolean {
    if (!this.enabled) return false;
    if (this.armedUntilMs > 0) {
      if (this.nowMs() < this.armedUntilMs) return true;
      this.armed = false;
      this.armedUntilMs = 0;
      return false;
    }
    return this.armed;
  }

  /** Append outbound TTS PCM (any sample rate; resampled to target). */
  pushReference(frame: AudioFrame): void {
    if (!this.enabled) return;
    const samples = frameToFloat32(frame, this.targetRate);
    if (samples.length === 0) return;

    if (this.refLen + samples.length <= this.maxRef) {
      this.ref.set(samples, this.refLen);
      this.refLen += samples.length;
      return;
    }

    // Shift left to make room.
    const keep = Math.max(0, this.maxRef - samples.length);
    if (keep > 0 && this.refLen > keep) {
      this.ref.copyWithin(0, this.refLen - keep, this.refLen);
      this.refLen = keep;
    } else if (samples.length >= this.maxRef) {
      this.ref.set(samples.subarray(samples.length - this.maxRef));
      this.refLen = this.maxRef;
      return;
    } else {
      this.refLen = 0;
    }
    this.ref.set(samples, this.refLen);
    this.refLen += samples.length;
  }

  /**
   * True when mic looks like a delayed/attenuated copy of recent TTS.
   * Real barge-ins (uncorrelated / louder novel speech) return false.
   */
  isSelfEcho(micFrame: AudioFrame): boolean {
    if (!this.isArmed() || this.refLen < this.window) return false;

    const mic = frameToFloat32(micFrame, this.targetRate);
    if (mic.length < this.window / 2) return false;

    // Use the loudest/latest mic window of `window` samples.
    const micWin = takeTailWindow(mic, this.window);
    const micRms = rms(micWin);
    if (micRms < 1e-4) return false; // silence — not useful as echo evidence

    const score = maxNormalizedCrossCorrelation(
      micWin,
      this.ref.subarray(0, this.refLen),
      this.maxLag,
    );
    return score >= this.threshold;
  }

  /** Test helper: current reference sample count at target rate. */
  get referenceSampleCount(): number {
    return this.refLen;
  }
}

function frameToFloat32(frame: AudioFrame, targetRate: number): Float32Array {
  const raw = uint8ToInt16(frame.data);
  if (raw.length === 0) return new Float32Array(0);
  const mono = toMono(raw, frame.channels ?? 1);
  const f = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) f[i] = mono[i]! / 32768;
  if (frame.sampleRate === targetRate) return f;
  return resampleLinear(f, frame.sampleRate, targetRate);
}

function uint8ToInt16(data: Uint8Array): Int16Array {
  if (data.byteOffset % 2 === 0) {
    return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Int16Array(copy.buffer);
}

function toMono(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const n = Math.floor(samples.length / channels);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c]!;
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/** Linear interpolation resampler. */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0]! * (1 - t) + input[i1]! * t;
  }
  return out;
}

function takeTailWindow(samples: Float32Array, window: number): Float32Array {
  if (samples.length <= window) return samples;
  return samples.subarray(samples.length - window);
}

function rms(x: Float32Array): number {
  if (x.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/**
 * Peak normalized cross-correlation of `probe` against `ref`,
 * searching lag in [0, maxLag] (probe delayed relative to ref start of each window).
 */
export function maxNormalizedCrossCorrelation(
  probe: Float32Array,
  ref: Float32Array,
  maxLag: number,
): number {
  const n = probe.length;
  if (n === 0 || ref.length < n) return 0;

  const probeMean = mean(probe);
  let probeVar = 0;
  for (let i = 0; i < n; i++) {
    const d = probe[i]! - probeMean;
    probeVar += d * d;
  }
  if (probeVar < 1e-12) return 0;
  const probeNorm = Math.sqrt(probeVar);

  let best = 0;
  const lastStart = ref.length - n;
  const step = Math.max(1, Math.floor(maxLag / 32)); // coarse then we'll check neighbors of peak
  let coarseBest = 0;
  let coarseLag = 0;

  for (let lag = 0; lag <= Math.min(maxLag, lastStart); lag += step) {
    const start = lastStart - lag;
    const score = nccAt(probe, probeMean, probeNorm, ref, start, n);
    if (score > coarseBest) {
      coarseBest = score;
      coarseLag = lag;
    }
  }

  const fineLo = Math.max(0, coarseLag - step);
  const fineHi = Math.min(maxLag, lastStart, coarseLag + step);
  for (let lag = fineLo; lag <= fineHi; lag++) {
    const start = lastStart - lag;
    const score = nccAt(probe, probeMean, probeNorm, ref, start, n);
    if (score > best) best = score;
  }
  return best;
}

function nccAt(
  probe: Float32Array,
  probeMean: number,
  probeNorm: number,
  ref: Float32Array,
  start: number,
  n: number,
): number {
  let refMean = 0;
  for (let i = 0; i < n; i++) refMean += ref[start + i]!;
  refMean /= n;

  let cross = 0;
  let refVar = 0;
  for (let i = 0; i < n; i++) {
    const pd = probe[i]! - probeMean;
    const rd = ref[start + i]! - refMean;
    cross += pd * rd;
    refVar += rd * rd;
  }
  if (refVar < 1e-12) return 0;
  return cross / (probeNorm * Math.sqrt(refVar));
}

function mean(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]!;
  return s / x.length;
}

/** Build an Int16 LE AudioFrame from float samples in [-1, 1]. */
export function floatToAudioFrame(
  samples: Float32Array,
  sampleRate: number,
): AudioFrame {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = Math.round(v * 32767);
  }
  return {
    data: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    sampleRate,
    channels: 1,
    samplesPerChannel: samples.length,
  };
}

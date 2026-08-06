import { describe, expect, it } from "vitest";
import {
  SelfVoiceGate,
  floatToAudioFrame,
  maxNormalizedCrossCorrelation,
  resampleLinear,
} from "./self-voice.js";

function tone(freq: number, seconds: number, rate: number, amp = 0.4): Float32Array {
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return out;
}

function noise(n: number, amp = 0.3): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (Math.random() * 2 - 1);
  return out;
}

describe("resampleLinear", () => {
  it("preserves length ratio 24k→16k", () => {
    const in24 = tone(440, 0.05, 24_000);
    const out16 = resampleLinear(in24, 24_000, 16_000);
    expect(out16.length).toBeCloseTo(in24.length * (16_000 / 24_000), -1);
  });
});

describe("maxNormalizedCrossCorrelation", () => {
  it("scores identical signals near 1", () => {
    const a = tone(440, 0.04, 16_000);
    expect(maxNormalizedCrossCorrelation(a, a, 100)).toBeGreaterThan(0.95);
  });

  it("scores delayed copy highly", () => {
    const src = tone(330, 0.2, 16_000);
    const delay = 200;
    const ref = new Float32Array(src.length + delay);
    ref.set(src, 0);
    const probe = src.slice(0, 640);
    // probe matches ref starting at 0; also try with lag
    expect(maxNormalizedCrossCorrelation(probe, ref, 400)).toBeGreaterThan(0.9);
  });
});

describe("SelfVoiceGate", () => {
  it("flags identical / delayed TTS copy as self-echo", () => {
    const gate = new SelfVoiceGate({
      enabled: true,
      threshold: 0.55,
      nowMs: () => 0,
    });
    const tts = tone(440, 0.5, 24_000);
    gate.pushReference(floatToAudioFrame(tts, 24_000));
    gate.arm();

    // Mic hears a delayed, quieter copy at 16 kHz (as LiveKit delivers).
    const tts16 = resampleLinear(tts, 24_000, 16_000);
    const delay = 320;
    const mic = new Float32Array(delay + 800);
    for (let i = 0; i < 800; i++) mic[delay + i] = tts16[i]! * 0.5;

    expect(gate.isSelfEcho(floatToAudioFrame(mic, 16_000))).toBe(true);
  });

  it("does not flag uncorrelated speech/noise", () => {
    const gate = new SelfVoiceGate({
      enabled: true,
      threshold: 0.55,
      nowMs: () => 0,
    });
    gate.pushReference(floatToAudioFrame(tone(440, 0.5, 24_000), 24_000));
    gate.arm();

    const mic = tone(1200, 0.05, 16_000, 0.5);
    // Different frequency + phase — should be well below threshold.
    // Add noise so it's clearly novel.
    const mixed = noise(mic.length, 0.4);
    for (let i = 0; i < mic.length; i++) mixed[i] = mixed[i]! * 0.5 + mic[i]! * 0.5;

    expect(gate.isSelfEcho(floatToAudioFrame(mixed, 16_000))).toBe(false);
  });

  it("does not flag louder novel speech mixed over a weak echo", () => {
    const gate = new SelfVoiceGate({
      enabled: true,
      threshold: 0.55,
      nowMs: () => 0,
    });
    const tts = tone(440, 0.5, 24_000);
    gate.pushReference(floatToAudioFrame(tts, 24_000));
    gate.arm();

    const tts16 = resampleLinear(tts, 24_000, 16_000);
    const novel = tone(900, 0.05, 16_000, 0.7);
    const mic = new Float32Array(novel.length);
    for (let i = 0; i < novel.length; i++) {
      mic[i] = novel[i]! + tts16[i]! * 0.08;
    }

    expect(gate.isSelfEcho(floatToAudioFrame(mic, 16_000))).toBe(false);
  });

  it("returns false when disarmed or disabled", () => {
    const gate = new SelfVoiceGate({ enabled: true, threshold: 0.5, nowMs: () => 0 });
    const tts = tone(440, 0.3, 24_000);
    gate.pushReference(floatToAudioFrame(tts, 24_000));
    const mic = floatToAudioFrame(resampleLinear(tts, 24_000, 16_000).subarray(0, 800), 16_000);

    expect(gate.isSelfEcho(mic)).toBe(false); // not armed
    gate.arm();
    expect(gate.isSelfEcho(mic)).toBe(true);
    gate.clear();
    expect(gate.isSelfEcho(mic)).toBe(false);

    const off = new SelfVoiceGate({ enabled: false, nowMs: () => 0 });
    off.pushReference(floatToAudioFrame(tts, 24_000));
    off.arm();
    expect(off.isSelfEcho(mic)).toBe(false);
  });

  it("armCooldown expires", () => {
    let t = 1000;
    const gate = new SelfVoiceGate({
      enabled: true,
      threshold: 0.5,
      nowMs: () => t,
    });
    const tts = tone(440, 0.3, 24_000);
    gate.pushReference(floatToAudioFrame(tts, 24_000));
    gate.armCooldown(500);
    const mic = floatToAudioFrame(resampleLinear(tts, 24_000, 16_000).subarray(0, 800), 16_000);
    expect(gate.isSelfEcho(mic)).toBe(true);
    t = 1600;
    expect(gate.isArmed()).toBe(false);
    expect(gate.isSelfEcho(mic)).toBe(false);
  });
});

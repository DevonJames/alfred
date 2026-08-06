import { describe, expect, it } from "vitest";
import { EnergyVad } from "./energy-vad.js";

function tone(amplitude: number, samples = 320): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = amplitude;
  return out;
}

describe("EnergyVad", () => {
  it("transitions to speaking then silence", () => {
    const vad = new EnergyVad({ threshold: 500, speechFrames: 2, silenceFrames: 2 });
    expect(vad.process(tone(100), 0)).toBeUndefined();
    expect(vad.process(tone(2000), 10)?.speaking).toBeUndefined(); // first speech frame
    expect(vad.process(tone(2000), 20)?.speaking).toBe(true);
    expect(vad.process(tone(0), 30)).toBeUndefined();
    expect(vad.process(tone(0), 40)?.speaking).toBe(false);
  });
});

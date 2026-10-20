import { describe, expect, it } from "vitest";
import { evaluateMath, speakMath } from "./math.js";

describe("evaluateMath", () => {
  it("adds the daily hour totals the model mis-added", () => {
    expect(evaluateMath("9.75 + 10.75 + 8 + 9 + 9 + 9.5")).toBe(56);
    expect(speakMath("9.75 + 10.75 + 8 + 9 + 9 + 9.5")).toBe("That's 56.");
  });

  it("respects parentheses and rejects anything that is not arithmetic", () => {
    expect(evaluateMath("(2 + 3) * 4")).toBe(20);
    expect(evaluateMath("10 / 4")).toBe(2.5);
    expect(evaluateMath("1 / 0")).toBeNull();
    expect(evaluateMath("alert(1)")).toBeNull();
    expect(evaluateMath("9 hours + 10")).toBeNull();
  });
});

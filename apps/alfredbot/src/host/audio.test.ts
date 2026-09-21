import { describe, expect, it } from "vitest";
import { parseAudioSource, resolveAudioSource } from "./audio.js";

describe("resolveAudioSource", () => {
  it("defaults to phone so the broken local driver stays off", () => {
    expect(resolveAudioSource(undefined)).toBe("phone");
    expect(resolveAudioSource("")).toBe("phone");
    expect(resolveAudioSource("phone")).toBe("phone");
    expect(parseAudioSource("nope")).toBeNull();
  });

  it("opt-in local speakers with ALFREDBOT_AUDIO=local", () => {
    expect(resolveAudioSource(undefined, "local")).toBe("local");
    expect(resolveAudioSource(undefined, " LOCAL ")).toBe("local");
  });

  it("lets the phone override the env default", () => {
    expect(resolveAudioSource("local", "phone")).toBe("local");
    expect(resolveAudioSource("phone", "local")).toBe("phone");
  });
});

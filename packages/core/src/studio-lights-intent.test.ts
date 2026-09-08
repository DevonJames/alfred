import { describe, expect, it } from "vitest";
import { looksLikeStudioLightsTask, parseStudioLightIntent } from "./studio-lights-intent.js";

describe("parseStudioLightIntent", () => {
  it("turns a room light on", () => {
    expect(parseStudioLightIntent("Hey Alfred, I'd like you to turn on my bedroom light, please.")).toEqual({
      action: "on",
      target: "bedroom",
      brightness: undefined,
      temperature: undefined,
    });
  });

  it("turns all lights on", () => {
    expect(parseStudioLightIntent("Alfred, I would like you to turn on all my lights, please.")).toEqual({
      action: "on",
      target: undefined,
      brightness: undefined,
      temperature: undefined,
    });
  });

  it("turns everything off", () => {
    expect(parseStudioLightIntent("Can you turn off the lights, please?")).toEqual({
      action: "off",
      target: undefined,
      brightness: undefined,
      temperature: undefined,
    });
    expect(parseStudioLightIntent("Turn off all of them, please.")).toEqual({
      action: "off",
      target: undefined,
      brightness: undefined,
      temperature: undefined,
    });
  });

  it("handles up, down, warm, and cool", () => {
    expect(parseStudioLightIntent("lights down")).toMatchObject({ action: "dimmer" });
    expect(parseStudioLightIntent("make the lights brighter")).toMatchObject({ action: "brighter" });
    expect(parseStudioLightIntent("make them warmer")).toMatchObject({ action: "warmer" });
    expect(parseStudioLightIntent("living room cooler")).toMatchObject({
      action: "cooler",
      target: "living room",
    });
  });

  it("sets brightness and warmth together", () => {
    expect(parseStudioLightIntent("bedroom at 30% warm")).toEqual({
      action: "set",
      target: "bedroom",
      brightness: 30,
      temperature: "warm",
    });
    expect(
      parseStudioLightIntent("Okay. Turn all the lights down to thirty percent and warm."),
    ).toEqual({
      action: "set",
      target: undefined,
      brightness: 30,
      temperature: "warm",
    });
    expect(parseStudioLightIntent("Please set them to thirty percent warm.")).toEqual({
      action: "set",
      target: undefined,
      brightness: 30,
      temperature: "warm",
    });
    expect(
      parseStudioLightIntent("Now turn all of them on at thirty percent brightness and warm."),
    ).toEqual({
      action: "set",
      target: undefined,
      brightness: 30,
      temperature: "warm",
    });
  });

  it("treats a bare Lights command as full cool white", () => {
    expect(parseStudioLightIntent("Lights")).toEqual({
      action: "set",
      brightness: 100,
      temperature: "white",
    });
    expect(parseStudioLightIntent("Hey Alfred, lights please.")).toEqual({
      action: "set",
      brightness: 100,
      temperature: "white",
    });
  });

  it("ignores talk about the tool name and unrelated speech", () => {
    expect(parseStudioLightIntent("Now you have a tool called Control Studio Lights.")).toBeNull();
    expect(looksLikeStudioLightsTask("what's the weather")).toBe(false);
    expect(looksLikeStudioLightsTask("highlight that paragraph")).toBe(false);
  });
});

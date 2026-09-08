import { describe, expect, it, vi } from "vitest";
import {
  formatLightSpeech,
  inventorySpeech,
  matchLights,
  nextState,
  parseStudioLightCommand,
  parseTemperature,
} from "./control.js";
import { controlStudioLights } from "./control.js";
import type { StudioLight } from "./types.js";

const bedroom: StudioLight = {
  id: "mini",
  name: "bedroom",
  productName: "Elgato Key Light Mini",
  host: "elgato-key-light-mini-2b28.local",
  port: 9123,
};
const living1: StudioLight = {
  id: "lr1",
  name: "living room 1",
  productName: "Elgato Key Light",
  host: "elgato-key-light-abcd.local",
  port: 9123,
};
const living2: StudioLight = {
  id: "lr2",
  name: "living room 2",
  productName: "Elgato Key Light",
  host: "elgato-key-light-9bad.local",
  port: 9123,
};
const inventory = [bedroom, living1, living2];

describe("matchLights", () => {
  it("defaults to all lights", () => {
    expect(matchLights(inventory).map((l) => l.name)).toEqual([
      "bedroom",
      "living room 1",
      "living room 2",
    ]);
  });

  it("matches a display name", () => {
    expect(matchLights(inventory, "bedroom").map((l) => l.name)).toEqual(["bedroom"]);
  });

  it("matches a room group", () => {
    expect(matchLights(inventory, "living room").map((l) => l.name)).toEqual([
      "living room 1",
      "living room 2",
    ]);
  });

  it("matches the mini by model", () => {
    expect(matchLights(inventory, "mini").map((l) => l.name)).toEqual(["bedroom"]);
  });
});

describe("temperature and nextState", () => {
  it("maps warm/cool words to Elgato mireds", () => {
    expect(parseTemperature("warm")).toBe(344);
    expect(parseTemperature("cool")).toBe(143);
    expect(parseTemperature(3200)).toBe(313);
  });

  it("turns on with optional brightness and warmth", () => {
    expect(
      nextState(
        { on: 0, brightness: 20, temperature: 200 },
        { action: "on", brightness: 30, temperature: "warm" },
      ),
    ).toEqual({ on: 1, brightness: 30, temperature: 344 });
  });

  it("steps brightness and temperature", () => {
    expect(nextState({ on: 1, brightness: 50, temperature: 213 }, { action: "brighter" })).toEqual({
      on: 1,
      brightness: 65,
    });
    expect(nextState({ on: 1, brightness: 50, temperature: 213 }, { action: "warmer" })).toEqual({
      on: 1,
      temperature: 253,
    });
  });
});

describe("speech", () => {
  it("summarizes matching lights", () => {
    expect(
      formatLightSpeech([
        { ...living1, state: { on: 1, brightness: 30, temperature: 344 } },
        { ...living2, state: { on: 1, brightness: 30, temperature: 344 } },
      ]),
    ).toBe("Both lights are on at 30 percent, warm.");
  });

  it("lists inventory by display name", () => {
    expect(inventorySpeech(inventory)).toContain("bedroom (Elgato Key Light Mini)");
    expect(inventorySpeech(inventory)).toContain("living room 1");
  });
});

describe("controlStudioLights", () => {
  it("turns matched lights on via PUT", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method || init.method === "GET") {
        return new Response(
          JSON.stringify({ numberOfLights: 1, lights: [{ on: 0, brightness: 20, temperature: 200 }] }),
          { status: 200 },
        );
      }
      expect(url).toContain("/elgato/lights");
      expect(init.method).toBe("PUT");
      const body = JSON.parse(String(init.body));
      expect(body.lights[0].on).toBe(1);
      expect(body.lights[0].brightness).toBe(30);
      return new Response(
        JSON.stringify({ numberOfLights: 1, lights: [{ on: 1, brightness: 30, temperature: 344 }] }),
        { status: 200 },
      );
    });

    const result = await controlStudioLights(
      { action: "on", target: "living room", brightness: 30, temperature: "warm" },
      { lights: inventory, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.snapshots).toHaveLength(2);
    expect(result.speech).toMatch(/on at 30 percent, warm/);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("explains an unknown target", async () => {
    const result = await controlStudioLights(
      { action: "off", target: "kitchen" },
      { lights: inventory, fetchImpl: vi.fn() as unknown as typeof fetch },
    );
    expect(result.speech).toMatch(/don't have a light called kitchen/i);
    expect(result.speech).toMatch(/bedroom/);
  });
});

describe("parseStudioLightCommand", () => {
  it("rejects a missing action", () => {
    expect(parseStudioLightCommand({})).toMatch(/wasn't sure/i);
  });

  it("accepts brightness as a string", () => {
    expect(parseStudioLightCommand({ action: "set", brightness: "40" })).toEqual({
      action: "set",
      target: undefined,
      brightness: 40,
      temperature: undefined,
    });
  });
});

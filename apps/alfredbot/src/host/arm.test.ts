import { describe, expect, it } from "vitest";
import { armStatus, runArmWave } from "./arm.js";

describe("runArmWave", () => {
  it("is a no-op on this Mac so we never open BLE here", async () => {
    const status = armStatus();
    expect(status.mocked).toBe(true);
    expect(status.waving).toBe(false);
    await expect(runArmWave()).resolves.toEqual({ ok: true });
  });
});

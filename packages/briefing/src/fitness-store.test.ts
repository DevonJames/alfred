import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FitnessStoreError, readFitnessDayPlan, readFitnessFocus, saveFitnessDayPlan, saveFitnessFocus } from "./fitness-store.js";

const plan = {
  date: "2026-10-14",
  timezone: "America/New_York",
  asOf: "2026-10-14T15:00:00.000Z",
  meals: [{ id: "b", name: "Greek yogurt", mealType: "breakfast", status: "scheduled" }],
  workouts: [{ id: "w", name: "Push day", status: "scheduled" }],
};

describe("fitness day plan store", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps the later snapshot and refuses an older one", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "alfred-fitness-"));
    await saveFitnessDayPlan(plan, dir);
    await saveFitnessDayPlan({ ...plan, asOf: "2026-10-14T16:00:00.000Z", meals: [] }, dir);
    const stored = await readFitnessDayPlan(dir);
    expect(stored?.meals).toEqual([]);
    await expect(
      saveFitnessDayPlan({ ...plan, asOf: "2026-10-14T15:30:00.000Z" }, dir),
    ).rejects.toBeInstanceOf(FitnessStoreError);
    expect((await readFitnessDayPlan(dir))?.asOf).toBe("2026-10-14T16:00:00.000Z");
  });

  it("drops a focus card after it expires", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "alfred-fitness-"));
    await saveFitnessFocus("device-1", { kind: "recipe", name: "Salmon" }, dir);
    const fresh = await readFitnessFocus("device-1", new Date(), dir);
    expect(fresh?.card.name).toBe("Salmon");
    const later = new Date(Date.now() + 16 * 60 * 1000);
    expect(await readFitnessFocus("device-1", later, dir)).toBeNull();
  });
});

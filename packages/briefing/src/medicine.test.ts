import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMedicineLog,
  attachDraftImages,
  emptyMedicineLog,
  formatMedicineSpeech,
  itemDueOn,
  mergeMedicineItems,
  mergeSummary,
  parseMedicineDrafts,
  untakenMorningItems,
  weekdayOfDayKey,
  type MedicineItem,
} from "./medicine.js";
import {
  readMedicineDayLog,
  readMedicineImage,
  saveMedicineImage,
  saveMedicineSchedule,
  storeMedicineLog,
} from "./medicine-store.js";

function item(partial: Partial<MedicineItem> & Pick<MedicineItem, "id" | "name">): MedicineItem {
  return {
    quantity: "1 capsule",
    period: "morning",
    instruction: "",
    days: "daily",
    labelText: "",
    needsReview: false,
    ...partial,
  };
}

describe("medicine schedule", () => {
  it("parses a fenced plan and flags a missing dose", () => {
    const drafts = parseMedicineDrafts(
      "```json\n" +
        JSON.stringify({
          items: [
            {
              name: "Vitamin D",
              quantity: "1 capsule",
              period: "morning",
              instruction: "with breakfast",
              days: "daily",
              labelText: "Vitamin D3 2000 IU",
              needsReview: false,
              imageIndex: 1,
            },
            { name: "Fish oil", period: "mid-day", days: "weekdays" },
          ],
        }) +
        "\n```",
    );
    expect(drafts).toEqual([
      {
        name: "Vitamin D",
        quantity: "1 capsule",
        period: "morning",
        instruction: "with breakfast",
        days: "daily",
        labelText: "Vitamin D3 2000 IU",
        needsReview: false,
        imageIndex: 1,
      },
      {
        name: "Fish oil",
        quantity: "",
        period: "midday",
        instruction: "",
        days: [1, 2, 3, 4, 5],
        labelText: "",
        needsReview: true,
        imageIndex: undefined,
      },
    ]);
  });

  it("merges by name and keeps items the note does not mention", () => {
    const existing = [
      item({ id: "d", name: "Vitamin D", quantity: "1 capsule", instruction: "with breakfast" }),
      item({ id: "fish", name: "Fish oil", period: "midday", quantity: "1 softgel" }),
    ];
    const result = mergeMedicineItems(
      existing,
      [
        {
          name: "vitamin d",
          quantity: "2 capsules",
          period: "evening",
          instruction: "",
          days: "daily",
          labelText: "D3",
          needsReview: false,
        },
        {
          name: "Magnesium glycinate",
          quantity: "2 tablets",
          period: "morning",
          instruction: "before 10am",
          days: "daily",
          labelText: "",
          needsReview: false,
        },
      ],
      (() => {
        let n = 0;
        return () => `new-${++n}`;
      })(),
    );
    expect(result.updated).toEqual(["Vitamin D"]);
    expect(result.added).toEqual(["Magnesium glycinate"]);
    expect(result.items.map((entry) => entry.name)).toEqual([
      "Vitamin D",
      "Fish oil",
      "Magnesium glycinate",
    ]);
    const vitamin = result.items[0];
    expect(vitamin?.quantity).toBe("2 capsules");
    expect(vitamin?.period).toBe("evening");
    expect(vitamin?.instruction).toBe("with breakfast");
    expect(mergeSummary(result.added, result.updated)).toBe(
      "Added Magnesium glycinate. Updated Vitamin D.",
    );
  });

  it("attaches the only photo when the draft omits an index", () => {
    const [draft] = attachDraftImages(
      [
        {
          name: "Vitamin D",
          quantity: "1 capsule",
          period: "morning" as const,
          instruction: "",
          days: "daily" as const,
          labelText: "",
          needsReview: false,
        },
      ],
      ["abc"],
    );
    expect(draft?.imageId).toBe("abc");
  });

  it("marks every morning item except one, and asks when the name is ambiguous", () => {
    const items = [
      item({ id: "d", name: "Vitamin D" }),
      item({ id: "mag", name: "Magnesium glycinate" }),
      item({ id: "fish", name: "Fish oil", period: "midday" }),
    ];
    const day = "2026-08-10";
    const marked = applyMedicineLog(
      items,
      emptyMedicineLog(day),
      { mode: "except", period: "morning", names: ["magnesium"] },
      day,
    );
    expect(marked.changed).toBe(true);
    expect(marked.log.entries.map((entry) => entry.itemId)).toEqual(["d"]);
    expect(marked.speech).toBe(
      "Marked the rest of your morning medicine taken, and left Magnesium glycinate untaken.",
    );

    const ambiguous = applyMedicineLog(
      [
        ...items,
        item({ id: "citrate", name: "Magnesium citrate" }),
      ],
      emptyMedicineLog(day),
      { mode: "except", names: ["magnesium"] },
      day,
    );
    expect(ambiguous.changed).toBe(false);
    expect(ambiguous.log.entries).toEqual([]);
    expect(ambiguous.speech).toBe(
      "Which magnesium did you mean: Magnesium glycinate and Magnesium citrate?",
    );
  });

  it("starts a new briefing day untaken", () => {
    const items = [item({ id: "d", name: "Vitamin D", instruction: "with breakfast" })];
    const taken = applyMedicineLog(items, emptyMedicineLog("2026-08-09"), { mode: "all" }, "2026-08-09");
    const morning = untakenMorningItems(items, taken.log, "2026-08-10");
    expect(morning.map((entry) => entry.id)).toEqual(["d"]);
    expect(formatMedicineSpeech(morning)).toBe(
      "Morning medicine: Vitamin D, 1 capsule, with breakfast.",
    );
    expect(formatMedicineSpeech([])).toBeNull();
    expect(untakenMorningItems(items, taken.log, "2026-08-09")).toEqual([]);
  });

  it("skips weekday items on Sunday", () => {
    expect(weekdayOfDayKey("2026-08-09")).toBe(0);
    expect(weekdayOfDayKey("2026-08-10")).toBe(1);
    const weekday = item({ id: "d", name: "Vitamin D", days: [1, 2, 3, 4, 5] });
    expect(itemDueOn(weekday, "2026-08-09")).toBe(false);
    expect(itemDueOn(weekday, "2026-08-10")).toBe(true);
  });
});

describe("medicine store", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("keeps yesterday's taken log off today", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-medicine-"));
    dirs.push(dir);
    const opts = { dir };
    await saveMedicineSchedule(
      [item({ id: "d", name: "Vitamin D" })],
      opts,
    );
    await storeMedicineLog(
      { mode: "all", period: "morning" },
      new Date("2026-08-10T15:00:00.000Z"),
      "America/Los_Angeles",
      "04:30",
      opts,
    );
    const yesterday = await readMedicineDayLog("2026-08-10", opts);
    expect(yesterday.entries).toEqual([{ itemId: "d", taken: true }]);
    const today = await storeMedicineLog(
      { mode: "status" },
      new Date("2026-08-11T15:00:00.000Z"),
      "America/Los_Angeles",
      "04:30",
      opts,
    );
    expect(today.dayKey).toBe("2026-08-11");
    expect(today.items[0]?.taken).toBe(false);
  });

  it("round-trips a bottle image", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-medicine-"));
    dirs.push(dir);
    const id = await saveMedicineImage(Buffer.from("not-a-real-image"), "image/png", { dir });
    const image = await readMedicineImage(id, { dir });
    expect(image?.mimeType).toBe("image/png");
    expect(image?.bytes.toString()).toBe("not-a-real-image");
  });
});

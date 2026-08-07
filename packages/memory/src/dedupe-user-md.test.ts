import { describe, expect, it } from "vitest";
import {
  dedupeUserMd,
  isRedundant,
  normalizeForDedupe,
} from "./dedupe-user-md.js";

describe("normalizeForDedupe / isRedundant", () => {
  it("matches emphasis variants", () => {
    expect(normalizeForDedupe("**Devon James**")).toBe("devon james");
    expect(
      isRedundant(
        normalizeForDedupe("Name: Devon James"),
        normalizeForDedupe("- **Name:** Devon James"),
      ),
    ).toBe(true);
  });

  it("detects high overlap paraphrases", () => {
    const a = normalizeForDedupe(
      "Wife Amy James. Son Matty born February 12, 2023. Parents Mike and Carol.",
    );
    const b = normalizeForDedupe(
      "Family: Wife Amy James. Son Matty born February 12, 2023. Parents Mike and Carol are involved.",
    );
    expect(isRedundant(a, b)).toBe(true);
  });
});

describe("dedupeUserMd", () => {
  it("drops exact and near-duplicate bullets across ingest blocks", () => {
    const input = `# USER.md

## Devon James

- **Name:** Devon James
- **Timezone:** America/Los_Angeles

<!-- alfred:ingest-export:chatgpt:start -->

## High-Priority Persistent Context

- Name: Devon James
- Timezone: America/Los_Angeles (PST/PDT)
- Building Alfred robot

## How to Work Effectively With Me

- Be direct. No sycophancy.

<!-- alfred:ingest-export:chatgpt:end -->

<!-- alfred:ingest-export:openclaw:start -->

## High-Priority Persistent Context

- Identity: Devon James
- Building the Alfred robot too
- Telegram: @DevonOfAlexandria

## How to Work Effectively With Me

- Be direct. No "Great question!" or sycophancy.

<!-- alfred:ingest-export:openclaw:end -->
`;

    const result = dedupeUserMd(input);
    expect(result.removedUnits).toBeGreaterThan(0);
    expect(result.afterChars).toBeLessThan(result.beforeChars);
    expect(result.text).toContain("Building Alfred");
    expect(result.text).toContain("Telegram");
    // Markers and headings preserved
    expect(result.text).toContain("alfred:ingest-export:chatgpt:start");
    expect(result.text).toContain("## How to Work Effectively With Me");
    // Should not keep three near-identical name lines
    const nameHits = result.text.match(/devon james/gi) ?? [];
    expect(nameHits.length).toBeLessThan(5);
  });

  it("preserves distinct facts", () => {
    const input = `# USER.md

- Son: Matty, born February 12, 2023
- Business: JF Customs
- Incoming USPTO role starting September 8, 2026
`;
    const result = dedupeUserMd(input);
    expect(result.removedUnits).toBe(0);
    expect(result.text).toMatch(/Matty/);
    expect(result.text).toMatch(/JF Customs/);
    expect(result.text).toMatch(/USPTO/);
  });
});

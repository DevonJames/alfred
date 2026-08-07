import { describe, expect, it } from "vitest";
import {
  INGEST_END,
  INGEST_START,
  mergeUserMd,
  parseMarkdownSections,
  planIngestExport,
} from "./ingest-export.js";

const SAMPLE = `# Comprehensive User Knowledge Export

Preamble ignored.

## Personal and Family Context

- Name: Devon James
- Wife: Amy James

### Son

- Matty, born February 12, 2023

## Active Projects

### Alfred:Home

Building an iOS household interface for OpenClaw.
Stack: Swift, LiveKit, Deepgram.

## 34. How to Work Effectively With Me

- Prefer concrete steps over lectures
- Separate facts from recommendations

## 37. High-Priority Persistent Context

- Software developer and solopreneur (JF Customs)
- Building Alfred voice + robot

## 38. Potentially Stale Information

- Old job application from 2024

## 39. Knowledge Gaps

- Exact GPU model unknown
`;

describe("parseMarkdownSections", () => {
  it("splits by ATX headings", () => {
    const sections = parseMarkdownSections(SAMPLE);
    expect(sections.some((s) => s.title === "Active Projects")).toBe(true);
    expect(sections.find((s) => s.title === "Alfred:Home")?.body).toMatch(/LiveKit/);
  });
});

describe("planIngestExport", () => {
  it("routes high-priority + how-to-work into USER patch", () => {
    const plan = planIngestExport(SAMPLE, { sourceLabel: "test.md" });
    expect(plan.userSectionsFound).toContain("High-Priority Persistent Context");
    expect(plan.userSectionsFound).toContain("How to Work Effectively With Me");
    expect(plan.userPatch).toContain(INGEST_START);
    expect(plan.userPatch).toContain("JF Customs");
    expect(plan.userPatch).toContain("Prefer concrete steps");
  });

  it("imports project/family details as memory notes and skips stale/gaps", () => {
    const plan = planIngestExport(SAMPLE, { sourceLabel: "test.md" });
    expect(plan.skippedSections).toEqual(
      expect.arrayContaining(["Potentially Stale Information", "Knowledge Gaps"]),
    );
    expect(plan.memoryRecords.length).toBeGreaterThan(2);
    expect(
      plan.memoryRecords.some((r) => /Devon James|Matty|Alfred:Home|LiveKit/i.test(r.content)),
    ).toBe(true);
    // User sections should not also become giant memory blobs
    expect(
      plan.memoryRecords.every(
        (r) => !String(r.metadata?.section ?? "").match(/High-Priority|How to Work/i),
      ),
    ).toBe(true);
  });
});

describe("mergeUserMd", () => {
  it("appends ingest block, then replaces on re-ingest", () => {
    const base = "# USER.md\n\n## Devon James\n\n- Name: Devon\n";
    const first = mergeUserMd(
      base,
      `${INGEST_START}\n\n## High-Priority Persistent Context\n\n- v1\n\n${INGEST_END}`,
    );
    expect(first).toContain("Devon James");
    expect(first).toContain("v1");

    const second = mergeUserMd(
      first,
      `${INGEST_START}\n\n## High-Priority Persistent Context\n\n- v2\n\n${INGEST_END}`,
    );
    expect(second).toContain("v2");
    expect(second).not.toContain("v1");
    expect(second).toContain("Devon James");
  });
});

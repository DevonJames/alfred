import { describe, expect, it } from "vitest";
import { fallbackNoteBriefMarkdown, plainNoteText, type NoteBriefDraft } from "./note-brief.js";

describe("note inbox brief helpers", () => {
  it("strips HTML, entities, and leftover URLs from remaining note text", () => {
    expect(
      plainNoteText(
        `<div>Keep this thought</div><a href="https://x.com/a/status/1">https://x.com/a/status/1</a>&nbsp;also`,
      ),
    ).toBe("Keep this thought also");
  });

  it("builds a catalog markdown brief from ingested and failed items", () => {
    const draft: NoteBriefDraft = {
      folder: "USPTO",
      note: "uspto job prep",
      archiveNote: "uspto job prep Ingested",
      remainingNoteText: "Prep interview stories",
      scannedAt: "2026-08-20T12:00:00.000Z",
      items: [
        {
          url: "https://x.com/ada/status/1",
          canonicalUrl: "https://x.com/i/status/1",
          status: "ingested",
          kind: "post",
          headline: "Notes on the analytical engine",
          author: "Ada Lovelace",
          summary: "The analytical engine weaves algebraic patterns.",
        },
        {
          url: "https://x.com/ada/status/paywall",
          canonicalUrl: "https://x.com/i/status/paywall",
          status: "failed",
          headline: "Secret memo",
          error: "paywall",
        },
      ],
    };
    const md = fallbackNoteBriefMarkdown(draft);
    expect(md).toMatch(/^# uspto job prep/m);
    expect(md).toContain("Prep interview stories");
    expect(md).toContain("Ada Lovelace — Notes on the analytical engine");
    expect(md).toContain("The analytical engine weaves algebraic patterns.");
    expect(md).toContain("Secret memo (paywall)");
  });
});

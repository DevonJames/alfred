import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./chunk.js";

describe("chunkMarkdown", () => {
  it("splits on ATX headings and keeps a preamble", () => {
    const md = `Intro lives here.

# Architecture

Alfred uses OIP memory.

## Ingest

Notes are scanned daily.

# Voice

LiveKit handles audio.
`;
    const chunks = chunkMarkdown(md, "guide.md");
    expect(chunks.map((c) => c.title)).toEqual([
      "guide",
      "Architecture",
      "Ingest",
      "Voice",
    ]);
    expect(chunks.find((c) => c.title === "Architecture")?.text).toMatch(/OIP memory/);
    expect(chunks.find((c) => c.title === "Ingest")?.text).toMatch(/scanned daily/);
  });

  it("does not split inside fenced code", () => {
    const fence = "```";
    const md = `# Example

${fence}ts
function foo() {

  return 1;
}
${fence}

After.
`;
    const chunks = chunkMarkdown(md, "code.md");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("function foo()");
    expect(chunks[0]?.text).toContain("After.");
  });
});

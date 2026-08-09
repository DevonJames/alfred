import { describe, expect, it } from "vitest";
import { extractPlainText, rtfToPlainText } from "./text-extract.js";

describe("text-extract", () => {
  it("passes through markdown", () => {
    const md = "# Hello\n\nWorld";
    const { text, kind } = extractPlainText(Buffer.from(md), "note.md");
    expect(kind).toBe("md");
    expect(text).toBe(md);
  });

  it("strips simple RTF", () => {
    const rtf = "{\\rtf1\\ansi Hello\\par world}";
    expect(rtfToPlainText(rtf)).toMatch(/Hello/);
    expect(rtfToPlainText(rtf)).toMatch(/world/);
    expect(rtfToPlainText(rtf)).not.toMatch(/rtf1/);
  });

  it("rejects unknown extensions", () => {
    expect(() => extractPlainText(Buffer.from("x"), "photo.png")).toThrow(/Unsupported/);
  });
});

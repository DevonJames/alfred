import { describe, expect, it } from "vitest";
import {
  formatPhotoMarkdown,
  isPhotoFilename,
  normalizePhotoAnalysis,
  parseJsonFromResponse,
  photoMimeFromFilename,
} from "./photo-analyze.js";

describe("photo-analyze helpers", () => {
  it("classifies common photo extensions", () => {
    expect(isPhotoFilename("shot.JPG")).toBe(true);
    expect(isPhotoFilename("note.heic")).toBe(true);
    expect(isPhotoFilename("brief.pdf")).toBe(false);
    expect(photoMimeFromFilename("scan.png")).toBe("image/png");
    expect(photoMimeFromFilename("scan.heic")).toBe("image/heic");
  });

  it("parses fenced JSON from a vision reply", () => {
    const parsed = parseJsonFromResponse(
      'Here you go:\n```json\n{"summary":"A receipt","fullText":"Total $12","names":["Cafe Nero"]}\n```\n',
    );
    expect(parsed.summary).toBe("A receipt");
    expect(parsed.fullText).toBe("Total $12");
  });

  it("falls back when the model returns prose", () => {
    const parsed = parseJsonFromResponse("No JSON here, just a description of a whiteboard.");
    expect(parsed.parseError).toBeTruthy();
    const normalized = normalizePhotoAnalysis(parsed, "No JSON here, just a description of a whiteboard.", "openai", "gpt-4o");
    expect(normalized.fullText).toMatch(/whiteboard/);
    expect(normalized.summary).toBeTruthy();
  });

  it("formats analysis as markdown for ingest", () => {
    const md = formatPhotoMarkdown("menu.jpg", {
      backend: "grok",
      model: "grok-2-vision-latest",
      summary: "A dinner menu",
      fullText: "Barolo 2016",
      handwrittenNotes: [{ content: "try this", location: "margin" }],
      names: ["Osteria"],
      dates: ["2016"],
      places: ["Piedmont"],
      objects: ["wine list"],
      documentType: "photo",
    });
    expect(md).toMatch(/# Photo: menu.jpg/);
    expect(md).toMatch(/Barolo 2016/);
    expect(md).toMatch(/Osteria/);
    expect(md).toMatch(/try this/);
  });
});

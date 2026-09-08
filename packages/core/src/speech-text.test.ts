import { describe, expect, it } from "vitest";
import {
  closeIncompleteMarkdown,
  revealMarkdownBySpeechProgress,
  stripMarkdownForSpeech,
} from "./speech-text.js";

describe("stripMarkdownForSpeech", () => {
  it("removes emphasis markers without dropping words", () => {
    expect(stripMarkdownForSpeech("Focus on a **small pilot** now")).toBe(
      "Focus on a small pilot now",
    );
  });

  it("strips headings and list markers", () => {
    expect(stripMarkdownForSpeech("### Action item\n- Build the pilot")).toBe(
      "Action item Build the pilot",
    );
  });

  it("unwraps links to their label", () => {
    expect(stripMarkdownForSpeech("See [docs](https://example.com) next")).toBe("See docs next");
  });
});

describe("closeIncompleteMarkdown / revealMarkdownBySpeechProgress", () => {
  it("closes trailing bold for mid-stream render", () => {
    expect(closeIncompleteMarkdown("Focus on a **small")).toBe("Focus on a **small**");
  });

  it("maps speech progress onto display markdown", () => {
    const display = "Say **hello** world";
    const speech = stripMarkdownForSpeech(display);
    expect(speech).toBe("Say hello world");
    const mid = revealMarkdownBySpeechProgress(display, speech, "Say hello".length);
    expect(display.startsWith(mid)).toBe(true);
    expect(mid.length).toBeGreaterThan(0);
  });
});

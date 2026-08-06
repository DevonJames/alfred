import { describe, expect, it } from "vitest";
import {
  extractBargeInText,
  hasInterruptCue,
  isConfidentBargeIn,
  isEchoTranscript,
  isNoisyReplay,
  looksIncompleteInterrupt,
  looksLikeAssistantEcho,
  normalizeForEcho,
} from "./echo-filter.js";

describe("looksLikeAssistantEcho / isEchoTranscript", () => {
  const spoken =
    "I'm Alfred — your digital butler and familiar. I'm here to help with planning.";

  it("matches exact and substring echoes", () => {
    expect(looksLikeAssistantEcho("I'm Alfred.", spoken)).toBe(true);
    expect(looksLikeAssistantEcho("your digital butler and familiar", spoken)).toBe(true);
  });

  it("matches garbled near-misses (Devin/Devon, debit/digital)", () => {
    expect(isEchoTranscript({ heard: "Devin.", assistantSpeech: "Loud and clear, Devon." })).toBe(
      true,
    );
    expect(isEchoTranscript({ heard: "to debit.", assistantSpeech: spoken })).toBe(true);
  });

  it("matches re-heard user turn while assistant answers", () => {
    expect(
      isEchoTranscript({
        heard: "Who are you exactly?",
        assistantSpeech: spoken,
        userTurn: "Alright. Who are you?",
      }),
    ).toBe(true);
  });

  it("treats explicit stop/say-the-word cues as barge-in", () => {
    expect(
      isConfidentBargeIn({
        heard: "Hey. I want you to stop talking and say the word blue, please.",
        assistantSpeech: spoken,
      }),
    ).toBe(true);
  });

  it("detects hold-up / say-blue even when glued onto assistant echo", () => {
    const heard =
      "I'm Alfred, your digital butler. Hey. I wanna hold hold up hold up, buddy. Can you say the blue?";
    expect(
      isConfidentBargeIn({
        heard,
        assistantSpeech:
          "I'm Alfred — your digital butler: capable, discreet, and occasionally opinionated.",
        userTurn: "You, and who am I?",
      }),
    ).toBe(true);
    expect(
      isEchoTranscript({
        heard,
        assistantSpeech:
          "I'm Alfred — your digital butler: capable, discreet, and occasionally opinionated.",
      }),
    ).toBe(false);

    const cleaned = extractBargeInText({
      heard,
      assistantSpeech:
        "I'm Alfred — your digital butler: capable, discreet, and occasionally opinionated.",
    });
    expect(cleaned.toLowerCase()).toMatch(/hold up|say the blue/);
    expect(cleaned.toLowerCase()).not.toMatch(/^i'?m alfred/);
  });

  it("strips trailing assistant echo after the interrupt ask", () => {
    const cleaned = extractBargeInText({
      heard: "Hold on. Hold on. Say red, please. Competent. Maintain standards.",
      assistantSpeech:
        "I'm Alfred — your digital butler and familiar: competent, warm, and occasionally dry. Maintain standards when it matters.",
    });
    expect(cleaned.toLowerCase()).toMatch(/say red/);
    expect(cleaned.toLowerCase()).not.toMatch(/maintain standards/);
  });

  it("allows a genuine long barge-in", () => {
    expect(
      isConfidentBargeIn({
        heard: "stop actually book a flight to Seattle tonight",
        assistantSpeech: spoken,
        userTurn: "Who are you?",
      }),
    ).toBe(true);
    expect(
      isEchoTranscript({
        heard: "stop actually book a flight to Seattle tonight",
        assistantSpeech: spoken,
      }),
    ).toBe(false);
  });

  it("treats full replay + STT garbage tail as echo, not a barge-in", () => {
    const assistant =
      "I'm here to help run interference, organize, research, plan, build, and handle the tedious bits with competence.";
    const heard =
      "I'm here to help run interference, organize, research, plan, build, and handle the tedious bits with competence at discretion. I envy it was Devon that I meant";
    expect(
      isEchoTranscript({
        heard,
        assistantSpeech: assistant,
        userTurn: "Hi. Who are you?",
      }),
    ).toBe(true);
    expect(
      isConfidentBargeIn({
        heard,
        assistantSpeech: assistant,
        userTurn: "Hi. Who are you?",
      }),
    ).toBe(false);
  });

  it("normalizes punctuation", () => {
    expect(normalizeForEcho("Hello, Devon! 🎩")).toBe("hello devon");
  });

  it("flags incomplete interrupt fragments", () => {
    expect(looksIncompleteInterrupt("Alright. Hold on.")).toBe(true);
    expect(looksIncompleteInterrupt("Um, can you")).toBe(true);
    expect(looksIncompleteInterrupt("Um, can you say red, please?")).toBe(false);
    expect(looksIncompleteInterrupt("I want you to say red.")).toBe(false);
  });

  it("treats Alfred/Albert as the same for echo matching", () => {
    expect(
      isEchoTranscript({
        heard: "I'm Albert, your digital butler.",
        assistantSpeech: "I'm Alfred — your digital butler and familiar.",
      }),
    ).toBe(true);
  });

  it("rejects speakerphone garble of Devon James / developer as barge-in", () => {
    const assistant =
      "You're Devon James — a software developer and solopreneur, founder of JF Customs. You're building Alfred:Home and, rather ambitiously, the physical Alfred robot";
    const heard = "You would debit James as developers.";
    expect(isNoisyReplay(heard, assistant)).toBe(true);
    expect(isConfidentBargeIn({ heard, assistantSpeech: assistant })).toBe(false);
    expect(isEchoTranscript({ heard, assistantSpeech: assistant })).toBe(true);
    expect(hasInterruptCue(heard)).toBe(false);

    const fragment = "would debit James as";
    expect(isNoisyReplay(fragment, assistant)).toBe(true);
    expect(isConfidentBargeIn({ heard: fragment, assistantSpeech: assistant })).toBe(false);
  });

  it("still treats hold-on / say-red as an interrupt cue", () => {
    expect(hasInterruptCue("Hold on. Say red.")).toBe(true);
    expect(
      isConfidentBargeIn({
        heard: "Hold on. Say red.",
        assistantSpeech:
          "I'm Alfred — your digital butler: competent, warm, discreet, and occasionally dry.",
      }),
    ).toBe(true);
  });
});

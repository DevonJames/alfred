import { describe, expect, it } from "vitest";
import { acceptLiveTranscript } from "./speech-engine.js";

const reply = "Okay, Devon. Doing well. Systems nominal, standards maintained.";
const story =
  "Certainly, Mars has a volcano called Olympus Mons, the largest known volcano in the Solar System. It is about three times taller than Mount Everest.";

describe("acceptLiveTranscript", () => {
  it("keeps a real first question", () => {
    expect(acceptLiveTranscript("Hey Alfred, how are you doing?", "", "", false)).toBe(
      "Hey Alfred, how are you doing?",
    );
  });

  it("drops a replay of the assistant reply", () => {
    expect(acceptLiveTranscript(reply, reply, "Hey Alfred", false)).toBeNull();
    expect(
      acceptLiveTranscript(
        "Good, Devon. Doing well. Systems nominal, standards maintained.",
        reply,
        "Hey Alfred",
        true,
      ),
    ).toBeNull();
  });

  it("keeps a follow-up glued onto the echoed reply once Alfred is quiet", () => {
    expect(
      acceptLiveTranscript(
        `${reply} Tell me an interesting factoid about Mars.`,
        reply,
        "Hey Alfred",
        false,
      ),
    ).toMatch(/factoid about mars/i);
  });

  it("drops speaker bleed of the story while Alfred is still talking", () => {
    expect(acceptLiveTranscript("What's a volcano?", story, "Tell me about Mars", true)).toBeNull();
    expect(
      acceptLiveTranscript(
        "What's a volcano? What does it mean?",
        story,
        "Tell me about Mars",
        true,
      ),
    ).toBeNull();
  });

  it("keeps a real follow-up while the echo guard is still up", () => {
    expect(
      acceptLiveTranscript(
        "Okay. Can you, um, give me my daily briefing now?",
        story,
        "Tell me about Olympus Mons",
        true,
      ),
    ).toMatch(/daily briefing/i);
  });

  it("keeps an explicit interrupt while Alfred is talking", () => {
    expect(
      acceptLiveTranscript("Hold on, tell me about the moon instead.", story, "Tell me about Mars", true),
    ).toMatch(/moon/i);
  });
});

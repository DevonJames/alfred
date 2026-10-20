import { describe, expect, it } from "vitest";
import type { Room } from "@livekit/rtc-node";
import { createRoomUiTranscriptPublisher } from "./ui-transcripts.js";

function publisher() {
  const events: Array<Record<string, unknown>> = [];
  const room = {
    localParticipant: {
      publishData: async (payload: Uint8Array) => {
        events.push(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
      },
    },
  };
  return {
    events,
    ui: createRoomUiTranscriptPublisher(() => room as unknown as Room),
  };
}

describe("structured caption hold", () => {
  it("keeps the briefing card up and drops the spoken word stream", () => {
    const { events, ui } = publisher();
    ui.beginCaption("Good morning. Fifty four degrees.", {
      layout: "briefing",
      display: { when: "Saturday", sections: [] },
    });
    ui.revealCaption("Good morning. Fifty four degrees and overcast.");
    ui.beginCaption("");
    ui.endCaption("complete");
    ui.resetAssistant();

    expect(events.map((event) => event.type)).toEqual(["start"]);
    expect(events[0]?.layout).toBe("briefing");
    expect(events[0]?.text).toBe("Good morning. Fifty four degrees.");
  });

  it("captions the next turn after the user speaks", () => {
    const { events, ui } = publisher();
    ui.beginCaption("Briefing.", {
      layout: "briefing",
      display: { when: "Saturday", sections: [] },
    });
    ui.releaseStructured();
    ui.beginCaption("");
    ui.revealCaption("Splendid.");

    expect(events.map((event) => event.type)).toEqual(["start", "start", "reveal"]);
    expect(events[2]?.text).toBe("Splendid.");
  });
});

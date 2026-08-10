import { describe, expect, it } from "vitest";
import { detectBriefingIntent } from "./intent.js";

describe("detectBriefingIntent", () => {
  it("matches explicit asks with natural phrasing", () => {
    expect(detectBriefingIntent("ok id like to hear the briefing now", false)).toBe(
      "explicitAsk",
    );
    expect(detectBriefingIntent("ok, ready for the briefing", false)).toBe("explicitAsk");
    expect(detectBriefingIntent("brief me bud", false)).toBe("explicitAsk");
    expect(detectBriefingIntent("breif me please", false)).toBe("explicitAsk");
    expect(detectBriefingIntent("give me the rundown", false)).toBe("explicitAsk");
  });

  it("ignores affirm/decline when no offer is pending", () => {
    expect(detectBriefingIntent("yes", false)).toBe("none");
    expect(detectBriefingIntent("no thanks", false)).toBe("none");
  });

  it("affirms or declines only when offer pending", () => {
    expect(detectBriefingIntent("yes", true)).toBe("affirmOffer");
    expect(detectBriefingIntent("sure", true)).toBe("affirmOffer");
    expect(detectBriefingIntent("go ahead", true)).toBe("affirmOffer");
    expect(detectBriefingIntent("no", true)).toBe("declineOffer");
    expect(detectBriefingIntent("not now", true)).toBe("declineOffer");
  });

  it("prefers explicit ask over affirm when both could match", () => {
    expect(detectBriefingIntent("yes, briefing please", true)).toBe("explicitAsk");
  });
});

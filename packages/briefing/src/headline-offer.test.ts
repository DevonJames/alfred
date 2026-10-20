import { describe, expect, it } from "vitest";
import { HEADLINE_OFFER_FALLBACK, postProcessHeadlineOffer } from "./headline-offer.js";

describe("postProcessHeadlineOffer", () => {
  it("keeps a short news question", () => {
    expect(postProcessHeadlineOffer("Want the latest headlines?")).toBe(
      "Want the latest headlines?",
    );
  });

  it("adds a question mark when missing", () => {
    expect(postProcessHeadlineOffer("Shall I read the news")).toBe("Shall I read the news?");
  });

  it("rejects off-topic or oversized drafts", () => {
    expect(postProcessHeadlineOffer("How is the weather looking?")).toBe(HEADLINE_OFFER_FALLBACK);
    expect(
      postProcessHeadlineOffer(
        "Would you like me to walk through every single headline from every source in exhaustive detail right now?",
      ),
    ).toBe(HEADLINE_OFFER_FALLBACK);
  });
});

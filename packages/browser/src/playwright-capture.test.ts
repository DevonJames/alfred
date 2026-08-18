import { describe, expect, it } from "vitest";
import { selectPrimaryTweet, toCapture, type PageExtract } from "./playwright-capture.js";

function tweet(partial: {
  href: string;
  text: string;
  author: string;
  handle: string;
  quotedText?: string;
}): PageExtract["tweets"][number] {
  return {
    text: partial.text,
    author: partial.author,
    handle: partial.handle,
    publishedAt: "2026-08-18T00:00:00.000Z",
    href: partial.href,
    images: [],
    isReply: false,
    quotedText: partial.quotedText,
    outbound: [],
  };
}

describe("selectPrimaryTweet", () => {
  it("picks the tweet whose status id matches the requested URL", () => {
    const parent = tweet({
      href: "https://x.com/polymarket/status/111",
      text: "JUST IN: 13 Penn State fraternity brothers",
      author: "Polymarket",
      handle: "Polymarket",
    });
    const reply = tweet({
      href: "https://x.com/swyx/status/222",
      text: "this is the reply I saved",
      author: "swyx",
      handle: "swyx",
    });
    const picked = selectPrimaryTweet([parent, reply], "https://x.com/swyx/status/222?s=12");
    expect(picked).toEqual(reply);
  });

  it("falls back to the first tweet when the page has no matching status", () => {
    const only = tweet({
      href: "https://x.com/ada/status/1",
      text: "hello",
      author: "Ada",
      handle: "ada",
    });
    expect(selectPrimaryTweet([only], "https://x.com/other/status/99")).toEqual(only);
  });
});

describe("toCapture", () => {
  it("attributes headline and author to the matched tweet, not the parent", () => {
    const extracted: PageExtract = {
      loginWall: false,
      paywall: false,
      tweets: [
        tweet({
          href: "https://x.com/polymarket/status/111",
          text: "JUST IN: 13 Penn State fraternity brothers charged",
          author: "Polymarket",
          handle: "Polymarket",
        }),
        tweet({
          href: "https://x.com/swyx/status/222",
          text: "this is the reply I saved",
          author: "swyx",
          handle: "swyx",
        }),
      ],
      pageText: "",
    };
    const capture = toCapture("https://x.com/swyx/status/222?s=12&t=abc", extracted);
    expect(capture.author).toBe("swyx");
    expect(capture.headline).toMatch(/reply I saved/);
    expect(capture.text).toMatch(/reply I saved/);
    expect(capture.text).not.toMatch(/Penn State/);
    expect(capture.canonicalUrl).toBe("https://x.com/i/status/222");
  });
});

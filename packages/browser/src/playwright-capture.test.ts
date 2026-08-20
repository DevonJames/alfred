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

  it("picks the reply by URL handle when every card's href is the parent permalink", () => {
    const parent = tweet({
      href: "https://x.com/elonmusk/status/111",
      text: "There is a potential future that is super amazing is we all fight hard to achieve it",
      author: "Elon Musk",
      handle: "elonmusk",
    });
    const reply = tweet({
      href: "https://x.com/elonmusk/status/111",
      text: "this is the quote I actually saved",
      author: "Vibe Marketer",
      handle: "vibemarketer_",
    });
    const url = "https://x.com/vibemarketer_/status/2089740376718610518?s=12";
    expect(selectPrimaryTweet([parent, reply], url)).toEqual(reply);
    const capture = toCapture(url, {
      loginWall: false,
      paywall: false,
      tweets: [parent, reply],
      pageText: "",
    });
    expect(capture.author).toBe("Vibe Marketer");
    expect(capture.headline).toMatch(/quote I actually saved/);
    expect(capture.headline).not.toMatch(/potential future/);
  });

  it("keeps the root tweet when the requested handle is the conversation author", () => {
    const root = tweet({
      href: "https://x.com/elonmusk/status/111",
      text: "root post",
      author: "Elon Musk",
      handle: "elonmusk",
    });
    const later = tweet({
      href: "https://x.com/elonmusk/status/111",
      text: "later in the thread",
      author: "Elon Musk",
      handle: "elonmusk",
    });
    expect(selectPrimaryTweet([root, later], "https://x.com/elonmusk/status/111")).toEqual(root);
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

import { describe, expect, it } from "vitest";
import {
  friendlyNavigationError,
  mergeTweetExtracts,
  selectPrimaryTweet,
  toCapture,
  tweetTextLooksTruncated,
  xNavigationUrls,
  type PageExtract,
} from "./playwright-capture.js";

function tweet(partial: {
  href: string;
  text: string;
  author: string;
  handle: string;
  quotedText?: string;
  statusIds?: string[];
}): PageExtract["tweets"][number] {
  return {
    text: partial.text,
    author: partial.author,
    handle: partial.handle,
    publishedAt: "2026-08-18T00:00:00.000Z",
    href: partial.href,
    statusIds: partial.statusIds ?? [],
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

  it("does not ingest the conversation parent when the saved tweet is missing", () => {
    const parent = tweet({
      href: "https://x.com/acme/status/111",
      text: "everyone I know is canceling software and rebuilding internally",
      author: "Acme",
      handle: "acme",
    });
    const otherReply = tweet({
      href: "https://x.com/random/status/333",
      text: "Oh I’d love to!",
      author: "Random",
      handle: "random",
    });
    const url = "https://x.com/tomgreenwald/status/2089475434903953561";
    expect(selectPrimaryTweet([parent, otherReply], url)).toBeUndefined();
    const capture = toCapture(url, {
      loginWall: false,
      paywall: false,
      tweets: [parent, otherReply],
      pageText: parent.text,
    });
    expect(capture.failure?.reason).toMatch(/could not find that post/);
    expect(capture.headline).not.toMatch(/canceling software/);
    expect(capture.text).toBe("");
  });

  it("falls back to the first tweet only for non-status pages", () => {
    const only = tweet({
      href: "https://x.com/ada/status/1",
      text: "hello",
      author: "Ada",
      handle: "ada",
    });
    expect(selectPrimaryTweet([only], "https://x.com/ada")).toEqual(only);
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

  it("matches the saved tweet when the status id is only on inner links", () => {
    const parent = tweet({
      href: "",
      statusIds: ["111"],
      text: "parent",
      author: "Elon Musk",
      handle: "elonmusk",
    });
    const reply = tweet({
      href: "",
      statusIds: ["222"],
      text: "this is the reply I saved",
      author: "swyx",
      handle: "swyx",
    });
    expect(selectPrimaryTweet([parent, reply], "https://x.com/swyx/status/222")).toEqual(reply);
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

  it("keeps the author's whole thread in page order", () => {
    const extracted: PageExtract = {
      loginWall: false,
      paywall: false,
      tweets: [
        tweet({
          href: "https://x.com/ada/status/1",
          text: "thread one",
          author: "Ada",
          handle: "ada",
        }),
        tweet({
          href: "https://x.com/ada/status/2",
          text: "thread two",
          author: "Ada",
          handle: "ada",
        }),
        tweet({
          href: "https://x.com/ada/status/3",
          text: "thread three",
          author: "Ada",
          handle: "ada",
        }),
      ],
      pageText: "",
    };
    const capture = toCapture("https://x.com/ada/status/2", extracted);
    expect(capture.kind).toBe("thread");
    expect(capture.headline).toMatch(/thread two/);
    expect(capture.text).toBe("thread one\n\nthread two\n\nthread three");
    expect(capture.posts).toHaveLength(3);
  });
});

describe("xNavigationUrls", () => {
  it("strips share-tracking query params before the first goto", () => {
    expect(xNavigationUrls("https://x.com/alexeixbt/status/2105420093727383922?s=20")).toEqual([
      "https://x.com/alexeixbt/status/2105420093727383922",
      "https://twitter.com/alexeixbt/status/2105420093727383922",
      "https://x.com/i/status/2105420093727383922",
    ]);
  });
});

describe("tweetTextLooksTruncated", () => {
  it("rejects collapsed X tweets that cut off mid-sentence", () => {
    expect(
      tweetTextLooksTruncated(
        "I knew I could think. I could not consistently translate the thing I understood into the thing I needed to produce every day of the week without a deadline forcing my hand the way a crisis always did when the work",
      ),
    ).toBe(true);
    expect(tweetTextLooksTruncated("You were never the problem. The missing diagnosis was.")).toBe(false);
  });
});

describe("mergeTweetExtracts", () => {
  it("keeps the longer expanded text for the same status id", () => {
    const short = tweet({
      href: "https://x.com/ada/status/2",
      text: "I could not consistently translate",
      author: "Ada",
      handle: "ada",
    });
    const full = tweet({
      href: "https://x.com/ada/status/2",
      text: "I could not consistently translate thinking into output without a deadline.",
      author: "Ada",
      handle: "ada",
    });
    const merged = mergeTweetExtracts([short], [full]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toMatch(/without a deadline/);
  });
});

describe("friendlyNavigationError", () => {
  it("does not surface Playwright call logs", () => {
    expect(
      friendlyNavigationError(
        new Error(
          'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at /Users/devon/... waiting until "domcontentloaded"',
        ),
      ),
    ).toMatch(/refused to load the post/);
    expect(
      friendlyNavigationError(
        new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at Call log:'),
      ),
    ).not.toMatch(/Call log|domcontentloaded|page\.goto/);
  });
});

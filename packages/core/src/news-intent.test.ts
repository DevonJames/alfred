import { describe, expect, it } from "vitest";
import { parseNewsIntent, resolveNewsArticleIndex } from "./news-intent.js";

describe("parseNewsIntent", () => {
  it("detects headline asks", () => {
    expect(parseNewsIntent("What's in the news?")).toEqual({ kind: "headlines" });
    expect(parseNewsIntent("Any headlines for me?")).toEqual({ kind: "headlines" });
    expect(parseNewsIntent("Catch me up on the news")).toEqual({ kind: "headlines" });
    expect(parseNewsIntent("Give me the top headlines")).toEqual({ kind: "headlines" });
  });

  it("detects article follow-ups by ordinal", () => {
    expect(parseNewsIntent("Tell me more about the second one")).toMatchObject({
      kind: "article",
      index: 2,
    });
    expect(parseNewsIntent("Summarize headline number 3")).toMatchObject({
      kind: "article",
      index: 3,
    });
  });

  it("detects article follow-ups by title fragment", () => {
    expect(parseNewsIntent('Dig into "Markets rally after Fed"')).toMatchObject({
      kind: "article",
      match: expect.stringMatching(/markets rally/i),
    });
  });

  it("ignores unrelated chat", () => {
    expect(parseNewsIntent("What's the weather?")).toBeNull();
    expect(parseNewsIntent("Turn on the lights")).toBeNull();
    expect(parseNewsIntent("Remind me to call Mom")).toBeNull();
  });

  it("resolves last against rundown length", () => {
    expect(resolveNewsArticleIndex({ kind: "article", index: -1 }, 4)).toEqual({ index: 4 });
  });
});

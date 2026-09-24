import { describe, expect, it } from "vitest";
import { parseMarketsIntent } from "./markets-intent.js";

describe("parseMarketsIntent", () => {
  it("detects bitcoin / crypto asks", () => {
    expect(parseMarketsIntent("What's the bitcoin price?")).toEqual({
      kind: "crypto",
      cryptoId: "bitcoin",
    });
    expect(parseMarketsIntent("How's BTC doing?")).toEqual({
      kind: "crypto",
      cryptoId: "bitcoin",
    });
    expect(parseMarketsIntent("Check ethereum for me")).toEqual({
      kind: "crypto",
      cryptoId: "ethereum",
    });
    expect(parseMarketsIntent("What's crypto at?")).toEqual({
      kind: "crypto",
      cryptoId: undefined,
    });
  });

  it("detects gold / silver asks", () => {
    expect(parseMarketsIntent("What's the gold price?")).toEqual({
      kind: "metals",
      metalSymbol: "gold",
    });
    expect(parseMarketsIntent("How's silver trading?")).toEqual({
      kind: "metals",
      metalSymbol: "silver",
    });
    expect(parseMarketsIntent("Check precious metals")).toEqual({
      kind: "metals",
      metalSymbol: "gold",
    });
  });

  it("ignores unrelated chat", () => {
    expect(parseMarketsIntent("What's the weather?")).toBeNull();
    expect(parseMarketsIntent("What's in the news?")).toBeNull();
    expect(parseMarketsIntent("Turn on the lights")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { extractFactsFromUserText } from "./fact-extractor.js";

describe("extractFactsFromUserText", () => {
  it("extracts name (cased and I'm forms)", () => {
    expect(extractFactsFromUserText("Hi, my name is Devon.")).toEqual([
      { sourceId: "fact:name", content: "User's name is Devon." },
    ]);
    expect(extractFactsFromUserText("I'm devon.")).toEqual([
      { sourceId: "fact:name", content: "User's name is Devon." },
    ]);
    expect(extractFactsFromUserText("Call me Alex.")[0]?.sourceId).toBe("fact:name");
  });

  it("extracts job/role", () => {
    const facts = extractFactsFromUserText("My job is software developer and solopreneur.");
    expect(facts.some((f) => f.sourceId === "fact:job")).toBe(true);
    expect(facts.find((f) => f.sourceId === "fact:job")?.content).toMatch(/software developer/i);
  });

  it("extracts preference and favorite", () => {
    const facts = extractFactsFromUserText("I prefer concise answers. My favorite color is teal.");
    expect(facts.some((f) => f.sourceId === "fact:preference")).toBe(true);
    expect(facts.some((f) => f.sourceId === "fact:favorite:color")).toBe(true);
  });

  it("extracts remember-that notes", () => {
    const facts = extractFactsFromUserText("Remember that the garage code is 1234");
    expect(facts[0]?.content).toMatch(/garage code is 1234/i);
  });

  it("extracts informed dates", () => {
    const facts = extractFactsFromUserText(
      "No. Not really. We'll have to feed you with August sixth, actually.",
    );
    expect(facts.some((f) => f.sourceId === "fact:today_date")).toBe(true);
  });

  it("does not treat Alfred self-echo as the user name", () => {
    expect(extractFactsFromUserText("I'm Alfred, your digital butler.")).toEqual([]);
    expect(extractFactsFromUserText("I'm Albert, your desk")).toEqual([]);
  });
});

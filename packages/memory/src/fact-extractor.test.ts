import { describe, expect, it } from "vitest";
import { extractFactsFromUserText } from "./fact-extractor.js";

describe("extractFactsFromUserText", () => {
  it("extracts name", () => {
    expect(extractFactsFromUserText("Hi, my name is Devon.")).toEqual([
      { sourceId: "fact:name", content: "User's name is Devon." },
    ]);
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
});

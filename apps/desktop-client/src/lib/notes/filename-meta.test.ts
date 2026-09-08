import { describe, expect, it } from "vitest";
import {
  heuristicFilenameMeta,
  titleFromSummary,
  uniqueNoteTitle,
} from "./filename-meta.js";

describe("heuristicFilenameMeta", () => {
  it("treats Home/Work plus a number as a place", () => {
    expect(heuristicFilenameMeta("Home 14.m4a")).toEqual({
      kind: "place",
      location: "Home",
      participants: [],
    });
    expect(heuristicFilenameMeta("Work-3.m4a")).toEqual({
      kind: "place",
      location: "Work",
      participants: [],
    });
  });

  it("treats number + street as an address", () => {
    const meta = heuristicFilenameMeta("123 Oak Street.m4a");
    expect(meta.kind).toBe("address");
    expect(meta.location).toMatch(/123 Oak Street/i);
  });

  it("treats Apple Maps venue names as places, not people", () => {
    expect(heuristicFilenameMeta("Sunset Plaza.m4a")).toEqual({
      kind: "place",
      location: "Sunset Plaza",
      participants: [],
    });
    expect(heuristicFilenameMeta("Pike Place Market.m4a").kind).toBe("place");
  });

  it("treats First Last as people", () => {
    expect(heuristicFilenameMeta("Sarah Chen.m4a")).toEqual({
      kind: "people",
      participants: ["Sarah Chen"],
    });
  });
});

describe("note titles", () => {
  it("uses the first sentence of the summary", () => {
    expect(titleFromSummary("Leaky kitchen faucet. Also talked about paint.", "Home 14")).toBe(
      "Leaky kitchen faucet",
    );
  });

  it("disambiguates colliding titles with location", () => {
    expect(uniqueNoteTitle("Leaky kitchen faucet", ["Leaky kitchen faucet"], "Home")).toBe(
      "Leaky kitchen faucet (Home)",
    );
  });
});

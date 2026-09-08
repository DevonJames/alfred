import { describe, expect, it } from "vitest";
import {
  expandDateSearchForms,
  matchesDateHaystack,
  parseDateQuery,
} from "./date-query.js";

describe("date-query", () => {
  it("parses month names and numeric forms the same", () => {
    expect(parseDateQuery("August")).toEqual({ month: 8, day: null, year: null });
    expect(parseDateQuery("08")).toEqual({ month: 8, day: null, year: null });
    expect(parseDateQuery("aug")).toEqual({ month: 8, day: null, year: null });
    expect(parseDateQuery("August 15")).toEqual({ month: 8, day: 15, year: null });
    expect(parseDateQuery("8/15")).toEqual({ month: 8, day: 15, year: null });
    expect(parseDateQuery("1985-08-15")).toEqual({ month: 8, day: 15, year: 1985 });
    expect(parseDateQuery("--08-15")).toEqual({ month: 8, day: 15, year: null });
  });

  it("expands August to include 08 forms", () => {
    const forms = expandDateSearchForms("August");
    expect(forms).toEqual(expect.arrayContaining(["august", "aug", "08", "-08-", "--08"]));
  });

  it("matches haystacks regardless of formatting", () => {
    const indexed = "Devon James birthday 1985-08-15 august 15th";
    expect(matchesDateHaystack(indexed, "August")).toBe(true);
    expect(matchesDateHaystack(indexed, "08")).toBe(true);
    expect(matchesDateHaystack(indexed, "August 15")).toBe(true);
    expect(matchesDateHaystack(indexed, "8/15/1985")).toBe(true);
    expect(matchesDateHaystack(indexed, "March")).toBe(false);

    expect(matchesDateHaystack("March 15 birthday --03-15", "March")).toBe(true);
    expect(matchesDateHaystack("March 15 birthday --03-15", "03")).toBe(true);
    expect(matchesDateHaystack("March 15 birthday --03-15", "August")).toBe(false);
  });
});

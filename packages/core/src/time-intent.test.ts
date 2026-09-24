import { describe, expect, it } from "vitest";
import { parseTimeIntent } from "./time-intent.js";

describe("parseTimeIntent", () => {
  it("detects a clock ask", () => {
    expect(parseTimeIntent("What time is it?")).toEqual({ kind: "time" });
    expect(parseTimeIntent("Alfred, do you have the time?")).toEqual({ kind: "time" });
    expect(parseTimeIntent("What's the time in Tokyo?")).toEqual({ kind: "time", place: "Tokyo" });
  });

  it("detects a date ask", () => {
    expect(parseTimeIntent("What's today's date?")).toEqual({ kind: "date" });
    expect(parseTimeIntent("What day is it?")).toEqual({ kind: "date" });
  });

  it("ignores scheduling and other subjects", () => {
    expect(parseTimeIntent("What time is the next launch?")).toBeNull();
    expect(parseTimeIntent("What time should I leave?")).toBeNull();
    expect(parseTimeIntent("What's the weather?")).toBeNull();
    expect(parseTimeIntent("What's bitcoin at?")).toBeNull();
  });
});

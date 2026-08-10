import { describe, expect, it } from "vitest";
import { postProcessGreeting } from "./greeting.js";

describe("postProcessGreeting", () => {
  it("keeps a short time-correct salutation", () => {
    expect(postProcessGreeting("Good evening, Devon.", "Good evening")).toBe(
      "Good evening, Devon",
    );
  });

  it("rejects morning when fallback is evening", () => {
    expect(postProcessGreeting("Good morning, Devon.", "Good evening")).toBe("Good evening");
  });

  it("rejects long intros that restate weather or date", () => {
    const bloated =
      "Good morning, Devon. It’s a clear Sunday, August 9th, with a crisp 62 degrees Fahrenheit outside—an excellent start to a relaxed day";
    expect(postProcessGreeting(bloated, "Good evening")).toBe("Good evening");
  });
});

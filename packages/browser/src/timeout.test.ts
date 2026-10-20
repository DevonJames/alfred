import { describe, expect, it } from "vitest";
import { withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("rejects when the work does not finish in time", async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, "too slow")).rejects.toThrow(/too slow/);
  });
});

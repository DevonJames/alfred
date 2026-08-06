import { describe, expect, it } from "vitest";
import { runAllScenarios } from "./scenarios.js";

describe("M1 simulator scenarios", () => {
  it("passes all 15 critical scenarios", async () => {
    const results = await runAllScenarios();
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      const detail = failed.map((f) => `${f.id} ${f.name}: ${f.detail}`).join("\n");
      expect.fail(detail);
    }
    expect(results).toHaveLength(15);
  }, 30_000);
});

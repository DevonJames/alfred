import { describe, expect, it } from "vitest";
import { applyPrivacyTighten } from "./desktop-settings.js";

describe("applyPrivacyTighten", () => {
  it("allows tightening and same mode", () => {
    expect(applyPrivacyTighten("user_managed", "private_hybrid")).toBe("private_hybrid");
    expect(applyPrivacyTighten("private_hybrid", "local_only")).toBe("local_only");
    expect(applyPrivacyTighten("local_only", "local_only")).toBe("local_only");
  });

  it("rejects loosening", () => {
    expect(applyPrivacyTighten("local_only", "private_hybrid")).toBeNull();
    expect(applyPrivacyTighten("private_hybrid", "user_managed")).toBeNull();
  });
});

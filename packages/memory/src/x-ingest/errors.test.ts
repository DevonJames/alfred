import { describe, expect, it } from "vitest";
import { sanitizeXIngestError } from "./errors.js";

describe("sanitizeXIngestError", () => {
  it("maps X HTTP navigation failures to a short reason", () => {
    const msg = sanitizeXIngestError(
      'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at /Users/devon/repo/node_modules/playwright-core/lib/client/page.js',
    );
    expect(msg).toMatch(/refused to load the post/);
    expect(msg).not.toMatch(/page\.goto|Call log|node_modules/);
  });

  it("maps a closed Playwright context to a Check-session warning", () => {
    expect(
      sanitizeXIngestError("browserContext.newPage: Target page, context or browser has been closed"),
    ).toMatch(/closed mid-scan|checking the X session/i);
  });
});

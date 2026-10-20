import { describe, expect, it } from "vitest";
import { xSessionHint } from "./session.js";

describe("xSessionHint", () => {
  it("tells the user to use a dedicated ingest account when logged out", () => {
    expect(xSessionHint({ loggedIn: false })).toMatch(/dedicated ingest account/i);
    expect(xSessionHint({ loggedIn: false, loginOpen: true })).toMatch(/close that browser window/i);
    expect(xSessionHint({ loggedIn: false, busy: true })).toMatch(/busy|scan/i);
    expect(xSessionHint({ loggedIn: true, handle: "alfrd_ingest" })).toMatch(/@alfrd_ingest/);
  });
});

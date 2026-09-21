import { describe, expect, it } from "vitest";
import { relayHeaders } from "./discovery.js";

describe("relayHeaders", () => {
  it("adds X-Cloud-Token only on relay URLs", () => {
    expect(relayHeaders("http://192.168.1.20:3000", "jwt")).toEqual({});
    expect(relayHeaders("https://api.alfrd.net/proxy/abc", "jwt")).toEqual({
      "X-Cloud-Token": "Bearer jwt",
    });
  });

  it("does not send a cloud header without a token", () => {
    expect(relayHeaders("https://api.alfrd.net/proxy/abc", null)).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import {
  buildClaimPayload,
  buildClaimUri,
  parseClaimQrPayload,
} from "./claim-payload.js";

describe("claim QR payload", () => {
  const sample = {
    serverId: "11111111-2222-4333-8444-555555555555",
    claimSecret: "ab12cd34",
    cloudUrl: "https://api.alfrd.net",
    name: "Alfred",
  };

  it("builds a deep-link URI with uppercased claim secret", () => {
    const uri = buildClaimUri(sample);
    expect(uri.startsWith("alfred://claim?")).toBe(true);
    expect(uri).toContain("serverId=11111111-2222-4333-8444-555555555555");
    expect(uri).toContain("claimSecret=AB12CD34");
    expect(uri).toContain("cloudUrl=https%3A%2F%2Fapi.alfrd.net");
  });

  it("round-trips URI through the parser", () => {
    const payload = buildClaimPayload(sample);
    const parsed = parseClaimQrPayload(payload.uri);
    expect(parsed).toEqual({
      serverId: sample.serverId,
      claimSecret: "AB12CD34",
      cloudUrl: sample.cloudUrl,
      name: sample.name,
    });
  });

  it("parses JSON QR payloads", () => {
    const payload = buildClaimPayload(sample);
    const parsed = parseClaimQrPayload(JSON.stringify(payload));
    expect(parsed?.serverId).toBe(sample.serverId);
    expect(parsed?.claimSecret).toBe("AB12CD34");
  });

  it("rejects unrelated strings", () => {
    expect(parseClaimQrPayload("https://example.com")).toBeNull();
    expect(parseClaimQrPayload("not-a-qr")).toBeNull();
    expect(parseClaimQrPayload('{"type":"other"}')).toBeNull();
  });
});

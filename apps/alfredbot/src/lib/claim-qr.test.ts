import { describe, expect, it } from "vitest";
import { normalizeSecret, parseClaimPayload } from "./claim-qr.js";

describe("parseClaimPayload", () => {
  const uri =
    "alfred://claim?v=1&serverId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&claimSecret=AB23CD45&cloudUrl=https%3A%2F%2Fapi.alfrd.net&name=Alfred";

  it("parses the desktop claim deep link", () => {
    expect(parseClaimPayload(uri)).toEqual({
      serverId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      claimSecret: "AB23CD45",
      cloudUrl: "https://api.alfrd.net",
      name: "Alfred",
    });
  });

  it("parses the JSON claim payload", () => {
    const raw = JSON.stringify({
      v: 1,
      type: "alfred.desktop.claim",
      serverId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      claimSecret: "ab23cd45",
      name: "Studio",
    });
    expect(parseClaimPayload(raw)?.claimSecret).toBe("AB23CD45");
    expect(parseClaimPayload(raw)?.name).toBe("Studio");
  });

  it("rejects a malformed secret or id", () => {
    expect(parseClaimPayload("alfred://claim?serverId=nope&claimSecret=AB23CD45")).toBeNull();
    expect(
      parseClaimPayload(
        "alfred://claim?serverId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&claimSecret=ABC",
      ),
    ).toBeNull();
  });

  it("strips spoken separators from the secret", () => {
    expect(normalizeSecret("ab 23-cd 45")).toBe("AB23CD45");
  });
});

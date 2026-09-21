import { describe, expect, it } from "vitest";
import { buildBotUri, parseBotPayload } from "./bot-qr.js";

const sample = {
  botId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  session: "11111111-2222-3333-4444-555555555555",
  hosts: ["http://192.168.1.20:3200"],
  name: "AlfredBot",
};

describe("bot QR payload", () => {
  it("round-trips the deep link", () => {
    const uri = buildBotUri(sample);
    expect(uri.startsWith("alfred://bot?")).toBe(true);
    expect(parseBotPayload(uri)).toEqual(sample);
  });

  it("parses JSON", () => {
    expect(parseBotPayload(JSON.stringify({ type: "alfred.bot.claim", ...sample }))).toEqual(sample);
  });

  it("rejects a desktop claim code", () => {
    expect(
      parseBotPayload(
        "alfred://claim?v=1&serverId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&claimSecret=AB23CD45",
      ),
    ).toBeNull();
  });
});

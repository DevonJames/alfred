import { describe, expect, it } from "vitest";
import { parseBotPayload } from "./bot-qr";
import { invertHeadStick, invertWheelStick } from "./robot-api";

const uri =
  "alfred://bot?v=1&botId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&session=11111111-2222-3333-4444-555555555555&hosts=http%3A%2F%2F192.168.1.20%3A3200&name=AlfredBot";

describe("parseBotPayload", () => {
  it("parses the robot claim deep link", () => {
    expect(parseBotPayload(uri)).toEqual({
      botId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      session: "11111111-2222-3333-4444-555555555555",
      hosts: ["http://192.168.1.20:3200"],
      name: "AlfredBot",
    });
  });

  it("rejects a Mac claim code", () => {
    expect(
      parseBotPayload(
        "alfred://claim?v=1&serverId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&claimSecret=AB23CD45"
      )
    ).toBeNull();
  });
});

describe("invertHeadStick", () => {
  it("swaps neck and roll left/right and leaves tilt", () => {
    expect(invertHeadStick({ neck: 0.5, tilt: 0.2, roll: -0.4 }, false)).toEqual({
      neck: 0.5,
      tilt: 0.2,
      roll: -0.4,
    });
    expect(invertHeadStick({ neck: 0.5, tilt: 0.2, roll: -0.4 }, true)).toEqual({
      neck: -0.5,
      tilt: 0.2,
      roll: 0.4,
    });
  });
});

describe("invertWheelStick", () => {
  it("swaps sides and inverts forward when facing the robot", () => {
    expect(invertWheelStick({ left: 1, right: 0.4 }, false)).toEqual({ left: 1, right: 0.4 });
    expect(invertWheelStick({ left: 1, right: 0.4 }, true)).toEqual({ left: -0.4, right: -1 });
  });
});

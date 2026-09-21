import { describe, expect, it } from "vitest";
import { needsWifiSetup, type WifiStatus } from "./wifi.js";

describe("needsWifiSetup", () => {
  const offline: WifiStatus = { connected: false, ssid: null, online: false, mock: false };
  const online: WifiStatus = { connected: true, ssid: "Lab", online: true, mock: false };

  it("asks for setup when there is no connection", () => {
    expect(needsWifiSetup(offline)).toBe(true);
  });

  it("skips setup when already connected", () => {
    expect(needsWifiSetup(online)).toBe(false);
  });
});

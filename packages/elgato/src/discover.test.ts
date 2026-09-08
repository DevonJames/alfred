import { describe, expect, it } from "vitest";
import {
  hostnameFromInstanceName,
  hostsFromEnv,
  lightLabel,
  mergeLights,
  parseDnsSdBrowse,
  parseDnsSdLookup,
} from "./discover.js";

describe("discover helpers", () => {
  it("parses dns-sd browse instance names", () => {
    const output = `
20:12:57.489  Add        3  16 local.               _elg._tcp.           Elgato Key Light Mini 2B28
20:12:57.489  Add        3  16 local.               _elg._tcp.           Elgato Key Light ABCD
`;
    expect(parseDnsSdBrowse(output)).toEqual([
      "Elgato Key Light Mini 2B28",
      "Elgato Key Light ABCD",
    ]);
  });

  it("parses dns-sd lookup host and port", () => {
    const output =
      "Elgato\\032Key\\032Light\\032Mini\\0322B28._elg._tcp.local. can be reached at elgato-key-light-mini-2b28.local.:9123 (interface 16)";
    expect(parseDnsSdLookup(output)).toEqual({
      host: "elgato-key-light-mini-2b28.local",
      port: 9123,
    });
  });

  it("prefers the Control Center display name", () => {
    expect(
      lightLabel({
        displayName: "bedroom",
        productName: "Elgato Key Light Mini",
        instanceName: "Elgato Key Light Mini 2B28",
      }),
    ).toBe("bedroom");
  });

  it("derives .local hosts from instance names", () => {
    expect(hostnameFromInstanceName("Elgato Key Light 9BAD")).toBe("elgato-key-light-9bad.local");
    expect(hostnameFromInstanceName("Elgato Key Light Mini 2B28")).toBe(
      "elgato-key-light-mini-2b28.local",
    );
  });

  it("keeps a previously seen light when a later browse misses it", () => {
    const merged = mergeLights(
      [
        {
          id: "lr2",
          name: "living room 2",
          productName: "Elgato Key Light",
          host: "elgato-key-light-9bad.local",
          port: 9123,
          serialNumber: "BW27L1B02312",
        },
      ],
      [
        {
          id: "lr1",
          name: "living room 1",
          productName: "Elgato Key Light",
          host: "elgato-key-light-abcd.local",
          port: 9123,
          serialNumber: "BW27L1B02229",
        },
      ],
    );
    expect(merged.map((light) => light.name)).toEqual(["living room 1", "living room 2"]);
  });

  it("reads ELGATO_LIGHT_HOSTS", () => {
    expect(hostsFromEnv({ ELGATO_LIGHT_HOSTS: "10.0.0.8,10.0.0.9:9123" })).toEqual([
      { host: "10.0.0.8", port: 9123 },
      { host: "10.0.0.9", port: 9123 },
    ]);
  });
});

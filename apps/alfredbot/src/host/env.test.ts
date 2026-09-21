import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env.js";

describe("parseEnvFile", () => {
  it("reads KEY=value and export KEY=value", () => {
    expect(parseEnvFile("ALFREDBOT_PORT=3200\nexport NAME=Bot\n")).toEqual({
      ALFREDBOT_PORT: "3200",
      NAME: "Bot",
    });
  });

  it("skips comments and blank lines", () => {
    expect(parseEnvFile("# hi\n\nFOO=bar\n")).toEqual({ FOO: "bar" });
  });

  it("strips matching quotes", () => {
    expect(parseEnvFile(`TOKEN="abc def"\n`)).toEqual({ TOKEN: "abc def" });
  });
});

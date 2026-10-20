import { describe, expect, it } from "vitest";
import { pidsFromPsOutput } from "./profile-lock.js";

describe("pidsFromPsOutput", () => {
  it("finds Chrome/Brave processes using the Alfred profile", () => {
    const dir = "/Users/devon/Documents/development/alfred/data/browser/alfred-profile";
    const stdout = [
      "  11 /usr/libexec/trustd",
      ` 422 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}`,
      ` 423 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/Current/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --user-data-dir=${dir}`,
      " 900 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].join("\n");
    expect(pidsFromPsOutput(stdout, dir)).toEqual([422, 423]);
  });
});

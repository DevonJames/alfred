import { describe, expect, it } from "vitest";
import { int16ToUint8, uint8ToInt16 } from "./pcm.js";

describe("pcm helpers", () => {
  it("round-trips int16 through uint8", () => {
    const original = new Int16Array([0, 1, -1, 32767, -32768]);
    const bytes = int16ToUint8(original);
    const back = uint8ToInt16(bytes);
    expect([...back]).toEqual([...original]);
  });
});

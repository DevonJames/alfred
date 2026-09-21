import { describe, expect, it } from "vitest";
import { nextAgentDispatchAction } from "./tokens.js";

describe("nextAgentDispatchAction", () => {
  it("skips only when a live phone conversation is already up", () => {
    expect(
      nextAgentDispatchAction({ hasDispatch: true, agentInRoom: true, phoneInRoom: true }),
    ).toBe("skip");
  });

  it("replaces a leftover agent after hangup (no phone in the room)", () => {
    expect(nextAgentDispatchAction({ hasDispatch: true, agentInRoom: true })).toBe("replace");
    expect(
      nextAgentDispatchAction({ hasDispatch: true, agentInRoom: true, phoneInRoom: false }),
    ).toBe("replace");
  });

  it("creates when the room has no dispatch and no agent", () => {
    expect(nextAgentDispatchAction({ hasDispatch: false, agentInRoom: false })).toBe("create");
  });

  it("replaces a leftover dispatch after the job has left", () => {
    expect(nextAgentDispatchAction({ hasDispatch: true, agentInRoom: false })).toBe("replace");
  });
});

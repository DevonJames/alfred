import { describe, expect, it } from "vitest";
import {
  isRobotConversation,
  markRobotConversation,
  robotConversationId,
} from "./robot-conversation.js";

describe("robot conversation flag", () => {
  it("increments id on each start so AlfredBot can rematch", () => {
    const before = robotConversationId();
    markRobotConversation(true);
    expect(isRobotConversation()).toBe(true);
    expect(robotConversationId()).toBe(before + 1);

    markRobotConversation(false);
    expect(isRobotConversation()).toBe(false);
    expect(robotConversationId()).toBe(before + 1);

    markRobotConversation(true);
    expect(isRobotConversation()).toBe(true);
    expect(robotConversationId()).toBe(before + 2);
  });
});

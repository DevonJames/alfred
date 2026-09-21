import { describe, expect, it } from "vitest";
import { AppleOnDeviceSTTProvider } from "./apple-stt.js";

describe("AppleOnDeviceSTTProvider", () => {
  it("reports unhealthy off darwin or without binary override via sessionFactory health", async () => {
    const provider = new AppleOnDeviceSTTProvider({
      binaryPath: "/nonexistent/alfred-apple-stt",
    });
    const health = await provider.healthCheck();
    if (process.platform !== "darwin") {
      expect(health.status).toBe("unhealthy");
      expect(health.failureClass).toBe("unavailable");
    } else {
      expect(health.status).toBe("unhealthy");
      expect(health.message).toMatch(/binary missing/i);
    }
  });

  it("streams injected session events", async () => {
    const provider = new AppleOnDeviceSTTProvider({
      sessionFactory: async () => ({
        pushAudio: () => undefined,
        close: async () => undefined,
        async *events() {
          yield { type: "start_of_turn", text: "hi", metadata: {} };
          yield { type: "end_of_turn", text: "hi", metadata: {} };
        },
      }),
    });
    const session = await provider.openSession();
    const types: string[] = [];
    for await (const ev of session.events()) types.push(ev.type);
    expect(types).toEqual(["start_of_turn", "end_of_turn"]);
  });
});

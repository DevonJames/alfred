import { describe, expect, it } from "vitest";
import { TranscriptThread } from "./transcript.js";

type StubEl = { className: string; textContent: string; innerHTML: string };

describe("TranscriptThread.load", () => {
  it("hydrates stored messages into the DOM", () => {
    const children: StubEl[] = [];
    const root = {
      scrollTop: 0,
      scrollHeight: 0,
      replaceChildren(...nodes: StubEl[]) {
        children.length = 0;
        children.push(...nodes);
      },
      appendChild(node: StubEl) {
        children.push(node);
      },
    } as unknown as HTMLElement;

    const created: StubEl[] = [];
    const original = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement(): StubEl {
          const el: StubEl = { className: "", textContent: "", innerHTML: "" };
          created.push(el);
          return el;
        },
      },
    });

    try {
      const thread = new TranscriptThread(root);
      created.length = 0;
      thread.load([
        { id: "m1", role: "user", text: "Good morning" },
        { id: "m2", role: "assistant", text: "Good morning — ready when you are." },
      ]);
      expect(created).toHaveLength(2);
      expect(created[0]?.className).toContain("bubble-user");
      expect(created[0]?.textContent).toBe("Good morning");
      expect(created[1]?.className).toContain("bubble-assistant");
      expect(created[1]?.innerHTML).toMatch(/ready when you are/);
      thread.endStreaming();
      expect(created.filter((c) => c.className.includes("streaming"))).toHaveLength(0);

      thread.handleCaption({ type: "start", text: "" });
      thread.handleCaption({ type: "reveal", text: "I'm on" });
      thread.handleCaption({ type: "end", reason: "complete" });
      thread.handleCaption({ type: "reveal", text: "I'm on it. Give me a sec." });
      thread.handleCaption({ type: "end", reason: "complete" });
      thread.handleCaption({ type: "reveal", text: "Splendid." });
      const assistant = children.filter((c) => c.className.includes("bubble-assistant"));
      expect(assistant.map((c) => c.innerHTML)).toEqual([
        expect.stringMatching(/ready when you are/),
        expect.stringMatching(/Give me a sec/),
        expect.stringMatching(/Splendid\./),
      ]);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: original,
      });
    }
  });
});

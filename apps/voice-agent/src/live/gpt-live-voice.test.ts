import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ALFRED_VOICE_PROMPT,
  DEFAULT_ALFRED_VOICE_SCRIPT,
  MIN_SCRIPT_HINT_CHARS,
  resolveGptLiveVoice,
} from "./gpt-live-voice.js";

describe("resolveGptLiveVoice", () => {
  it("passes a short named voice through unchanged", async () => {
    const resolved = await resolveGptLiveVoice({
      env: { ALFRED_GPT_LIVE_VOICE: "ripple" },
    });
    expect(resolved).toEqual({ voice: "ripple", source: "named" });
  });

  it("uses an explicit saved voice id", async () => {
    const resolved = await resolveGptLiveVoice({
      env: {
        ALFRED_GPT_LIVE_VOICE_ID: "voice_abc",
        ALFRED_GPT_LIVE_VOICE_PROMPT: "Warm British adult voice.",
      },
    });
    expect(resolved.voice).toEqual({ id: "voice_abc" });
    expect(resolved.instruction).toMatch(/British/);
    expect(resolved.source).toBe("id");
  });

  it("reuses a cached prompt voice when the description matches", async () => {
    const fetchImpl = vi.fn();
    const resolved = await resolveGptLiveVoice({
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readCache: async () => ({
        id: "voice_cached",
        prompt: DEFAULT_ALFRED_VOICE_PROMPT,
        name: "Alfred",
        createdAt: "2026-10-17T00:00:00.000Z",
      }),
      writeCache: async () => {
        throw new Error("should not write");
      },
    });
    expect(resolved.voice).toEqual({ id: "voice_cached" });
    expect(resolved.source).toBe("cached");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("creates a prompt voice and caches the id", async () => {
    const saved: unknown[] = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "voice_new", object: "audio.voice" }),
    }));
    const resolved = await resolveGptLiveVoice({
      env: { OPENAI_API_KEY: "sk-test", ALFRED_GPT_LIVE_VOICE_PROMPT: "Calm adult voice." },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readCache: async () => null,
      writeCache: async (cache) => {
        saved.push(cache);
      },
    });
    expect(resolved).toMatchObject({
      voice: { id: "voice_new" },
      instruction: "Calm adult voice.",
      source: "created",
    });
    expect(saved).toEqual([
      expect.objectContaining({ id: "voice_new", prompt: "Calm adult voice.", name: "Alfred" }),
    ]);
    const init = fetchImpl.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? "{}") as {
      type?: string;
      model?: string;
      prompt?: string;
      script_hint?: string;
    };
    expect(body.type).toBe("prompt");
    expect(body.model).toBe("auto");
    expect(body.prompt).toBe("Calm adult voice.");
    expect(body.script_hint).toBe(DEFAULT_ALFRED_VOICE_SCRIPT);
    expect(DEFAULT_ALFRED_VOICE_SCRIPT.length).toBeGreaterThanOrEqual(MIN_SCRIPT_HINT_CHARS);
  });

  it("omits a script hint that OpenAI would reject as too short", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "voice_new" }),
    }));
    await resolveGptLiveVoice({
      env: {
        OPENAI_API_KEY: "sk-test",
        ALFRED_GPT_LIVE_VOICE_PROMPT: "Calm adult voice.",
        ALFRED_GPT_LIVE_VOICE_SCRIPT: "Good morning.",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readCache: async () => null,
      writeCache: async () => {},
    });
    const init = fetchImpl.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? "{}") as { script_hint?: string };
    expect(body.script_hint).toBeUndefined();
  });
});

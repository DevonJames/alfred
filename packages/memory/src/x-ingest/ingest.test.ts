import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OipLocalMemoryProvider } from "../oip-local/provider.js";
import { ingestXNotes } from "./ingest.js";
import type { NotesRunner } from "./notes.js";
import { addXSource } from "./sources.js";
import type { XCapture, XCaptureAdapter } from "./types.js";

function fakeCapture(partial: Partial<XCapture> = {}): XCaptureAdapter {
  return {
    async capture(url: string): Promise<XCapture> {
      if (url.includes("paywall")) {
        return {
          url,
          canonicalUrl: url,
          kind: "article",
          author: "",
          headline: "Secret memo",
          text: "",
          posts: [],
          outboundUrls: [],
          screenshots: [],
          images: [],
          failure: { reason: "paywall", headline: "Secret memo" },
        };
      }
      return {
        url,
        canonicalUrl: "https://x.com/i/status/1",
        kind: "post",
        author: "Ada Lovelace",
        authorHandle: "ada",
        publishedAt: "2026-08-10T12:00:00.000Z",
        headline: "Notes on the analytical engine",
        text: "The analytical engine weaves algebraic patterns.",
        posts: [
          {
            text: "The analytical engine weaves algebraic patterns.",
            author: "Ada Lovelace",
            authorHandle: "ada",
            publishedAt: "2026-08-10T12:00:00.000Z",
          },
        ],
        outboundUrls: [],
        screenshots: [],
        images: [],
        ...partial,
      };
    },
  };
}

describe("ingestXNotes", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    delete process.env.ALFRED_X_INGEST_DIR;
    delete process.env.BRIEFING_CACHE_DIR;
    delete process.env.ALFRED_MEMORY_OIP_PATH;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("ingests inbox URLs into OIP, drains the note, and records failures", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-xingest-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.BRIEFING_CACHE_DIR = path.join(dir, "briefing");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(dir, "oip");

    await addXSource("p", { folder: "Alfred", note: "Marketing" });

    const notes = new Map<string, string>([
      [
        "Alfred/Marketing",
        `https://x.com/ada/status/1\nhttps://x.com/ada/status/paywall`,
      ],
    ]);
    const runner: NotesRunner = async (script) => {
      const folder = /const folderName = "([^"]*)"/.exec(script)?.[1] ?? "";
      const note = /const noteName = "([^"]*)"/.exec(script)?.[1] ?? "";
      const key = `${folder}/${note}`;
      if (script.includes("newBody")) {
        const raw = /const newBody = "([\s\S]*?)";/.exec(script)?.[1] ?? "";
        const body = raw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        notes.set(key, body);
        return JSON.stringify({ ok: true });
      }
      const body = notes.get(key);
      if (body == null && note.endsWith("Ingested")) {
        return JSON.stringify({ ok: false, error: "note_not_found" });
      }
      if (body == null) return JSON.stringify({ ok: false, error: "note_not_found" });
      return JSON.stringify({ ok: true, name: note, folder, body });
    };

    const provider = new OipLocalMemoryProvider(path.join(dir, "oip"));
    const result = await ingestXNotes({
      profileId: "p",
      capture: fakeCapture(),
      notesRunner: runner,
      provider,
      now: new Date("2026-08-17T18:00:00.000Z"),
    });

    expect(result.processed.map((p) => p.status).sort()).toEqual(["failed", "ingested"]);
    const inbox = notes.get("Alfred/Marketing") ?? "";
    expect(inbox).not.toContain("https://x.com/ada/status/1");
    expect(inbox).toMatch(/paywall/);
    const archive = notes.get("Alfred/Marketing Ingested") ?? "";
    expect(archive).toContain("Notes on the analytical engine");

    const hit = await provider.retrieve({
      text: "article on X from my marketing note last week about the analytical engine",
      limit: 8,
    });
    expect(hit.items.some((i) => /analytical engine/i.test(i.content))).toBe(true);
    expect(hit.items.some((i) => /source=X\.com/.test(i.content))).toBe(true);
    expect(hit.items.some((i) => /note=Marketing/.test(i.content))).toBe(true);
  });
});

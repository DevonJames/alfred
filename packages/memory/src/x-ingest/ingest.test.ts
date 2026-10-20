import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OipLocalMemoryProvider } from "../oip-local/provider.js";
import { composeNotesCaptureAdapter } from "./capture.js";
import { ingestXNotes, isXBrowserStormFailure } from "./ingest.js";
import { NOTE_BRIEF_ENTITY_CLASS, type NoteBriefDraft, type NoteBriefWriter } from "./note-brief.js";
import type { NotesRunner } from "./notes.js";
import { addXSource, loadXSources } from "./sources.js";
import type { XCapture, XCaptureAdapter, XIngestProgress } from "./types.js";
import type { YtDlpRunner } from "./youtube-capture.js";

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

describe("isXBrowserStormFailure", () => {
  it("treats a missing tweet capture as a storm so the scan stops", () => {
    expect(
      isXBrowserStormFailure("could not find that post on the page — X showed a different conversation"),
    ).toBe(true);
  });
});

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

  it("ingests YouTube inbox URLs as VideoObject with transcript retrieval", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-ytingest-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.BRIEFING_CACHE_DIR = path.join(dir, "briefing");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(dir, "oip");

    await addXSource("p", { folder: "Alfred", note: "Marketing" });

    const ytUrl = "https://youtu.be/dQw4w9WgXcQ";
    const notes = new Map<string, string>([["Alfred/Marketing", ytUrl]]);
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

    const ytdlp: YtDlpRunner = async (args, opts) => {
      if (args.includes("-J")) {
        return {
          stdout: JSON.stringify({
            id: "dQw4w9WgXcQ",
            title: "Growth loops",
            description: "A marketing primer on compounding acquisition.",
            channel: "Acme Channel",
            upload_date: "20260801",
            duration: 125,
            subtitles: { en: [{ ext: "vtt" }] },
          }),
          stderr: "",
        };
      }
      if (args.includes("--write-subs") && opts?.cwd) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
          path.join(opts.cwd, "dQw4w9WgXcQ.en.vtt"),
          "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nRetention holds the loop together.\n",
        );
      }
      return { stdout: "", stderr: "" };
    };

    const provider = new OipLocalMemoryProvider(path.join(dir, "oip"));
    const result = await ingestXNotes({
      profileId: "p",
      capture: composeNotesCaptureAdapter(fakeCapture(), { runner: ytdlp }),
      notesRunner: runner,
      provider,
      now: new Date("2026-08-17T18:00:00.000Z"),
    });

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.status).toBe("ingested");
    expect(result.processed[0]?.kind).toBe("video");
    expect(notes.get("Alfred/Marketing") ?? "").not.toContain("youtu.be");

    const hit = await provider.retrieve({
      text: "YouTube video from my marketing note about growth loops",
      limit: 8,
    });
    const memory = hit.items.map((i) => i.content).join("\n");
    expect(memory).toMatch(/Retention holds the loop/);
    expect(memory).toContain("Title: Growth loops");
    expect(memory).toContain("Description:\nA marketing primer on compounding acquisition.");
    expect(memory).toContain("Published: 2026-08-01");
    expect(memory).toMatch(/source=YouTube/);
    expect(hit.items.some((i) => /channel=Acme Channel/.test(i.content))).toBe(true);
    expect(hit.items.some((i) => /note=Marketing/.test(i.content))).toBe(true);
  });

  it("writes a named note brief after a scan and versions it on the next scan", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-xingest-brief-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.BRIEFING_CACHE_DIR = path.join(dir, "briefing");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(dir, "oip");

    await addXSource("p", { folder: "Alfred", note: "Marketing" });
    const notes = new Map<string, string>([["Alfred/Marketing", "https://x.com/ada/status/1"]]);
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

    const drafts: NoteBriefDraft[] = [];
    const writer: NoteBriefWriter = async (draft) => {
      drafts.push(draft);
      const n = draft.items.filter((i) => i.status === "ingested").length;
      return `# ${draft.note}\n\ningested=${n}\nprev=${draft.previousMarkdown ? "yes" : "no"}\n`;
    };

    const capture: XCaptureAdapter = {
      async capture(url: string): Promise<XCapture> {
        const id = url.includes("status/2") ? "2" : "1";
        const headline = id === "2" ? "Punch cards" : "Notes on the analytical engine";
        const text = id === "2" ? "Later news about punch cards." : "The analytical engine weaves algebraic patterns.";
        return {
          url,
          canonicalUrl: `https://x.com/i/status/${id}`,
          kind: "post",
          author: "Ada Lovelace",
          authorHandle: "ada",
          publishedAt: "2026-08-10T12:00:00.000Z",
          headline,
          text,
          posts: [{ text, author: "Ada Lovelace", authorHandle: "ada" }],
          outboundUrls: [],
          screenshots: [],
          images: [],
        };
      },
    };

    const provider = new OipLocalMemoryProvider(path.join(dir, "oip"));
    await ingestXNotes({
      profileId: "p",
      capture,
      notesRunner: runner,
      provider,
      now: new Date("2026-08-17T18:00:00.000Z"),
      briefWriter: writer,
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.previousMarkdown).toBeUndefined();
    const named = provider.sqlite.findByName("Marketing", "Entity");
    const briefRow = named.find((r) => /notes_inbox_brief|DigitalDocument/i.test(`${r.schema_type ?? ""} ${r.search_text ?? ""}`));
    expect(briefRow).toBeTruthy();
    const first = await provider.packages.readCurrent(briefRow!.logical_id);
    expect(first?.alfred?.entityClass).toBe(NOTE_BRIEF_ENTITY_CLASS);
    expect(first?.name).toBe("Marketing");
    expect(first?.text).toContain("ingested=1");
    expect(first?.previousRevision).toBeNull();
    expect(String(first?.drefs?.sourceArtifact ?? "")).toMatch(/^did:memory:/);
    const artifacts = provider.sqlite.findByName("Marketing", "Artifact");
    expect(artifacts.length).toBeGreaterThan(0);

    const sources = await loadXSources("p");
    expect(sources[0]?.briefDid).toBe(first?.id);

    notes.set("Alfred/Marketing", "https://x.com/ada/status/2");
    await ingestXNotes({
      profileId: "p",
      capture,
      notesRunner: runner,
      provider,
      now: new Date("2026-08-18T18:00:00.000Z"),
      briefWriter: writer,
    });

    expect(drafts).toHaveLength(2);
    expect(drafts[1]?.previousMarkdown).toContain("ingested=1");
    const second = await provider.packages.readCurrent(briefRow!.logical_id);
    expect(second?.id).toBe(first?.id);
    expect(second?.revision).not.toBe(first?.revision);
    expect(second?.previousRevision).toBe(first?.revision);
    expect(second?.text).toContain("ingested=2");
    expect(second?.text).toContain("prev=yes");
  });

  it("fails X links without capturing when the browser profile is logged out", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-xingest-nologin-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.BRIEFING_CACHE_DIR = path.join(dir, "briefing");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(dir, "oip");

    await addXSource("p", { folder: "Alfred", note: "Marketing" });
    const notes = new Map<string, string>([
      ["Alfred/Marketing", "https://x.com/ada/status/1\nhttps://youtu.be/dQw4w9WgXcQ"],
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

    let captured = 0;
    const web: XCaptureAdapter = {
      async capture(url) {
        captured += 1;
        return fakeCapture().capture(url);
      },
      async probeSession() {
        return {
          loggedIn: false,
          hint: "Not logged into X. Sign in with a dedicated ingest account from Settings → Ingest, then close that browser window",
        };
      },
    };
    const ytdlp: YtDlpRunner = async (args, opts) => {
      if (args.includes("-J")) {
        return {
          stdout: JSON.stringify({
            id: "dQw4w9WgXcQ",
            title: "Growth loops",
            channel: "Acme",
            upload_date: "20260801",
            duration: 12,
            subtitles: { en: [{ ext: "vtt" }] },
          }),
          stderr: "",
        };
      }
      if (args.includes("--write-subs") && opts?.cwd) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path.join(opts.cwd, "dQw4w9WgXcQ.en.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi.\n");
      }
      return { stdout: "", stderr: "" };
    };

    const provider = new OipLocalMemoryProvider(path.join(dir, "oip"));
    const result = await ingestXNotes({
      profileId: "p",
      capture: composeNotesCaptureAdapter(web, { runner: ytdlp }),
      notesRunner: runner,
      provider,
      now: new Date("2026-08-17T18:00:00.000Z"),
    });

    expect(captured).toBe(0);
    const x = result.processed.find((p) => p.url.includes("x.com"));
    const yt = result.processed.find((p) => p.url.includes("youtu"));
    expect(x?.status).toBe("failed");
    expect(x?.error).toMatch(/dedicated ingest account/i);
    expect(yt?.status).toBe("ingested");
    expect(notes.get("Alfred/Marketing") ?? "").toMatch(/x\.com\/ada\/status\/1/);
    expect(notes.get("Alfred/Marketing") ?? "").not.toContain("youtu.be");
  });

  it("reports progress and pauses between batches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-xingest-batch-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.BRIEFING_CACHE_DIR = path.join(dir, "briefing");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(dir, "oip");

    await addXSource("p", { folder: "Alfred", note: "Marketing" });
    const notes = new Map<string, string>([
      ["Alfred/Marketing", "https://x.com/ada/status/1\nhttps://x.com/ada/status/2"],
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

    const events: XIngestProgress[] = [];
    const provider = new OipLocalMemoryProvider(path.join(dir, "oip"));
    await ingestXNotes({
      profileId: "p",
      capture: fakeCapture(),
      notesRunner: runner,
      provider,
      now: new Date("2026-08-17T18:00:00.000Z"),
      chunkSize: 1,
      chunkPauseMs: 0,
      onProgress: (p) => {
        events.push(p);
      },
    });

    expect(events.map((e) => e.phase)).toEqual(["start", "item", "pause", "item", "done"]);
    expect(events[0]?.total).toBe(2);
    expect(events.some((e) => e.phase === "pause" && /rate-limit/i.test(e.label))).toBe(true);
    expect(notes.get("Alfred/Marketing") ?? "").not.toContain("x.com/ada/status");
  });

  it("stops X ingest after repeated browser failures instead of annotating every link", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-xingest-storm-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.BRIEFING_CACHE_DIR = path.join(dir, "briefing");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(dir, "oip");

    await addXSource("p", { folder: "Alfred", note: "Marketing" });
    const urls = Array.from({ length: 8 }, (_, i) => `https://x.com/ada/status/${i + 1}`);
    const notes = new Map<string, string>([["Alfred/Marketing", urls.join("\n")]]);
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
      if (body == null) return JSON.stringify({ ok: false, error: "note_not_found" });
      return JSON.stringify({ ok: true, name: note, folder, body });
    };

    let captured = 0;
    const events: XIngestProgress[] = [];
    const web: XCaptureAdapter = {
      async capture(url) {
        captured += 1;
        return {
          url,
          canonicalUrl: url,
          kind: "post",
          author: "",
          headline: url,
          text: "",
          posts: [],
          outboundUrls: [],
          screenshots: [],
          images: [],
          failure: { reason: "browserContext.newPage: Target page, context or browser has been closed" },
        };
      },
    };

    const result = await ingestXNotes({
      profileId: "p",
      capture: web,
      notesRunner: runner,
      provider: new OipLocalMemoryProvider(path.join(dir, "oip")),
      now: new Date("2026-08-17T18:00:00.000Z"),
      onProgress: (p) => {
        events.push(p);
      },
    });

    expect(captured).toBe(5);
    expect(result.processed.filter((p) => p.status === "failed")).toHaveLength(5);
    expect(result.processed.filter((p) => p.status === "skipped")).toHaveLength(3);
    expect(events.some((e) => /repeated browser failures/i.test(e.label))).toBe(true);
    const body = notes.get("Alfred/Marketing") ?? "";
    expect(body).toMatch(/status\/6/);
    expect(body).not.toMatch(/status\/6 — failed/);
  });
});


/**
 * /memory — local memory ingest UI + API
 *
 * GET  /memory/ingest  — browser form (LLM Knowledge Export, Document, or Alfred Memory File)
 * POST /memory/ingest  — multipart upload (fields: mode, file) or raw body
 *
 * Knowledge: Alfred knowledge-export JSON (see docs/knowledge-export-prompt.md),
 *            plus markdown/txt/rtf via section-split + USER.md patch.
 * Document:  one-shot PDF upload → artifact + page/section memories.
 * Photo:     image upload → Grok/OpenAI vision OCR + scene analysis → OIP memories.
 * Node bundle: .alfred-memory.zip from another Alfred node → union merge into local OIP.
 *
 * Markdown folders (scheduled scan, separate from the file picker):
 * GET/POST /memory/ingest/folders · POST .../pick · POST .../scan · POST .../remove
 * POST /memory/ingest/discover-links — SSE: propose missing high-level graph links
 */

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { discoverMemoryLinks } from "@alfred/memory";
import type { DocsFolderList } from "../lib/docs-folders.js";
import {
  addWatchedDocsFolder,
  docsIngestSchedule,
  listWatchedDocsFolders,
  pickLocalMarkdownFolder,
  removeWatchedDocsFolder,
  scanWatchedDocsFolder,
} from "../lib/docs-folders.js";
import {
  addAudioNoteFolder,
  listAudioNoteFolders,
  pickLocalAudioFolder,
  removeAudioNoteFolder,
  scanAudioNoteFolder,
  setFolderQueuePaused,
  type AudioNoteFolderRow,
} from "../lib/notes/folders.js";
import type { IngestFileResult, IngestUploadMode } from "../lib/memory-ingest.js";
import { ingestPhotoFiles, ingestUploadedFile } from "../lib/memory-ingest.js";
import { kindFromFilename } from "../lib/text-extract.js";
import { memoryGraphRouter } from "./memory-graph.js";
import { memoryGraphBetaRouter } from "./memory-graph-beta.js";

export const memoryRouter = new Hono();

const EMBED_BRIDGE = `<script src="/alfred-base.js"></script><script src="/embed-bridge.js"></script>`;

function asUploadFiles(value: unknown): File[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.filter((item): item is File => typeof item === "object" && item !== null && "arrayBuffer" in item);
}

async function readFolderActionId(c: Context): Promise<string> {
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
    return typeof body.id === "string" ? body.id.trim() : "";
  }
  const body = await c.req.parseBody();
  return typeof body.id === "string" ? body.id.trim() : "";
}

memoryRouter.route("/graph", memoryGraphRouter);
memoryRouter.route("/graph-beta", memoryGraphBetaRouter);

memoryRouter.get("/ingest/folders", async (c) => {
  return c.json(await listWatchedDocsFolders());
});

memoryRouter.post("/ingest/folders/pick", async (c) => {
  const picked = await pickLocalMarkdownFolder();
  if (!picked.ok) {
    return c.json(
      {
        error: picked.reason,
        message:
          picked.reason === "unsupported"
            ? "Folder picker is only available on this Mac. Paste an absolute path instead."
            : "Folder selection cancelled",
      },
      picked.reason === "unsupported" ? 501 : 400,
    );
  }
  return c.json(picked);
});

memoryRouter.post("/ingest/folders/scan", async (c) => {
  try {
    const id = await readFolderActionId(c);
    if (!id) return c.json({ error: "missing_id", message: "Folder id is required" }, 400);
    const result = await scanWatchedDocsFolder(id);
    return c.json({ ok: true, ...result, folders: (await listWatchedDocsFolders()).folders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "scan_failed", message }, 400);
  }
});

memoryRouter.get("/ingest/voice-folders", async (c) => {
  return c.json(await listAudioNoteFolders());
});

memoryRouter.post("/ingest/voice-folders/pick", async (c) => {
  const picked = await pickLocalAudioFolder();
  if (!picked.ok) {
    return c.json(
      {
        error: picked.reason,
        message:
          picked.reason === "unsupported"
            ? "Folder picker is only available on this Mac. Paste an absolute path instead."
            : "Folder selection cancelled",
      },
      picked.reason === "unsupported" ? 501 : 400,
    );
  }
  return c.json(picked);
});

memoryRouter.post("/ingest/voice-folders/scan", async (c) => {
  try {
    const id = await readFolderActionId(c);
    if (!id) return c.json({ error: "missing_id", message: "Folder id is required" }, 400);
    const enqueued = await scanAudioNoteFolder(id);
    return c.json({ ok: true, enqueued, ...(await listAudioNoteFolders()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "scan_failed", message }, 400);
  }
});

memoryRouter.post("/ingest/voice-folders/pause", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { paused?: unknown };
  setFolderQueuePaused(body.paused !== false);
  return c.json({ ok: true, ...(await listAudioNoteFolders()) });
});

memoryRouter.post("/ingest/voice-folders/remove", async (c) => {
  try {
    const id = await readFolderActionId(c);
    if (!id) return c.json({ error: "missing_id", message: "Folder id is required" }, 400);
    const removed = await removeAudioNoteFolder(id);
    return c.json({ ok: true, removed, ...(await listAudioNoteFolders()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "remove_failed", message }, 400);
  }
});

memoryRouter.post("/ingest/voice-folders", async (c) => {
  try {
    const body = await c.req.parseBody();
    const folderPath = typeof body.path === "string" ? body.path : "";
    const label = typeof body.label === "string" ? body.label : "";
    const result = await addAudioNoteFolder({ path: folderPath, label, ingest: true });
    return c.json({ ok: true, ...result, ...(await listAudioNoteFolders()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "add_failed", message }, 400);
  }
});

memoryRouter.post("/ingest/folders/remove", async (c) => {
  try {
    const id = await readFolderActionId(c);
    if (!id) return c.json({ error: "missing_id", message: "Folder id is required" }, 400);
    const removed = await removeWatchedDocsFolder(id);
    return c.json({ ok: true, removed, folders: (await listWatchedDocsFolders()).folders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "remove_failed", message }, 400);
  }
});

memoryRouter.post("/ingest/discover-links", (c) => {
  return streamSSE(c, async (stream) => {
    try {
      const result = await discoverMemoryLinks({
        onProgress: async (progress) => {
          await stream.writeSSE({
            event: "progress",
            data: JSON.stringify(progress),
          });
        },
      });
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify(result),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "discover_links_failed", message }),
      });
    }
  });
});

memoryRouter.post("/ingest/folders", async (c) => {
  try {
    const body = await c.req.parseBody();
    const folderPath = typeof body.path === "string" ? body.path : "";
    const label = typeof body.label === "string" ? body.label : "";
    const ingestRaw = typeof body.ingest === "string" ? body.ingest : undefined;
    const ingest = ingestRaw !== "0" && ingestRaw !== "false";
    const result = await addWatchedDocsFolder({ path: folderPath, label, ingest });
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html") && !accept.includes("application/json")) {
      return c.redirect("/memory/ingest");
    }
    return c.json({ ok: true, ...result, folders: (await listWatchedDocsFolders()).folders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "add_failed", message }, 400);
  }
});

memoryRouter.get("/ingest", async (c) => {
  const providerId = process.env.ALFRED_MEMORY_PROVIDER_ID ?? "memory.oip-local";
  const folders = await listWatchedDocsFolders().catch(() => ({
    schedule: docsIngestSchedule(),
    folders: [],
  }));
  const voiceFolders = await listAudioNoteFolders().catch(() => ({
    folders: [] as AudioNoteFolderRow[],
    queue: {
      active: null,
      queuedInteractive: 0,
      queuedFolder: 0,
      pausedFolder: 0,
      folderQueuePaused: false,
      message: "Idle",
    },
  }));
  return c.html(ingestPageHtml(providerId, folders, voiceFolders.folders, voiceFolders.queue.message));
});

memoryRouter.post("/ingest", async (c) => {
  try {
    const contentType = c.req.header("content-type") ?? "";

    let filename = "upload.txt";
    let bytes: Buffer;
    let ingestMode: IngestUploadMode = "knowledge";

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      if (typeof body.mode === "string") {
        if (body.mode === "document") ingestMode = "document";
        else if (body.mode === "photo") ingestMode = "photo";
        else if (body.mode === "node-bundle") ingestMode = "node-bundle";
      }
      const label = typeof body.label === "string" ? body.label.trim() : "";
      const uploads = asUploadFiles(body.file);
      if (!uploads.length) {
        return c.json(
          { error: "missing_file", message: "multipart field 'file' is required" },
          400,
        );
      }
      if (ingestMode === "photo") {
        const photos = uploads.filter((file) => kindFromFilename(file.name || "") === "image");
        if (!photos.length) {
          return c.json(
            {
              error: "unsupported_extension",
              message: "Photo mode accepts images (.jpg, .png, .webp, .gif, .heic, .tif, .bmp)",
            },
            400,
          );
        }
        const files = [];
        for (const file of photos) {
          files.push({
            filename: file.name || "upload.jpg",
            bytes: Buffer.from(await file.arrayBuffer()),
          });
        }
        console.log(
          `[memory-ingest] photo ${files.length} file(s)${label ? ` label=${label}` : ""}`,
        );
        const result = await ingestPhotoFiles({ files, label: label || undefined });
        const accept = c.req.header("accept") ?? "";
        if (accept.includes("text/html")) return c.html(successPageHtml(result));
        return c.json({ ok: true, ...result });
      }
      const file = uploads[0]!;
      filename = file.name || filename;
      bytes = Buffer.from(await file.arrayBuffer());
    } else if (
      contentType.includes("application/zip") ||
      contentType.includes("application/x-zip-compressed")
    ) {
      ingestMode = "node-bundle";
      const qName = c.req.query("filename");
      filename = qName || "node.alfred-memory.zip";
      bytes = Buffer.from(await c.req.arrayBuffer());
    } else if (contentType.includes("application/pdf")) {
      ingestMode = "document";
      const qName = c.req.query("filename");
      filename = qName || "upload.pdf";
      bytes = Buffer.from(await c.req.arrayBuffer());
    } else if (contentType.startsWith("image/")) {
      ingestMode = "photo";
      const qName = c.req.query("filename");
      filename = qName || "upload.jpg";
      bytes = Buffer.from(await c.req.arrayBuffer());
    } else if (
      contentType.includes("text/plain") ||
      contentType.includes("text/markdown") ||
      contentType.includes("application/rtf") ||
      contentType.includes("text/rtf") ||
      contentType.includes("application/json")
    ) {
      const qName = c.req.query("filename");
      if (qName) filename = qName;
      else if (contentType.includes("json")) filename = "upload.json";
      else if (contentType.includes("markdown")) filename = "upload.md";
      else if (contentType.includes("rtf")) filename = "upload.rtf";
      bytes = Buffer.from(await c.req.arrayBuffer());
    } else {
      const body = await c.req.parseBody();
      const text = typeof body.text === "string" ? body.text : null;
      if (!text) {
        return c.json(
          {
            error: "unsupported_content_type",
            message:
              "Send multipart file field 'file', or text/plain|text/markdown|application/json|application/rtf body",
          },
          415,
        );
      }
      if (typeof body.filename === "string" && body.filename) filename = body.filename;
      if (typeof body.mode === "string") {
        if (body.mode === "document") ingestMode = "document";
        else if (body.mode === "photo") ingestMode = "photo";
        else if (body.mode === "node-bundle") ingestMode = "node-bundle";
      }
      bytes = Buffer.from(text, "utf8");
    }

    const kind = kindFromFilename(filename);
    if (ingestMode === "node-bundle") {
      const lower = filename.toLowerCase();
      if (!lower.endsWith(".zip")) {
        return c.json(
          {
            error: "unsupported_extension",
            message: "Alfred Memory File mode accepts .alfred-memory.zip (or .zip)",
          },
          400,
        );
      }
    } else if (ingestMode === "document") {
      if (kind !== "pdf") {
        return c.json(
          { error: "unsupported_extension", message: "Document mode accepts PDF files (.pdf)" },
          400,
        );
      }
    } else if (ingestMode === "photo") {
      if (kind !== "image") {
        return c.json(
          {
            error: "unsupported_extension",
            message: "Photo mode accepts images (.jpg, .png, .webp, .gif, .heic, .tif, .bmp)",
          },
          400,
        );
      }
    } else if (kind === "pdf") {
      return c.json(
        {
          error: "unsupported_extension",
          message: "PDFs use Document mode. Choose Document in the ingest form.",
        },
        400,
      );
    } else if (kind === "image") {
      return c.json(
        {
          error: "unsupported_extension",
          message: "Photos use Photo mode. Choose Photo in the ingest form.",
        },
        400,
      );
    } else if (kind === "unknown") {
      return c.json(
        { error: "unsupported_extension", message: "Use .json, .txt, .md, or .rtf" },
        400,
      );
    }

    if (!bytes.byteLength) {
      return c.json({ error: "empty_file", message: "Uploaded file is empty" }, 400);
    }

    const queryLabel = c.req.query("label")?.trim();
    const result = await ingestUploadedFile({
      filename,
      bytes,
      mode: ingestMode,
      label: queryLabel || undefined,
    });
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html") && contentType.includes("multipart/form-data")) {
      return c.html(successPageHtml(result));
    }
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[memory-ingest] failed: ${message}`);
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) return c.html(errorPageHtml(message), 400);
    return c.json({ error: "ingest_failed", message }, 400);
  }
});

function ingestPageHtml(
  providerId: string,
  folderList: DocsFolderList,
  voiceFolders: AudioNoteFolderRow[] = [],
  voiceQueueMessage = "Idle",
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alfred — Ingest memory</title>
  <style>
    :root {
      --bg: #1a1f1c;
      --panel: #243028;
      --ink: #e8efe6;
      --muted: #9aab9c;
      --accent: #c4a35a;
      --line: #3a463d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      background:
        radial-gradient(ellipse at top, #2a332c 0%, transparent 55%),
        var(--bg);
      color: var(--ink);
      display: grid;
      place-items: center;
      padding: 2rem 1rem;
    }
    main {
      width: min(36rem, 100%);
      background: color-mix(in srgb, var(--panel) 92%, black);
      border: 1px solid var(--line);
      padding: 2rem 1.75rem 1.75rem;
    }
    h1 {
      margin: 0 0 0.35rem;
      font-size: 1.85rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .brand { color: var(--accent); }
    p {
      margin: 0 0 1.1rem;
      color: var(--muted);
      line-height: 1.45;
      font-size: 1rem;
    }
    label {
      display: block;
      font-size: 0.85rem;
      color: var(--muted);
      margin-bottom: 0.45rem;
    }
    select, input[type="file"] {
      width: 100%;
      color: var(--ink);
      margin-bottom: 1.25rem;
    }
    select {
      appearance: none;
      padding: 0.55rem 0.7rem;
      font: inherit;
      font-size: 1rem;
      background: color-mix(in srgb, var(--panel) 70%, black);
      border: 1px solid var(--line);
    }
    button {
      appearance: none;
      border: 1px solid var(--accent);
      background: transparent;
      color: var(--ink);
      padding: 0.7rem 1.1rem;
      font: inherit;
      font-size: 1rem;
      cursor: pointer;
    }
    button:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
    .meta {
      margin-top: 1.4rem;
      font-size: 0.8rem;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #photo-label-hint { margin-top: 0.35rem; }
    #ingest-status { min-height: 1.4em; margin: 0.8rem 0 0; }
    #ingest-status.is-error { color: #d7a07a; }
    #ingest-result {
      margin-top: 1rem;
      padding: 0.9rem 1rem;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel) 70%, black);
    }
    #ingest-result[hidden] { display: none; }
    #ingest-result p { margin: 0 0 0.45rem; }
    #ingest-result p:last-child { margin-bottom: 0; }
    #discover-status { min-height: 1.4em; margin: 0.8rem 0 0; }
    #discover-status.is-error { color: #d7a07a; }
    #discover-result {
      margin-top: 1rem;
      padding: 0.9rem 1rem;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel) 70%, black);
    }
    #discover-result[hidden] { display: none; }
    #discover-result p { margin: 0 0 0.45rem; }
    #discover-result p:last-child { margin-bottom: 0; }
    button:disabled { opacity: 0.55; cursor: wait; }
    .job-progress {
      position: fixed;
      right: 1rem;
      bottom: 1rem;
      z-index: 8;
      width: min(20rem, calc(100vw - 2rem));
      padding: 0.85rem 0.95rem 0.95rem;
      background: var(--panel);
      border: 1px solid var(--line);
      opacity: 0;
      transform: translateY(12px);
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .job-progress.on {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }
    .job-progress-title {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
      margin: 0 0 0.3rem;
    }
    .job-progress-label {
      margin: 0 0 0.55rem;
      font-size: 0.82rem;
      color: var(--ink);
      line-height: 1.35;
      min-height: 1.1em;
    }
    .job-progress-track {
      height: 0.38rem;
      background: #121714;
      border: 1px solid var(--line);
      overflow: hidden;
    }
    .job-progress-fill {
      height: 100%;
      width: 0;
      background: var(--accent);
      transition: width 160ms ease;
    }
    .job-progress-meta {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      margin-top: 0.4rem;
      font-size: 0.72rem;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .job-progress.err .job-progress-title { color: #d7a07a; }
    .job-progress.err .job-progress-fill { background: #d7a07a; }
    ul { color: var(--muted); margin: 0 0 1.2rem 1.1rem; padding: 0; line-height: 1.4; }
    hr.rule {
      border: 0;
      border-top: 1px solid var(--line);
      margin: 1.75rem 0 1.35rem;
    }
    h2 {
      margin: 0 0 0.4rem;
      font-size: 1.2rem;
      font-weight: 600;
    }
    .folder-form input[type="text"] {
      width: 100%;
      margin-bottom: 0.75rem;
      padding: 0.5rem 0.65rem;
      font: inherit;
      font-size: 0.95rem;
      color: var(--ink);
      background: color-mix(in srgb, var(--panel) 70%, black);
      border: 1px solid var(--line);
    }
    .folder-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      margin-bottom: 1.1rem;
    }
    button.secondary {
      border-color: var(--line);
    }
    #folder-status {
      min-height: 1.3em;
      margin: 0 0 0.85rem;
      font-size: 0.95rem;
      color: var(--ink);
    }
    #folder-list li.is-busy {
      border-color: var(--accent);
    }
    #folder-list li.is-busy [data-action="scan"] {
      background: color-mix(in srgb, var(--accent) 22%, transparent);
    }
    button:disabled { opacity: 0.55; cursor: default; }
    .folder-note { margin-top: 0.45rem; font-size: 0.88rem; color: var(--ink); }
    #folder-list {
      list-style: none;
      margin: 0 0 0.4rem;
      padding: 0;
    }
    #folder-list li {
      border: 1px solid var(--line);
      padding: 0.75rem 0.8rem;
      margin: 0 0 0.55rem;
    }
    #folder-list strong { color: var(--ink); }
    .folder-path {
      display: block;
      margin: 0.2rem 0 0.35rem;
      font-size: 0.78rem;
      word-break: break-all;
      color: var(--muted);
    }
    .folder-meta { font-size: 0.82rem; }
    .folder-row-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.55rem; }
    .folder-row-actions button { padding: 0.4rem 0.7rem; font-size: 0.9rem; }
    .missing { color: #d7a07a; }
  </style>
</head>
<body>
  <main>
    <h1><span class="brand">Alfred</span> memory ingest</h1>
    <p id="intro">Upload a knowledge export. Alfred will:</p>
    <ul id="bullets">
      <li>Merge high-priority / how-to-work sections into <code>USER.md</code></li>
      <li>Split remaining details into individual OIP memory records</li>
      <li>Keep the original file as a content-addressed artifact</li>
    </ul>
    <p id="hint">Prefer <code>.json</code> (see <code>docs/knowledge-export-prompt.md</code>). Markdown / txt / rtf still work via section splitting. Provider: <code>${escapeHtml(providerId)}</code>.</p>
    <form id="ingest-form" method="post" action="/memory/ingest" enctype="multipart/form-data">
      <label for="mode">What are you uploading?</label>
      <select id="mode" name="mode">
        <option value="knowledge" selected>LLM Knowledge Export</option>
        <option value="document">Document</option>
        <option value="photo">Photo</option>
        <option value="node-bundle">Alfred Memory File from Another Node</option>
      </select>
      <label for="file" id="file-label">Knowledge export</label>
      <input id="file" name="file" type="file" accept=".json,.txt,.md,.markdown,.rtf,application/json,text/plain,text/markdown,application/rtf" required />
      <div id="photo-label-wrap" hidden>
        <label for="photo-label">Label</label>
        <input id="photo-label" name="label" type="text" placeholder="Kitchen remodel · receipts" autocomplete="off" />
        <p class="meta" id="photo-label-hint">Optional. Same as a folder label: it becomes a hub in the memory graph, and every photo plus its extracted facts connect to it. Multiple photos in one upload are also linked to each other.</p>
      </div>
      <button type="submit" id="ingest-submit">Analyze &amp; ingest</button>
      <p id="ingest-status"></p>
      <div id="ingest-result" hidden></div>
    </form>
    <hr class="rule" />
    <h2>Markdown folders</h2>
    <p>Watch a folder of <code>.md</code>, <code>.txt</code>, <code>.rtf</code>, and <code>.pdf</code> files. The label becomes a hub in the memory graph; every file and section ingested from the folder connects to it. Alfred also scans it ${escapeHtml(folderList.schedule.label)} and re-ingests files that changed.</p>
    <form id="folder-form" class="folder-form" method="post" action="/memory/ingest/folders">
      <label for="folder-path">Folder on this Mac</label>
      <input id="folder-path" name="path" type="text" placeholder="/Users/you/Documents/docs" autocomplete="off" />
      <label for="folder-label">Label</label>
      <input id="folder-label" name="label" type="text" placeholder="Project docs" required autocomplete="off" />
      <div class="folder-actions">
        <button type="button" id="folder-pick" class="secondary">Choose folder…</button>
        <button type="button" id="folder-watch">Watch this folder</button>
      </div>
    </form>
    <p id="folder-status"></p>
    <p>Currently watching</p>
    <ul id="folder-list">${renderFolderListItems(folderList)}</ul>
    <hr class="rule" />
    <h2>Voice note folders</h2>
    <p>Ingest a folder of recordings one file at a time through the same Notes pipeline. iPhone uploads jump the line. Filenames (Home 14, Sunset Plaza, a person’s name) become location or participants; the note title comes from the transcript subject.</p>
    <form id="voice-folder-form" class="folder-form">
      <label for="voice-folder-path">Folder on this Mac</label>
      <input id="voice-folder-path" name="path" type="text" placeholder="/Users/you/Documents/Voice Memos" autocomplete="off" />
      <label for="voice-folder-label">Label</label>
      <input id="voice-folder-label" name="label" type="text" placeholder="Voice memos" required autocomplete="off" />
      <div class="folder-actions">
        <button type="button" id="voice-folder-pick" class="secondary">Choose folder…</button>
        <button type="button" id="voice-folder-watch">Scan this folder</button>
        <button type="button" id="voice-folder-pause" class="secondary">Pause folder queue</button>
      </div>
    </form>
    <p id="voice-folder-status">${escapeHtml(voiceQueueMessage)}</p>
    <p>Registered folders</p>
    <ul id="voice-folder-list">${renderVoiceFolderListItems(voiceFolders)}</ul>
    <hr class="rule" />
    <h2>Find connections</h2>
    <p>Scan high-level memories and add missed links. Also creates concept hubs — shared topics like AI, Rock Hoppers, or USPTO — that pull currently disconnected memories together. Needs <code>OPENAI_API_KEY</code>.</p>
    <button type="button" id="discover-links">Find connections</button>
    <p id="discover-status"></p>
    <div id="discover-result" hidden></div>
    <p class="meta">POST /memory/ingest · fields <code>mode</code>, <code>file</code>, optional <code>label</code> · <a href="/memory/graph" style="color:var(--accent)">Browse graph</a></p>
  </main>
  <div class="job-progress" id="job-progress" hidden>
    <div class="job-progress-title" id="job-progress-title">Find connections</div>
    <p class="job-progress-label" id="job-progress-label">Starting…</p>
    <div class="job-progress-track" id="job-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="job-progress-fill" id="job-progress-fill"></div>
    </div>
    <div class="job-progress-meta">
      <span id="job-progress-count"></span>
      <span id="job-progress-pct">0%</span>
    </div>
  </div>
  ${EMBED_BRIDGE}
  <script>
    const mode = document.getElementById("mode");
    const file = document.getElementById("file");
    const label = document.getElementById("file-label");
    const intro = document.getElementById("intro");
    const bullets = document.getElementById("bullets");
    const hint = document.getElementById("hint");
    const provider = ${JSON.stringify(escapeHtml(providerId))};
    function syncMode() {
      const m = mode.value;
      file.multiple = false;
      document.getElementById("photo-label-wrap").hidden = true;
      document.getElementById("photo-label").disabled = true;
      if (m === "document") {
        file.accept = ".pdf,application/pdf";
        label.textContent = "PDF document";
        intro.textContent = "Upload a PDF. Alfred will:";
        bullets.innerHTML = "<li>Extract text from each page</li><li>Store verbatim page sections as OIP memories</li><li>Keep the original PDF as a content-addressed artifact</li>";
        hint.innerHTML = "USER.md is not changed. Scanned image-only PDFs cannot be ingested. Provider: <code>" + provider + "</code>.";
      } else if (m === "photo") {
        file.accept = ".jpg,.jpeg,.png,.gif,.webp,.bmp,.tif,.tiff,.heic,.heif,image/jpeg,image/png,image/webp,image/heic";
        file.multiple = true;
        label.textContent = "Photos";
        intro.textContent = "Upload one or more photos. Alfred will:";
        bullets.innerHTML = "<li>Run vision OCR and describe each scene (Grok Vision, or OpenAI if no Grok key)</li><li>Convert iPhone HEIC/HEIF photos to JPEG so vision and the graph can read them</li><li>Treat photos in this upload as a connected set</li><li>If you add a label, make it a hub node like a watched folder</li>";
        hint.innerHTML = "iPhone photos (.heic) are supported. Needs <code>GROK_API_KEY</code> (or <code>XAI_API_KEY</code>) or <code>OPENAI_API_KEY</code>. USER.md is not changed. Provider: <code>" + provider + "</code>.";
        document.getElementById("photo-label-wrap").hidden = false;
        document.getElementById("photo-label").disabled = false;
      } else if (m === "node-bundle") {
        file.accept = ".zip,.alfred-memory.zip,application/zip";
        label.textContent = "Alfred Memory File (.alfred-memory.zip)";
        intro.textContent = "Merge memory from another Alfred node. Alfred will:";
        bullets.innerHTML = "<li>Union-merge packages and artifacts into this machine's OIP store</li><li>Keep local-only memories (never wipe)</li><li>Keep both revision histories when the same record diverged; prefer the newer head</li><li>Rebuild search/graph indexes afterward</li>";
        hint.innerHTML = "Export on the other node with <code>pnpm memory -- oip-bundle-export ./node.alfred-memory.zip</code>, then upload here. Persona / briefing files are not included. Provider: <code>" + provider + "</code>.";
      } else {
        file.accept = ".json,.txt,.md,.markdown,.rtf,application/json,text/plain,text/markdown,application/rtf";
        label.textContent = "Knowledge export";
        intro.textContent = "Upload a knowledge export. Alfred will:";
        bullets.innerHTML = "<li>Merge high-priority / how-to-work sections into <code>USER.md</code></li><li>Split remaining details into individual OIP memory records</li><li>Keep the original file as a content-addressed artifact</li>";
        hint.innerHTML = "Prefer <code>.json</code> (see <code>docs/knowledge-export-prompt.md</code>). Markdown / txt / rtf still work via section splitting. Provider: <code>" + provider + "</code>.";
      }
    }
    mode.addEventListener("change", syncMode);
    syncMode();

    const ingestForm = document.getElementById("ingest-form");
    const ingestSubmit = document.getElementById("ingest-submit");
    const ingestStatus = document.getElementById("ingest-status");
    const ingestResult = document.getElementById("ingest-result");
    ingestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      ingestResult.hidden = true;
      ingestResult.innerHTML = "";
      ingestStatus.classList.remove("is-error");
      const count = file.files ? file.files.length : 0;
      const photo = mode.value === "photo";
      ingestStatus.textContent = photo && count > 1
        ? "Analyzing " + count + " photos — vision can take a minute each. Stay on this page."
        : photo
          ? "Analyzing photo — vision can take a minute. Stay on this page."
          : "Ingesting…";
      ingestSubmit.disabled = true;
      try {
        const res = await fetch(api("/memory/ingest"), {
          method: "POST",
          headers: { accept: "application/json" },
          body: new FormData(ingestForm),
        });
        const data = await readJson(res);
        ingestStatus.textContent = "Ingested.";
        const bits = [];
        bits.push("<p><strong>" + esc(data.filename || "upload") + "</strong> stored as <code>" + esc(data.mode || "") + "</code>.</p>");
        if (data.label) bits.push("<p>Label hub: <strong>" + esc(data.label) + "</strong></p>");
        if (Array.isArray(data.filenames) && data.filenames.length > 1) {
          bits.push("<p>" + data.filenames.length + " photos: " + esc(data.filenames.join(", ")) + "</p>");
        }
        if (data.created) {
          bits.push("<p>Created records — entities " + data.created.entities +
            ", observations " + data.created.observations +
            ", assertions " + data.created.assertions + "</p>");
        }
        bits.push('<p><a href="/memory/graph">Browse graph</a></p>');
        ingestResult.innerHTML = bits.join("");
        ingestResult.hidden = false;
      } catch (err) {
        ingestStatus.classList.add("is-error");
        ingestStatus.textContent = err && err.message ? err.message : String(err);
      } finally {
        ingestSubmit.disabled = false;
      }
    });

    const folderForm = document.getElementById("folder-form");
    const folderPath = document.getElementById("folder-path");
    const folderLabel = document.getElementById("folder-label");
    const folderPick = document.getElementById("folder-pick");
    const folderWatch = document.getElementById("folder-watch");
    const folderStatus = document.getElementById("folder-status");
    const folderList = document.getElementById("folder-list");
    const api = (path) => (typeof alfredUrl === "function" ? alfredUrl(path) : path);

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function setFolderStatus(text, isError) {
      folderStatus.textContent = text || "";
      folderStatus.style.color = isError ? "#d7a07a" : "var(--ink)";
    }
    function paint() {
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    function folderRow(id) {
      return folderList.querySelector('li[data-id="' + CSS.escape(id) + '"]');
    }
    function setRowBusy(id, busy, note) {
      const li = folderRow(id);
      if (!li) return;
      li.classList.toggle("is-busy", !!busy);
      const scanBtn = li.querySelector("[data-action=scan]");
      const removeBtn = li.querySelector("[data-action=remove]");
      if (scanBtn) {
        scanBtn.disabled = !!busy;
        scanBtn.textContent = busy ? "Scanning…" : "Scan now";
      }
      if (removeBtn) removeBtn.disabled = !!busy;
      let noteEl = li.querySelector(".folder-note");
      if (note) {
        if (!noteEl) {
          noteEl = document.createElement("div");
          noteEl.className = "folder-note";
          li.appendChild(noteEl);
        }
        noteEl.textContent = note;
      } else if (noteEl) {
        noteEl.remove();
      }
    }
    async function postFolderAction(path, id) {
      return readJson(await fetch(api(path), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }));
    }
    function formatWhen(iso) {
      if (!iso) return "not scanned yet";
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
    }
    function renderFolders(folders) {
      if (!folders.length) {
        folderList.innerHTML = '<li class="empty">No markdown folders are being scanned yet.</li>';
        return;
      }
      folderList.innerHTML = folders.map((f) => {
        const missing = f.exists ? "" : '<span class="missing"> · folder missing</span>';
        return '<li data-id="' + esc(f.id) + '"><strong>' + esc(f.label) + '</strong>' +
          '<code class="folder-path">' + esc(f.path) + '</code>' +
          '<div class="folder-meta">' + f.trackedFiles + ' file' + (f.trackedFiles === 1 ? "" : "s") +
          ' · last scan ' + formatWhen(f.lastIngestedAt) + missing + '</div>' +
          '<div class="folder-row-actions">' +
          '<button type="button" data-action="scan" data-id="' + esc(f.id) + '">Scan now</button>' +
          '<button type="button" class="secondary" data-action="remove" data-id="' + esc(f.id) + '">Stop watching</button>' +
          '</div></li>';
      }).join("");
    }
    async function readJson(res) {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || res.statusText || "Request failed");
      return data;
    }
    async function refreshFolderList() {
      const data = await readJson(await fetch(api("/memory/ingest/folders"), {
        headers: { accept: "application/json" },
      }));
      renderFolders(data.folders || []);
      return data;
    }
    async function addFolder(path, label) {
      const trimmed = String(path || "").trim();
      const name = String(label || "").trim();
      if (!trimmed) throw new Error("Choose or paste a folder path first");
      if (!name) throw new Error("Label is required — it becomes the hub in the memory graph");
      if (folderWatch) folderWatch.disabled = true;
      if (folderPick) folderPick.disabled = true;
      try {
        setFolderStatus("Registering folder…");
        const body = new FormData();
        body.set("path", trimmed);
        body.set("label", name);
        // Register immediately so the list updates even if the first scan is slow.
        body.set("ingest", "0");
        const registered = await readJson(await fetch(api("/memory/ingest/folders"), {
          method: "POST",
          headers: { accept: "application/json" },
          body,
        }));
        renderFolders(registered.folders || []);
        const sourceId = registered.source && registered.source.id;
        if (!sourceId) throw new Error("Folder registered but no id returned");
        setFolderStatus("Now watching. Running first scan…");
        setRowBusy(sourceId, true, "Scanning…");
        await paint();

        const scanBody = new FormData();
        scanBody.set("id", sourceId);
        const scanned = await readJson(await fetch(api("/memory/ingest/folders/scan"), {
          method: "POST",
          headers: { accept: "application/json" },
          body: scanBody,
        }));
        renderFolders(scanned.folders || []);
        folderPath.value = "";
        folderLabel.value = "";
        setFolderStatus(
          scanned.run && scanned.run.speech
            ? scanned.run.speech
            : "Now watching that folder.",
        );
      } catch (err) {
        // Folder may already be registered — refresh list so the UI isn't stuck empty.
        try { await refreshFolderList(); } catch { /* ignore */ }
        throw err;
      } finally {
        if (folderWatch) folderWatch.disabled = false;
        if (folderPick) folderPick.disabled = false;
      }
    }
    folderForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await addFolder(folderPath.value.trim(), folderLabel.value.trim());
      } catch (err) {
        setFolderStatus(err.message || String(err), true);
      }
    });
    folderWatch?.addEventListener("click", async () => {
      try {
        await addFolder(folderPath.value.trim(), folderLabel.value.trim());
      } catch (err) {
        setFolderStatus(err.message || String(err), true);
      }
    });
    folderPick.addEventListener("click", async () => {
      setFolderStatus("Opening folder picker…");
      try {
        const data = await readJson(await fetch(api("/memory/ingest/folders/pick"), { method: "POST" }));
        folderPath.value = data.path || "";
        if (!folderLabel.value.trim()) {
          folderLabel.value = String(data.path || "").replace(new RegExp("/$"), "").split("/").pop() || "";
        }
        folderLabel.focus();
        setFolderStatus("Name this collection (required), then click “Watch this folder”.");
      } catch (err) {
        if (/cancelled/i.test(err.message || "")) {
          setFolderStatus("");
          return;
        }
        setFolderStatus(err.message || String(err), true);
      }
    });
    folderList.addEventListener("click", async (ev) => {
      const el = ev.target instanceof Element ? ev.target : ev.target.parentElement;
      const btn = el && el.closest("button[data-action]");
      if (!btn || btn.disabled) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      try {
        if (action === "remove") {
          setFolderStatus("Removing…");
          setRowBusy(id, true, "Removing…");
          await paint();
          const data = await postFolderAction("/memory/ingest/folders/remove", id);
          renderFolders(data.folders || []);
          setFolderStatus("Stopped watching that folder.");
        } else if (action === "scan") {
          setFolderStatus("Scanning…");
          setRowBusy(id, true, "Scanning…");
          await paint();
          const data = await postFolderAction("/memory/ingest/folders/scan", id);
          renderFolders(data.folders || []);
          const speech = data.run && data.run.speech ? data.run.speech : "Scan finished.";
          setFolderStatus(speech);
          setRowBusy(id, false, speech);
        }
      } catch (err) {
        setRowBusy(id, false);
        setFolderStatus(err.message || String(err), true);
      }
    });
    refreshFolderList().catch(() => {});

    const voiceForm = document.getElementById("voice-folder-form");
    const voicePath = document.getElementById("voice-folder-path");
    const voiceLabel = document.getElementById("voice-folder-label");
    const voicePick = document.getElementById("voice-folder-pick");
    const voiceWatch = document.getElementById("voice-folder-watch");
    const voicePause = document.getElementById("voice-folder-pause");
    const voiceStatus = document.getElementById("voice-folder-status");
    const voiceList = document.getElementById("voice-folder-list");
    function setVoiceStatus(text, isError) {
      voiceStatus.textContent = text || "";
      voiceStatus.style.color = isError ? "#d7a07a" : "var(--ink)";
    }
    function renderVoiceFolders(folders) {
      if (!folders.length) {
        voiceList.innerHTML = '<li class="empty">No voice-note folders yet.</li>';
        return;
      }
      voiceList.innerHTML = folders.map((f) => {
        const missing = f.exists ? "" : '<span class="missing"> · folder missing</span>';
        return '<li data-id="' + esc(f.id) + '"><strong>' + esc(f.label) + '</strong>' +
          '<code class="folder-path">' + esc(f.path) + '</code>' +
          '<div class="folder-meta">' + f.trackedFiles + ' done · ' + (f.processing || 0) + ' in progress · ' + f.queued + ' queued · ' + f.failed + ' failed' + missing + '</div>' +
          '<div class="folder-row-actions">' +
          '<button type="button" data-action="scan" data-id="' + esc(f.id) + '">Scan now</button>' +
          '<button type="button" class="secondary" data-action="remove" data-id="' + esc(f.id) + '">Remove</button>' +
          '</div></li>';
      }).join("");
    }
    async function refreshVoiceFolders() {
      const data = await readJson(await fetch(api("/memory/ingest/voice-folders"), {
        headers: { accept: "application/json" },
      }));
      renderVoiceFolders(data.folders || []);
      if (data.queue && data.queue.message) setVoiceStatus(data.queue.message);
      if (voicePause) voicePause.textContent = data.queue && data.queue.folderQueuePaused ? "Resume folder queue" : "Pause folder queue";
      return data;
    }
    voiceWatch.addEventListener("click", async () => {
      try {
        setVoiceStatus("Scanning folder into the notes queue…");
        const body = new FormData();
        body.set("path", voicePath.value.trim());
        body.set("label", voiceLabel.value.trim());
        const data = await readJson(await fetch(api("/memory/ingest/voice-folders"), {
          method: "POST",
          headers: { accept: "application/json" },
          body,
        }));
        renderVoiceFolders(data.folders || []);
        setVoiceStatus("Queued " + (data.enqueued || 0) + " recordings. One at a time; iPhone uploads jump the line.");
      } catch (err) {
        setVoiceStatus(err.message || String(err), true);
      }
    });
    voicePick.addEventListener("click", async () => {
      setVoiceStatus("Opening folder picker…");
      try {
        const data = await readJson(await fetch(api("/memory/ingest/voice-folders/pick"), { method: "POST" }));
        voicePath.value = data.path || "";
        if (!voiceLabel.value.trim()) {
          voiceLabel.value = String(data.path || "").replace(new RegExp("/$"), "").split("/").pop() || "";
        }
        voiceLabel.focus();
        setVoiceStatus("Name this collection, then click Scan this folder.");
      } catch (err) {
        if (/cancelled/i.test(err.message || "")) {
          setVoiceStatus("");
          return;
        }
        setVoiceStatus(err.message || String(err), true);
      }
    });
    voicePause.addEventListener("click", async () => {
      const data = await readJson(await fetch(api("/memory/ingest/voice-folders"), {
        headers: { accept: "application/json" },
      }));
      const next = !(data.queue && data.queue.folderQueuePaused);
      const updated = await readJson(await fetch(api("/memory/ingest/voice-folders/pause"), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ paused: next }),
      }));
      renderVoiceFolders(updated.folders || []);
      setVoiceStatus(updated.queue && updated.queue.message ? updated.queue.message : (next ? "Folder queue paused." : "Folder queue resumed."));
      voicePause.textContent = next ? "Resume folder queue" : "Pause folder queue";
    });
    voiceList.addEventListener("click", async (ev) => {
      const el = ev.target instanceof Element ? ev.target : ev.target.parentElement;
      const btn = el && el.closest("button[data-action]");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      try {
        if (action === "remove") {
          const data = await postFolderAction("/memory/ingest/voice-folders/remove", id);
          renderVoiceFolders(data.folders || []);
          setVoiceStatus("Removed that voice-note folder.");
        } else if (action === "scan") {
          setVoiceStatus("Scanning…");
          const data = await postFolderAction("/memory/ingest/voice-folders/scan", id);
          renderVoiceFolders(data.folders || []);
          setVoiceStatus("Queued " + (data.enqueued || 0) + " recordings.");
        }
      } catch (err) {
        setVoiceStatus(err.message || String(err), true);
      }
    });
    refreshVoiceFolders().catch(() => {});
    setInterval(() => { refreshVoiceFolders().catch(() => {}); }, 3000);

    const discoverBtn = document.getElementById("discover-links");
    const discoverStatus = document.getElementById("discover-status");
    const discoverResult = document.getElementById("discover-result");
    const elJob = document.getElementById("job-progress");
    const elJobTitle = document.getElementById("job-progress-title");
    const elJobLabel = document.getElementById("job-progress-label");
    const elJobBar = document.getElementById("job-progress-bar");
    const elJobFill = document.getElementById("job-progress-fill");
    const elJobCount = document.getElementById("job-progress-count");
    const elJobPct = document.getElementById("job-progress-pct");
    function showJobProgress(title) {
      if (!elJob) return;
      elJob.hidden = false;
      elJob.classList.remove("err");
      requestAnimationFrame(function () { elJob.classList.add("on"); });
      if (elJobTitle) elJobTitle.textContent = title;
      setJobProgress({ label: "Starting…", percent: 0, current: 0, total: 0 });
    }
    function setJobProgress(progress) {
      if (!elJob) return;
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      if (elJobLabel) elJobLabel.textContent = progress.label || "";
      if (elJobFill) elJobFill.style.width = percent + "%";
      if (elJobPct) elJobPct.textContent = percent + "%";
      const current = Number(progress.current) || 0;
      const total = Number(progress.total) || 0;
      if (elJobCount) elJobCount.textContent = total > 0 ? current + " / " + total : "";
      if (elJobBar) {
        elJobBar.setAttribute("aria-valuenow", String(percent));
        elJobBar.setAttribute("aria-valuetext", progress.label || percent + "%");
      }
    }
    function hideJobProgress(delayMs) {
      if (!elJob) return;
      window.setTimeout(function () {
        elJob.classList.remove("on");
        window.setTimeout(function () { elJob.hidden = true; }, 200);
      }, delayMs == null ? 900 : delayMs);
    }
    function failJobProgress(message) {
      if (!elJob) return;
      elJob.classList.add("err");
      setJobProgress({ label: message || "Find connections failed", percent: 100, current: 0, total: 0 });
      hideJobProgress(3200);
    }
    async function readSseResponse(res, onProgress) {
      const ctype = res.headers.get("content-type") || "";
      if (ctype.indexOf("application/json") >= 0) {
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.message || data.error || "Find connections failed (" + res.status + ")");
        return data;
      }
      if (!res.body) throw new Error("Find connections failed (" + res.status + ")");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let result = null;
      let streamError = null;
      function consumeBlock(chunk) {
        let event = "message";
        const dataLines = [];
        chunk.split("\\n").forEach(function (line) {
          if (line.indexOf("event:") === 0) event = line.slice(6).trim();
          else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).replace(/^\\s+/, ""));
        });
        if (!dataLines.length) return;
        const data = JSON.parse(dataLines.join("\\n"));
        if (event === "progress") onProgress(data);
        else if (event === "done") result = data;
        else if (event === "error") streamError = data;
      }
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        buf += decoder.decode(step.value, { stream: true });
        const blocks = buf.split("\\n\\n");
        buf = blocks.pop() || "";
        blocks.forEach(consumeBlock);
      }
      if (buf.trim()) consumeBlock(buf);
      if (streamError) throw new Error(streamError.message || streamError.error || "Find connections failed");
      if (!res.ok && !result) throw new Error("Find connections failed (" + res.status + ")");
      return result || {};
    }
    discoverBtn.addEventListener("click", async function () {
      discoverResult.hidden = true;
      discoverResult.innerHTML = "";
      discoverStatus.classList.remove("is-error");
      discoverStatus.textContent = "Finding connections…";
      discoverBtn.disabled = true;
      showJobProgress("Find connections");
      try {
        const res = await fetch(api("/memory/ingest/discover-links"), {
          method: "POST",
          headers: { accept: "text/event-stream", "content-type": "application/json" },
          body: "{}",
        });
        const data = await readSseResponse(res, setJobProgress);
        setJobProgress({ label: "Done", percent: 100, current: 1, total: 1 });
        const created = data.created || 0;
        const hubs = data.hubsCreated || 0;
        const createdBits = [];
        if (created) createdBits.push(created + " link" + (created === 1 ? "" : "s"));
        if (hubs) createdBits.push(hubs + " concept hub" + (hubs === 1 ? "" : "s"));
        discoverStatus.textContent = createdBits.length
          ? "Created " + createdBits.join(" and ") + "."
          : (data.hubsReused || data.membersLinked)
            ? "Grouped memories under existing hubs."
            : "No new connections.";
        const bits = [];
        bits.push("<p>Catalog " + (data.catalogSize || 0) + " · proposed " + (data.proposals || 0) +
          " · links " + created +
          " · hubs created " + hubs +
          " · hubs reused " + (data.hubsReused || 0) +
          " · memories grouped " + (data.membersLinked || 0) +
          " · skipped already linked " + (data.skippedAlreadyLinked || 0) +
          " · skipped invalid " + (data.skippedInvalid || 0) + "</p>");
        if (Array.isArray(data.groupSamples) && data.groupSamples.length) {
          bits.push("<p>" + data.groupSamples.map(function (g) {
            return "<strong>" + esc(g.name) + "</strong>" + (g.reused ? " (existing)" : "") +
              " ← " + esc((g.members || []).join(", "));
          }).join("<br/>") + "</p>");
        }
        if (Array.isArray(data.samples) && data.samples.length) {
          bits.push("<p>" + data.samples.map(function (s) {
            return esc(s.from) + " → " + esc(s.predicate) + " → " + esc(s.to);
          }).join("<br/>") + "</p>");
        }
        bits.push('<p><a href="/memory/graph">Browse graph</a></p>');
        discoverResult.innerHTML = bits.join("");
        discoverResult.hidden = false;
        hideJobProgress();
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        discoverStatus.classList.add("is-error");
        discoverStatus.textContent = message;
        failJobProgress(message);
      } finally {
        discoverBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function errorPageHtml(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alfred — Ingest failed</title>
  <style>
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: Georgia, serif; background: #1a1f1c; color: #e8efe6; padding: 2rem;
    }
    main { width: min(36rem, 100%); border: 1px solid #3a463d; padding: 1.75rem; background: #243028; }
    a { color: #c4a35a; }
    .err { color: #d7a07a; }
  </style>
</head>
<body>
  <main>
    <h1>Ingest failed</h1>
    <p class="err">${escapeHtml(message)}</p>
    <p><a href="/memory/ingest">Back to ingest</a></p>
  </main>
  ${EMBED_BRIDGE}
</body>
</html>`;
}

function successPageHtml(result: IngestFileResult): string {
  if (result.mode === "node-bundle" && result.merge) {
    const m = result.merge;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alfred — Memory merged</title>
  <style>
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: Georgia, serif; background: #1a1f1c; color: #e8efe6; padding: 2rem;
    }
    main { width: min(36rem, 100%); border: 1px solid #3a463d; padding: 1.75rem; background: #243028; }
    a { color: #c4a35a; }
    code { font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
  </style>
</head>
<body>
  <main>
    <h1>Memory merged</h1>
    <p><strong>${escapeHtml(result.filename)}</strong> → local OIP store</p>
    <p>Packages added: <strong>${m.packagesAdded}</strong>,
      merged: <strong>${m.packagesMerged}</strong>,
      unchanged: <strong>${m.packagesUnchanged}</strong></p>
    <p>Revisions added: <strong>${m.revisionsAdded}</strong>,
      head updates: <strong>${m.currentHeadUpdates}</strong></p>
    <p>Artifacts added: <strong>${m.artifactsAdded}</strong>
      (skipped existing: ${m.artifactsSkipped})</p>
    <p>Root: <code>${escapeHtml(m.root)}</code></p>
    ${
      m.errors.length
        ? `<p>Warnings/errors: ${m.errors.length}</p><ul>${m.errors
            .slice(0, 8)
            .map((e) => `<li>${escapeHtml(e)}</li>`)
            .join("")}</ul>`
        : ""
    }
    <p><a href="/memory/graph">Browse graph</a> · <a href="/memory/ingest">Ingest another</a></p>
  </main>
  ${EMBED_BRIDGE}
</body>
</html>`;
  }

  const c = result.created;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alfred — Ingested</title>
  <style>
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: Georgia, serif; background: #1a1f1c; color: #e8efe6; padding: 2rem;
    }
    main { width: min(36rem, 100%); border: 1px solid #3a463d; padding: 1.75rem; background: #243028; }
    a { color: #c4a35a; }
    code { font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
  </style>
</head>
<body>
  <main>
    <h1>Ingested</h1>
    <p><strong>${escapeHtml(result.filename)}</strong> → <code>${escapeHtml(result.providerId)}</code> (<code>${escapeHtml(result.mode)}</code>)</p>
    ${
      result.mode === "photo" && "label" in result && result.label
        ? `<p>Label hub: <strong>${escapeHtml(String(result.label))}</strong></p>`
        : ""
    }
    ${
      result.mode === "photo" && "filenames" in result && Array.isArray(result.filenames) && result.filenames.length > 1
        ? `<p>${result.filenames.length} photos: ${escapeHtml(result.filenames.join(", "))}</p>`
        : ""
    }
    <p>${result.textChars} characters analyzed${
      (result.mode === "document" || result.mode === "photo") && result.pages != null
        ? ` across ${result.pages} page${result.pages === 1 ? "" : "s"}`
        : ""
    }${
      (result.mode === "document" || result.mode === "photo") && result.sections != null
        ? ` → ${result.sections} section${result.sections === 1 ? "" : "s"}`
        : ""
    }.</p>
    ${
      result.mode === "document" || result.mode === "photo"
        ? "<p>USER.md was not changed.</p>"
        : `<p>USER.md updated: <strong>${result.userMdUpdated ? "yes" : "no"}</strong>
      ${result.userSections.length ? `(${escapeHtml(result.userSections.join(", "))})` : ""}</p>`
    }
    <p>Created records —
      entities ${c.entities},
      episodes ${c.episodes},
      assertions ${c.assertions},
      observations ${c.observations},
      notes ${c.notes}</p>
    ${
      "artifactId" in result && result.artifactId
        ? `<p>Source artifact: <code>${escapeHtml(result.artifactId)}</code></p>`
        : ""
    }
    ${
      "userMdPath" in result && result.userMdPath
        ? `<p>USER.md: <code>${escapeHtml(result.userMdPath)}</code></p>`
        : ""
    }
    <p>Root: <code>${escapeHtml(result.root)}</code></p>
    ${
      result.errors.length
        ? `<p>Warnings: ${result.errors.length} (see JSON response / logs)</p>`
        : ""
    }
    <p><a href="/memory/ingest">Ingest another</a></p>
  </main>
  ${EMBED_BRIDGE}
</body>
</html>`;
}

function renderVoiceFolderListItems(folders: AudioNoteFolderRow[]): string {
  if (!folders.length) {
    return `<li class="empty">No voice-note folders yet.</li>`;
  }
  return folders
    .map((f) => {
      const missing = f.exists ? "" : `<span class="missing"> · folder missing</span>`;
      return `<li data-id="${escapeHtml(f.id)}"><strong>${escapeHtml(f.label)}</strong>
        <code class="folder-path">${escapeHtml(f.path)}</code>
        <div class="folder-meta">${f.trackedFiles} done · ${f.queued} queued · ${f.failed} failed${missing}</div>
        <div class="folder-row-actions">
          <button type="button" data-action="scan" data-id="${escapeHtml(f.id)}">Scan now</button>
          <button type="button" class="secondary" data-action="remove" data-id="${escapeHtml(f.id)}">Remove</button>
        </div></li>`;
    })
    .join("");
}

function renderFolderListItems(folderList: DocsFolderList): string {
  if (!folderList.folders.length) {
    return `<li class="empty">No markdown folders are being scanned yet.</li>`;
  }
  return folderList.folders
    .map((f) => {
      const when = f.lastIngestedAt
        ? escapeHtml(new Date(f.lastIngestedAt).toLocaleString())
        : "not scanned yet";
      const missing = f.exists ? "" : `<span class="missing"> · folder missing</span>`;
      const files = `${f.trackedFiles} file${f.trackedFiles === 1 ? "" : "s"}`;
      return `<li data-id="${escapeHtml(f.id)}"><strong>${escapeHtml(f.label)}</strong>
        <code class="folder-path">${escapeHtml(f.path)}</code>
        <div class="folder-meta">${files} · last scan ${when}${missing}</div>
        <div class="folder-row-actions">
          <button type="button" data-action="scan" data-id="${escapeHtml(f.id)}">Scan now</button>
          <button type="button" class="secondary" data-action="remove" data-id="${escapeHtml(f.id)}">Stop watching</button>
        </div></li>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

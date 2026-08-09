/**
 * /memory — local memory ingest UI + API
 *
 * GET  /memory/ingest  — browser form to upload .txt / .md / .rtf
 * POST /memory/ingest  — multipart upload (field: file) or raw text body
 */

import { Hono } from "hono";
import { ingestTextFile } from "../lib/memory-ingest.js";
import { kindFromFilename } from "../lib/text-extract.js";

export const memoryRouter = new Hono();

memoryRouter.get("/ingest", (c) => {
  const providerId = process.env.ALFRED_MEMORY_PROVIDER_ID ?? "memory.oip-local";
  return c.html(ingestPageHtml(providerId));
});

memoryRouter.post("/ingest", async (c) => {
  try {
    const contentType = c.req.header("content-type") ?? "";

    let filename = "upload.txt";
    let bytes: Buffer;

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!file || typeof file === "string" || Array.isArray(file)) {
        return c.json({ error: "missing_file", message: "multipart field 'file' is required" }, 400);
      }
      filename = file.name || filename;
      bytes = Buffer.from(await file.arrayBuffer());
    } else if (
      contentType.includes("text/plain") ||
      contentType.includes("text/markdown") ||
      contentType.includes("application/rtf") ||
      contentType.includes("text/rtf")
    ) {
      const qName = c.req.query("filename");
      if (qName) filename = qName;
      else if (contentType.includes("markdown")) filename = "upload.md";
      else if (contentType.includes("rtf")) filename = "upload.rtf";
      bytes = Buffer.from(await c.req.arrayBuffer());
    } else {
      // Try multipart-less form field `text` + optional `filename`
      const body = await c.req.parseBody();
      const text = typeof body.text === "string" ? body.text : null;
      if (!text) {
        return c.json(
          {
            error: "unsupported_content_type",
            message:
              "Send multipart file field 'file', or text/plain|text/markdown|application/rtf body",
          },
          415,
        );
      }
      if (typeof body.filename === "string" && body.filename) filename = body.filename;
      bytes = Buffer.from(text, "utf8");
    }

    if (kindFromFilename(filename) === "unknown") {
      return c.json(
        { error: "unsupported_extension", message: "Use .txt, .md, or .rtf" },
        400,
      );
    }

    if (!bytes.byteLength) {
      return c.json({ error: "empty_file", message: "Uploaded file is empty" }, 400);
    }

    const result = await ingestTextFile({ filename, bytes });
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html") && contentType.includes("multipart/form-data")) {
      return c.html(successPageHtml(result));
    }
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "ingest_failed", message }, 400);
  }
});

function ingestPageHtml(providerId: string): string {
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
      width: min(34rem, 100%);
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
      margin: 0 0 1.4rem;
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
    input[type="file"] {
      width: 100%;
      color: var(--ink);
      margin-bottom: 1.25rem;
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
  </style>
</head>
<body>
  <main>
    <h1><span class="brand">Alfred</span> memory ingest</h1>
    <p>Upload a <code>.txt</code>, <code>.md</code>, or <code>.rtf</code> file. It will be stored in the local memory provider (<code>${escapeHtml(providerId)}</code>).</p>
    <form method="post" action="/memory/ingest" enctype="multipart/form-data">
      <label for="file">Text file</label>
      <input id="file" name="file" type="file" accept=".txt,.md,.markdown,.rtf,text/plain,text/markdown,application/rtf" required />
      <button type="submit">Ingest into memory</button>
    </form>
    <p class="meta">POST /memory/ingest · multipart field <code>file</code></p>
  </main>
</body>
</html>`;
}

function successPageHtml(result: {
  filename: string;
  providerId: string;
  textChars: number;
  observationId?: string;
  artifactId?: string;
  noteId?: string;
  root: string;
}): string {
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
    main { width: min(34rem, 100%); border: 1px solid #3a463d; padding: 1.75rem; background: #243028; }
    a { color: #c4a35a; }
    code { font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
  </style>
</head>
<body>
  <main>
    <h1>Ingested</h1>
    <p><strong>${escapeHtml(result.filename)}</strong> → <code>${escapeHtml(result.providerId)}</code></p>
    <p>${result.textChars} characters stored.</p>
    ${result.observationId ? `<p>Observation: <code>${escapeHtml(result.observationId)}</code></p>` : ""}
    ${result.artifactId ? `<p>Artifact: <code>${escapeHtml(result.artifactId)}</code></p>` : ""}
    ${result.noteId ? `<p>Note: <code>${escapeHtml(result.noteId)}</code></p>` : ""}
    <p>Root: <code>${escapeHtml(result.root)}</code></p>
    <p><a href="/memory/ingest">Ingest another</a></p>
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

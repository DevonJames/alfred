/**
 * /memory — local memory ingest UI + API
 *
 * GET  /memory/ingest  — browser form (LLM Knowledge Export, Document, or Alfred Memory File)
 * POST /memory/ingest  — multipart upload (fields: mode, file) or raw body
 *
 * Knowledge: Alfred knowledge-export JSON (see docs/knowledge-export-prompt.md),
 *            plus markdown/txt/rtf via section-split + USER.md patch.
 * Document:  one-shot PDF upload → artifact + page/section memories.
 * Node bundle: .alfred-memory.zip from another Alfred node → union merge into local OIP.
 */

import { Hono } from "hono";
import type { IngestFileResult, IngestUploadMode } from "../lib/memory-ingest.js";
import { ingestUploadedFile } from "../lib/memory-ingest.js";
import { kindFromFilename } from "../lib/text-extract.js";
import { memoryGraphRouter } from "./memory-graph.js";

export const memoryRouter = new Hono();

memoryRouter.route("/graph", memoryGraphRouter);

memoryRouter.get("/ingest", (c) => {
  const providerId = process.env.ALFRED_MEMORY_PROVIDER_ID ?? "memory.oip-local";
  return c.html(ingestPageHtml(providerId));
});

memoryRouter.post("/ingest", async (c) => {
  try {
    const contentType = c.req.header("content-type") ?? "";

    let filename = "upload.txt";
    let bytes: Buffer;
    let ingestMode: IngestUploadMode = "knowledge";

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      if (typeof body.mode === "string") {
        if (body.mode === "document") ingestMode = "document";
        else if (body.mode === "node-bundle") ingestMode = "node-bundle";
      }
      const file = body.file;
      if (!file || typeof file === "string" || Array.isArray(file)) {
        return c.json({ error: "missing_file", message: "multipart field 'file' is required" }, 400);
      }
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
    } else if (kind === "pdf") {
      return c.json(
        {
          error: "unsupported_extension",
          message: "PDFs use Document mode. Choose Document in the ingest form.",
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

    const result = await ingestUploadedFile({ filename, bytes, mode: ingestMode });
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
    ul { color: var(--muted); margin: 0 0 1.2rem 1.1rem; padding: 0; line-height: 1.4; }
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
    <form method="post" action="/memory/ingest" enctype="multipart/form-data">
      <label for="mode">What are you uploading?</label>
      <select id="mode" name="mode">
        <option value="knowledge" selected>LLM Knowledge Export</option>
        <option value="document">Document</option>
        <option value="node-bundle">Alfred Memory File from Another Node</option>
      </select>
      <label for="file" id="file-label">Knowledge export</label>
      <input id="file" name="file" type="file" accept=".json,.txt,.md,.markdown,.rtf,application/json,text/plain,text/markdown,application/rtf" required />
      <button type="submit">Analyze &amp; ingest</button>
    </form>
    <p class="meta">POST /memory/ingest · fields <code>mode</code>, <code>file</code> · <a href="/memory/graph" style="color:var(--accent)">Browse graph</a></p>
  </main>
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
      if (m === "document") {
        file.accept = ".pdf,application/pdf";
        label.textContent = "PDF document";
        intro.textContent = "Upload a PDF. Alfred will:";
        bullets.innerHTML = "<li>Extract text from each page</li><li>Store verbatim page sections as OIP memories</li><li>Keep the original PDF as a content-addressed artifact</li>";
        hint.innerHTML = "USER.md is not changed. Scanned image-only PDFs cannot be ingested. Provider: <code>" + provider + "</code>.";
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
  </script>
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
    <p>${result.textChars} characters analyzed${
      result.mode === "document" && result.pages != null
        ? ` across ${result.pages} page${result.pages === 1 ? "" : "s"}`
        : ""
    }${
      result.mode === "document" && result.sections != null
        ? ` → ${result.sections} section${result.sections === 1 ? "" : "s"}`
        : ""
    }.</p>
    ${
      result.mode === "document"
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

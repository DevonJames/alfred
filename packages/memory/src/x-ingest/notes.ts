import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractXUrls } from "./urls.js";

const execFileAsync = promisify(execFile);

export interface NotesNote {
  name: string;
  folder: string;
  body: string;
}

export type NotesRunner = (script: string) => Promise<string>;

export async function defaultNotesRunner(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.toString();
}

function jxaEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

const FIND_NOTE_SCRIPT = (folder: string, note: string) => `
function run() {
  const Notes = Application("Notes");
  const folderName = "${jxaEscape(folder)}";
  const noteName = "${jxaEscape(note)}";
  function walkFolders(folders) {
    const found = [];
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      try { found.push(f); } catch (e) {}
      try {
        const kids = f.folders;
        if (kids && kids.length) found.push.apply(found, walkFolders(kids));
      } catch (e) {}
    }
    return found;
  }
  const allFolders = walkFolders(Notes.folders);
  let matchFolder = null;
  for (const f of allFolders) {
    try {
      if (String(f.name()) === folderName) { matchFolder = f; break; }
    } catch (e) {}
  }
  const searchNotes = matchFolder ? matchFolder.notes : Notes.notes;
  for (let i = 0; i < searchNotes.length; i++) {
    const n = searchNotes[i];
    try {
      if (String(n.name()) === noteName) {
        return JSON.stringify({
          ok: true,
          name: String(n.name()),
          folder: matchFolder ? String(matchFolder.name()) : folderName,
          body: String(n.body())
        });
      }
    } catch (e) {}
  }
  return JSON.stringify({ ok: false, error: "note_not_found" });
}
`;

const SET_NOTE_SCRIPT = (folder: string, note: string, body: string) => `
function run() {
  const Notes = Application("Notes");
  const folderName = "${jxaEscape(folder)}";
  const noteName = "${jxaEscape(note)}";
  const newBody = "${jxaEscape(body)}";
  function walkFolders(folders) {
    const found = [];
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      try { found.push(f); } catch (e) {}
      try {
        const kids = f.folders;
        if (kids && kids.length) found.push.apply(found, walkFolders(kids));
      } catch (e) {}
    }
    return found;
  }
  const allFolders = walkFolders(Notes.folders);
  let matchFolder = null;
  for (const f of allFolders) {
    try {
      if (String(f.name()) === folderName) { matchFolder = f; break; }
    } catch (e) {}
  }
  const searchNotes = matchFolder ? matchFolder.notes : Notes.notes;
  for (let i = 0; i < searchNotes.length; i++) {
    const n = searchNotes[i];
    try {
      if (String(n.name()) === noteName) {
        n.body = newBody;
        return JSON.stringify({ ok: true });
      }
    } catch (e) {}
  }
  const account = Notes.defaultAccount;
  const created = Notes.Note({ name: noteName, body: newBody });
  if (matchFolder) {
    matchFolder.notes.push(created);
  } else {
    Notes.notes.push(created);
  }
  return JSON.stringify({ ok: true, created: true });
}
`;

export async function readAppleNote(
  folder: string,
  note: string,
  runner: NotesRunner = defaultNotesRunner,
): Promise<NotesNote> {
  const out = await runner(FIND_NOTE_SCRIPT(folder, note));
  const parsed = JSON.parse(out.trim() || "{}") as {
    ok?: boolean;
    name?: string;
    folder?: string;
    body?: string;
    error?: string;
  };
  if (!parsed.ok) {
    throw new Error(
      `Apple Note not found: folder="${folder}" note="${note}"${parsed.error ? ` (${parsed.error})` : ""}`,
    );
  }
  return {
    name: parsed.name ?? note,
    folder: parsed.folder ?? folder,
    body: parsed.body ?? "",
  };
}

export async function writeAppleNote(
  folder: string,
  note: string,
  body: string,
  runner: NotesRunner = defaultNotesRunner,
): Promise<void> {
  const out = await runner(SET_NOTE_SCRIPT(folder, note, body));
  const parsed = JSON.parse(out.trim() || "{}") as { ok?: boolean };
  if (!parsed.ok) {
    throw new Error(`Failed to write Apple Note: folder="${folder}" note="${note}"`);
  }
}

export function extractInboxUrls(body: string): string[] {
  return extractXUrls(body);
}

export function removeUrlFromNoteBody(body: string, url: string): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let next = body.replace(new RegExp(`<a[^>]*href="${escaped}"[^>]*>[\\s\\S]*?<\\/a>`, "gi"), "");
  next = next.replace(new RegExp(escaped, "gi"), "");
  return next.replace(/\n{3,}/g, "\n\n");
}

export function annotateFailureInNoteBody(body: string, url: string, reason: string): string {
  if (body.includes(`${url} — failed:`)) return body;
  const suffix = ` — failed: ${reason}`;
  if (body.includes(url)) return body.replace(url, `${url}${suffix}`);
  return `${body.trim()}\n${url}${suffix}\n`;
}

export function appendArchiveLine(
  body: string,
  line: { date: string; author?: string; headline: string; url: string },
): string {
  const author = line.author ? `${line.author} — ` : "";
  const html = `<div>${line.date} — ${escapeHtml(author)}${escapeHtml(line.headline)} — ${escapeHtml(line.url)}</div>`;
  const trimmed = body.trim();
  if (!trimmed) {
    return `<div><b>Ingested</b></div>${html}`;
  }
  return `${trimmed}\n${html}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

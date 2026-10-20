import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRepoRoot } from "./local-provider.js";

export const TALK_FOCUS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const TALK_FOCUS_PROMPT_CHARS = 24_000;
export const TALK_FOCUS_VOICE_CHARS = 4_000;

export interface TalkFocus {
  did: string;
  name: string;
  type: string;
  text: string;
  setAt: string;
}

export function talkFocusPath(): string {
  const override = process.env.ALFRED_TALK_FOCUS_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveRepoRoot(), "data", "desktop-client", "talk-focus.json");
}

export async function readTalkFocus(now = Date.now()): Promise<TalkFocus | null> {
  try {
    const raw = await readFile(talkFocusPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TalkFocus>;
    if (typeof parsed.did !== "string" || !parsed.did.trim()) return null;
    const setAt = typeof parsed.setAt === "string" ? Date.parse(parsed.setAt) : NaN;
    if (Number.isFinite(setAt) && now - setAt > TALK_FOCUS_MAX_AGE_MS) return null;
    return {
      did: parsed.did.trim(),
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Memory",
      type: typeof parsed.type === "string" ? parsed.type : "Entity",
      text: typeof parsed.text === "string" ? parsed.text : "",
      setAt: typeof parsed.setAt === "string" ? parsed.setAt : new Date(now).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeTalkFocus(focus: TalkFocus): Promise<void> {
  const file = talkFocusPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(focus, null, 2)}\n`, "utf8");
}

export async function clearTalkFocus(): Promise<void> {
  const empty: TalkFocus = {
    did: "",
    name: "",
    type: "",
    text: "",
    setAt: "1970-01-01T00:00:00.000Z",
  };
  try {
    await writeTalkFocus(empty);
  } catch {
    /* ignore */
  }
}

export function formatTalkFocusSystem(focus: TalkFocus, maxChars = TALK_FOCUS_PROMPT_CHARS): string {
  const body = focus.text.replace(/\s+$/, "").trim();
  const clipped = body.length > maxChars;
  const shown = clipped ? body.slice(0, maxChars).trimEnd() : body;
  const lines = [
    "GRAPH TALK FOCUS — the user opened Talk from this memory on the graph. It is already in front of you. Discuss it directly. Do not claim you cannot see it or that you need to look it up first.",
    `Name: ${focus.name}`,
    `Type: ${focus.type}`,
    `Id: ${focus.did}`,
    "",
    shown || "(no body text on this record)",
  ];
  if (clipped) {
    lines.push("", "[clipped — more of this record exists in long-term memory if needed]");
  }
  return lines.join("\n");
}

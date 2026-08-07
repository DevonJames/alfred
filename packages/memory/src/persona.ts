import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersonaContext } from "@alfred/contracts";
import { resolveRepoRoot } from "./local-provider.js";
import {
  DEFAULT_IDENTITY_MD,
  DEFAULT_SOUL_MD,
  DEFAULT_USER_MD,
} from "./persona-templates.js";

export type { PersonaContext };

export const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;
export type PersonaFileName = (typeof PERSONA_FILES)[number];

export interface LoadedPersonaContext extends PersonaContext {
  dir: string;
}

const MAX_CHARS_PER_FILE = 20_000;
/** USER.md is always injected — keep under this or prompts truncate. */
export const USER_MD_MAX_CHARS = 12_000;
const MAX_CHARS_USER = USER_MD_MAX_CHARS;

export function defaultPersonaDir(profileId: string): string {
  const fromEnv = process.env.ALFRED_PERSONA_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(resolveRepoRoot(), "data", "persona", profileId);
}

/**
 * Ensure SOUL / IDENTITY / USER exist (seed defaults). Safe to call on every startup.
 */
export async function ensurePersonaFiles(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const seeds: Record<PersonaFileName, string> = {
    "SOUL.md": DEFAULT_SOUL_MD,
    "IDENTITY.md": DEFAULT_IDENTITY_MD,
    "USER.md": DEFAULT_USER_MD,
  };
  for (const name of PERSONA_FILES) {
    const filePath = path.join(dir, name);
    if (!existsSync(filePath)) {
      await writeFile(filePath, seeds[name], "utf8");
    }
  }
}

/**
 * Load persona markdown for prompt injection. Blank files are skipped.
 * Large files are truncated (OpenClaw-style budgets).
 */
export async function loadPersonaContext(dir: string): Promise<LoadedPersonaContext> {
  const ctx: LoadedPersonaContext = { dir };
  ctx.soul = await readPersonaFile(path.join(dir, "SOUL.md"), MAX_CHARS_PER_FILE);
  ctx.identity = await readPersonaFile(path.join(dir, "IDENTITY.md"), MAX_CHARS_PER_FILE);
  ctx.user = await readPersonaFile(path.join(dir, "USER.md"), MAX_CHARS_USER);
  return ctx;
}

export async function ensureAndLoadPersona(profileId: string): Promise<LoadedPersonaContext> {
  const dir = defaultPersonaDir(profileId);
  await ensurePersonaFiles(dir);
  return loadPersonaContext(dir);
}

async function readPersonaFile(filePath: string, maxChars: number): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = stripFrontmatter(raw).trim();
    if (!trimmed) return undefined;
    if (trimmed.length <= maxChars) return trimmed;
    return (
      trimmed.slice(0, maxChars) +
      `\n\n…[truncated ${trimmed.length - maxChars} chars; edit ${path.basename(filePath)} to shorten]`
    );
  } catch {
    return undefined;
  }
}

/** Drop optional YAML frontmatter used by some OpenClaw templates. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return raw;
  return raw.slice(end + 5);
}

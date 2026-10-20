import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Prompt-generated GPT-Live voice (OpenAI /v1/audio/voices, type=prompt).
 * Named voices stay strings; saved voices are `{ id }` on session.audio.output.voice.
 */
export type GptLiveVoiceSetting = string | { id: string };

export type ResolvedGptLiveVoice = {
  voice: GptLiveVoiceSetting;
  /** Original description. GPT-Live performs better when this is in session instructions. */
  instruction?: string;
  source: "named" | "id" | "created" | "cached";
};

/** Adult voice for Alfred. Qualities only — not a named-person or character clone. */
export const DEFAULT_ALFRED_VOICE_PROMPT =
  "A composed adult male voice in his forties. Refined British English accent, medium-low pitch, clear dry timbre, restrained warmth, moderate vocal effort, and an unhurried precise conversational pace. Polite and slightly formal, never theatrical.";

/** OpenAI rejects a blank or too-short script_hint. Omit it below this length. */
export const MIN_SCRIPT_HINT_CHARS = 400;

/** Representative speech for prompt-to-voice. Register only — not a named person. */
export const DEFAULT_ALFRED_VOICE_SCRIPT = [
  "Good morning. The briefing is prepared, and I shall go through it whenever you wish.",
  "The diary is clear until midday. I shall mention only what requires your attention.",
  "Should you want the headlines, I shall give them in order, and pause should you wish to hear more of any one.",
  "I shall not guess at a figure or a source. Where something is missing, I will say so plainly.",
  "If you require a reminder, tell me the hour and the wording, and I shall set it. If you would prefer silence, you have only to say so.",
  "I am here for the practical matters: the schedule, the notes, the lights, and whatever you ask me to remember.",
  "I shall keep my replies short, precise, and free of chatter.",
  "When a matter needs a moment to look up, I will tell you I am checking, and return with the result.",
  "If you interrupt, I shall stop at once and attend to the new point. That is the arrangement.",
].join(" ");

const VOICE_NAME = "Alfred";

type VoiceCache = {
  id: string;
  prompt: string;
  name: string;
  createdAt: string;
};

function openaiBase(): string {
  const raw = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  return raw.replace(/\/$/, "");
}

function repoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

function cachePath(): string {
  const fromEnv = process.env.ALFRED_GPT_LIVE_VOICE_CACHE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(repoRoot(), "data", "gpt-live", "voice.json");
}

async function readCache(): Promise<VoiceCache | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as Partial<VoiceCache>;
    if (typeof parsed.id === "string" && parsed.id.startsWith("voice_") && typeof parsed.prompt === "string") {
      return {
        id: parsed.id,
        prompt: parsed.prompt,
        name: typeof parsed.name === "string" ? parsed.name : VOICE_NAME,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      };
    }
  } catch {
    /* missing cache */
  }
  return null;
}

async function writeCache(cache: VoiceCache): Promise<void> {
  const file = cachePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function createPromptVoice(opts: {
  apiKey: string;
  name: string;
  prompt: string;
  scriptHint: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const res = await opts.fetchImpl(`${openaiBase()}/audio/voices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "prompt",
      name: opts.name,
      prompt: opts.prompt,
      ...(opts.scriptHint.length >= MIN_SCRIPT_HINT_CHARS ? { script_hint: opts.scriptHint } : {}),
      model: "auto",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) {
    const detail = body.error?.message || res.statusText || `HTTP ${res.status}`;
    throw new Error(`prompt-to-voice failed: ${detail}`);
  }
  return body.id;
}

/**
 * Resolve the GPT-Live voice for this process.
 *
 * Priority:
 * 1. ALFRED_GPT_LIVE_VOICE_ID (saved voice_…)
 * 2. ALFRED_GPT_LIVE_VOICE as a short named voice (ripple, marin, …)
 * 3. Prompt-to-voice: ALFRED_GPT_LIVE_VOICE_PROMPT, or the default Alfred description.
 *    The saved id is cached so sessions reuse one voice (org limit is 100).
 */
export async function resolveGptLiveVoice(opts?: {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  readCache?: () => Promise<VoiceCache | null>;
  writeCache?: (cache: VoiceCache) => Promise<void>;
}): Promise<ResolvedGptLiveVoice> {
  const env = opts?.env ?? process.env;
  const explicitId = env.ALFRED_GPT_LIVE_VOICE_ID?.trim();
  if (explicitId) {
    const id = explicitId.startsWith("voice_") ? explicitId : explicitId;
    return {
      voice: { id },
      instruction: env.ALFRED_GPT_LIVE_VOICE_PROMPT?.trim() || undefined,
      source: "id",
    };
  }

  const named = env.ALFRED_GPT_LIVE_VOICE?.trim();
  if (named && !named.startsWith("voice_") && !/\s/.test(named)) {
    return { voice: named, source: "named" };
  }
  if (named?.startsWith("voice_")) {
    return {
      voice: { id: named },
      instruction: env.ALFRED_GPT_LIVE_VOICE_PROMPT?.trim() || undefined,
      source: "id",
    };
  }

  const prompt = (env.ALFRED_GPT_LIVE_VOICE_PROMPT?.trim() || named || DEFAULT_ALFRED_VOICE_PROMPT).trim();
  const name = env.ALFRED_GPT_LIVE_VOICE_NAME?.trim() || VOICE_NAME;
  const load = opts?.readCache ?? readCache;
  const save = opts?.writeCache ?? writeCache;
  const cached = await load();
  if (cached && cached.prompt === prompt && cached.name === name) {
    return { voice: { id: cached.id }, instruction: prompt, source: "cached" };
  }

  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to create a GPT-Live prompt voice");
  }
  const id = await createPromptVoice({
    apiKey,
    name,
    prompt,
    scriptHint: env.ALFRED_GPT_LIVE_VOICE_SCRIPT?.trim() || DEFAULT_ALFRED_VOICE_SCRIPT,
    fetchImpl: opts?.fetchImpl ?? fetch,
  });
  await save({ id, prompt, name, createdAt: new Date().toISOString() });
  return { voice: { id }, instruction: prompt, source: "created" };
}

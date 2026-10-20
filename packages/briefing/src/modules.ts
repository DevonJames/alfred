import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultBriefingDataDir } from "@alfred/memory";
import type { GreetingLlm } from "./greeting.js";

/** One user-added Daily Brief section, stored outside the memory packages. */
export interface BriefingModuleSetting {
  key: string;
  label: string;
  type: "text" | "boolean";
  default: string | boolean;
}

export interface BriefingModule {
  id: string;
  title: string;
  enabled: boolean;
  fetch: {
    method: "GET";
    url: string;
  };
  settings: BriefingModuleSetting[];
  /** Overrides for setting defaults. */
  values: Record<string, string | boolean>;
  /** Instructions for the spoken summary of the fetched JSON. */
  speech: string;
}

/** What a module contributes to one briefing. */
export interface BriefingModuleResult {
  id: string;
  title: string;
  speech: string;
  lines: string[];
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DRAFT_SYSTEM = `You design one Daily Brief module. Return ONLY JSON with this shape:
{"id":"kebab-case","title":"Short title","fetch":{"method":"GET","url":"https://..."},"settings":[{"key":"sites","label":"Sites","type":"text","default":"11"}],"speech":"How to speak the result in one or two sentences."}
Rules:
- HTTPS GET only. No localhost, no private IPs, no file URLs.
- The URL may contain {{settingKey}} placeholders filled from settings.
- settings is an array, possibly empty. type is "text" or "boolean".
- speech tells a butler how to summarize the JSON aloud. No markdown.
- For upcoming rocket launches, use https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5&location__ids={{sites}} with a text setting key "sites" defaulting to "11" (Vandenberg). Speak only the next launch: provider, mission, weekday, and clock time.
- id is lowercase kebab-case, at most 40 characters.`;

export function briefingModulesDir(profileId?: string, root?: string): string {
  const id = profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const base = root?.trim() ? path.resolve(root) : defaultBriefingDataDir(id);
  return path.join(base, "modules");
}

export function looksLikeAddBriefingModule(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  if (!/\b(add|include|put|create|make)\b/i.test(t)) return false;
  if (!/\b(briefing|daily brief)\b/i.test(t)) return false;
  return (
    /\b(section|module|category|part)\b/i.test(t) ||
    /\b(to|into|in)\s+(my\s+|the\s+)?(daily\s+)?brief/i.test(t)
  );
}

export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Module URL is not valid.");
  }
  if (url.protocol !== "https:") throw new Error("Module URL must be https.");
  if (url.username || url.password) throw new Error("Module URL cannot include credentials.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("Module URL must be a public https host.");
  }
  return url;
}

export function parseBriefingModule(raw: unknown): BriefingModule {
  if (!raw || typeof raw !== "object") throw new Error("Module must be an object.");
  const value = raw as Record<string, unknown>;
  const id = slug(typeof value.id === "string" ? value.id : "");
  if (!id) throw new Error("Module id must be kebab-case.");
  const title = clip(typeof value.title === "string" ? value.title : "", 60);
  if (!title) throw new Error("Module title is required.");
  const fetchBody = value.fetch;
  if (!fetchBody || typeof fetchBody !== "object") throw new Error("Module fetch is required.");
  const fetchUrl = typeof (fetchBody as { url?: unknown }).url === "string"
    ? (fetchBody as { url: string }).url.trim()
    : "";
  if (!fetchUrl || fetchUrl.length > 500) throw new Error("Module URL is missing or too long.");
  assertModuleUrlTemplate(fetchUrl);
  const speech = clip(typeof value.speech === "string" ? value.speech : "", 500);
  if (speech.length < 8) throw new Error("Module speech instructions are required.");
  const settings = parseSettings(value.settings);
  const values = parseValues(value.values, settings);
  return {
    id,
    title,
    enabled: value.enabled !== false,
    fetch: { method: "GET", url: fetchUrl },
    settings,
    values,
    speech,
  };
}

export async function listBriefingModules(
  profileId?: string,
  root?: string,
): Promise<BriefingModule[]> {
  const dir = briefingModulesDir(profileId, root);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const modules: BriefingModule[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, name), "utf8")) as unknown;
      const module = parseBriefingModule(raw);
      if (`${module.id}.json` !== name) continue;
      modules.push(module);
    } catch (err) {
      console.warn(
        `[briefing] skip module ${name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  modules.sort((a, b) => a.title.localeCompare(b.title));
  return modules;
}

export async function saveBriefingModule(
  module: BriefingModule,
  profileId?: string,
  root?: string,
): Promise<BriefingModule> {
  const parsed = parseBriefingModule(module);
  const dir = briefingModulesDir(profileId, root);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${parsed.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return parsed;
}

export async function setBriefingModuleEnabled(
  id: string,
  enabled: boolean,
  profileId?: string,
  root?: string,
  values?: Record<string, string | boolean>,
): Promise<BriefingModule> {
  const modules = await listBriefingModules(profileId, root);
  const current = modules.find((module) => module.id === id);
  if (!current) throw new Error(`No briefing module named ${id}.`);
  return saveBriefingModule(
    {
      ...current,
      enabled,
      values: values ? { ...current.values, ...values } : current.values,
    },
    profileId,
    root,
  );
}

export function applyModuleSettings(module: BriefingModule): string {
  const values = resolvedValues(module);
  const url = module.fetch.url.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_, key: string) => {
    const value = values[key];
    return encodeURIComponent(value == null ? "" : String(value));
  });
  assertPublicHttpsUrl(url);
  return url;
}

export async function fetchModulePayload(
  module: BriefingModule,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = applyModuleSettings(module);
  const res = await fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(8_000),
    headers: {
      accept: "application/json, text/plain",
      "user-agent": "AlfredBriefing/1.0",
    },
  });
  if (!res.ok) throw new Error(`Module fetch failed (${res.status}).`);
  const text = await res.text();
  if (text.length > 250_000) {
    return { text: text.slice(0, 4_000) };
  }
  try {
    return compactModulePayload(JSON.parse(text) as unknown);
  } catch {
    return { text: text.slice(0, 4_000) };
  }
}

export async function runEnabledBriefingModules(opts: {
  llm?: GreetingLlm | null;
  profileId?: string;
  root?: string;
  fetchImpl?: typeof fetch;
}): Promise<BriefingModuleResult[]> {
  const modules = (await listBriefingModules(opts.profileId, opts.root)).filter(
    (module) => module.enabled,
  );
  const results = await Promise.all(
    modules.map(async (module) => {
      try {
        const payload = await fetchModulePayload(module, opts.fetchImpl);
        return await summarizeModule(module, payload, opts.llm);
      } catch (err) {
        console.warn(
          `[briefing] module ${module.id}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }),
  );
  return results.filter((result): result is BriefingModuleResult => Boolean(result));
}

export async function createBriefingModuleFromAsk(opts: {
  request: string;
  llm: GreetingLlm;
  profileId?: string;
  root?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ module: BriefingModule; speech: string }> {
  const request = opts.request.trim();
  if (!request) throw new Error("Say what you want added to the briefing.");
  let drafted: BriefingModule | null = null;
  try {
    const raw = await opts.llm([
      { role: "system", content: DRAFT_SYSTEM },
      { role: "user", content: `Add this to the daily briefing:\n${request.slice(0, 800)}` },
    ]);
    const body = extractJson(raw);
    if (!body || typeof body !== "object") throw new Error("Module draft was not an object.");
    drafted = parseBriefingModule({ ...(body as Record<string, unknown>), enabled: true });
  } catch (err) {
    console.warn(
      "[briefing] module draft failed:",
      err instanceof Error ? err.message : err,
    );
    if (/\b(launch|rocket|spacex|vandenberg)\b/i.test(request)) {
      drafted = rocketLaunchesModule();
    }
  }
  if (!drafted) {
    throw new Error("I couldn't design that briefing section just now.");
  }
  const payload = await fetchModulePayload(drafted, opts.fetchImpl);
  const preview = await summarizeModule(drafted, payload, opts.llm);
  if (!preview?.speech && !preview?.lines.length) {
    throw new Error("I designed that section, but the source returned nothing I can brief.");
  }
  const saved = await saveBriefingModule(drafted, opts.profileId, opts.root);
  const lead = preview.speech || preview.lines[0] || "";
  return {
    module: saved,
    speech: `I've added ${saved.title} to the daily briefing. ${lead}`.trim(),
  };
}

/** Parked built-in, used when the model cannot draft a launches module. */
export function rocketLaunchesModule(): BriefingModule {
  return parseBriefingModule({
    id: "rocket-launches",
    title: "Rocket launches",
    enabled: true,
    fetch: {
      method: "GET",
      url: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5&location__ids={{sites}}",
    },
    settings: [{ key: "sites", label: "Sites", type: "text", default: "11" }],
    speech:
      "Speak only the next upcoming launch in one sentence: provider, mission, weekday, and clock time. Say nothing if there are no launches.",
  });
}

const SLIM_SKIP = new Set([
  "id",
  "url",
  "slug",
  "image",
  "description",
  "last_updated",
  "info_urls",
  "vid_urls",
  "mission_patches",
]);

const SLIM_PREFERRED = [
  "name",
  "title",
  "net",
  "date",
  "status",
  "launch_service_provider",
  "provider",
  "mission",
  "pad",
  "location",
  "summary",
];

/** Keep a few short fields from a public JSON feed so the summary model sees real records. */
export function compactModulePayload(data: unknown): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const results = (data as { results?: unknown }).results;
    if (Array.isArray(results)) {
      return {
        results: results
          .slice(0, 3)
          .map((item) => slimRecord(item, 2))
          .filter((item): item is Record<string, unknown> => Boolean(item)),
      };
    }
  }
  if (Array.isArray(data)) {
    return data
      .slice(0, 3)
      .map((item) => slimRecord(item, 2))
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }
  return slimRecord(data, 2) ?? { text: clip(typeof data === "string" ? data : "", 500) };
}

function slimRecord(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const keys = [
    ...SLIM_PREFERRED.filter((key) => key in source),
    ...Object.keys(source).filter((key) => !SLIM_PREFERRED.includes(key)),
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (SLIM_SKIP.has(key) || key.endsWith("_url") || key.endsWith("_id")) continue;
    const child = source[key];
    if (typeof child === "string") {
      const text = child.trim();
      if (!text || text.length > 160 || /^https?:/i.test(text)) continue;
      out[key] = text;
    } else if (typeof child === "number" || typeof child === "boolean") {
      out[key] = child;
    } else if (depth > 0 && child && typeof child === "object" && !Array.isArray(child)) {
      const nested = slimRecord(child, depth - 1);
      if (nested && Object.keys(nested).length) out[key] = nested;
    }
    if (Object.keys(out).length >= 8) break;
  }
  return Object.keys(out).length ? out : undefined;
}

function fallbackFromPayload(data: unknown): { speech: string; lines: string[] } {
  const items = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)
      ? ((data as { results: unknown[] }).results)
      : [data];
  const lines = items
    .slice(0, 3)
    .map((item) => describeRecord(item))
    .filter(Boolean)
    .slice(0, 3);
  return { speech: clip(lines.slice(0, 2).join(". "), 600), lines };
}

function describeRecord(item: unknown): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const rec = item as Record<string, unknown>;
  const provider = nestedName(rec.launch_service_provider) || nestedName(rec.provider);
  const mission = nestedName(rec.mission) || textOf(rec.name) || textOf(rec.title);
  const when = textOf(rec.net) || textOf(rec.date);
  const pad = rec.pad;
  const place =
    (pad && typeof pad === "object" && !Array.isArray(pad)
      ? nestedName((pad as Record<string, unknown>).location) || textOf((pad as Record<string, unknown>).name)
      : "") || nestedName(rec.location);
  return [provider, mission, when, place].filter(Boolean).join(", ");
}

function nestedName(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return textOf((value as Record<string, unknown>).name) || textOf((value as Record<string, unknown>).abbrev);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function summarizeModule(
  module: BriefingModule,
  payload: unknown,
  llm?: GreetingLlm | null,
): Promise<BriefingModuleResult | null> {
  const compact = compactModulePayload(payload);
  const packed = JSON.stringify(compact);
  if (!packed || packed === "null" || packed === "{}" || packed === "[]" || packed === '{"results":[]}') {
    return null;
  }
  const fallback = fallbackFromPayload(compact);
  if (llm) {
    try {
      const raw = await llm([
        {
          role: "system",
          content:
            "You are Alfred. Summarize briefing data for speech. Return ONLY JSON: " +
            '{"speech":"one or two spoken sentences","lines":["up to 3 short screen lines"]}. ' +
            "No markdown. Use the data. If it lists events, name the next one.",
        },
        {
          role: "user",
          content: `Section: ${module.title}\nInstructions: ${module.speech}\n\nData:\n${packed.slice(0, 12_000)}`,
        },
      ]);
      const spoken = parseSpoken(raw);
      if (spoken.speech || spoken.lines.length) {
        return { id: module.id, title: module.title, ...spoken };
      }
    } catch (err) {
      console.warn(
        `[briefing] module ${module.id} summary failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!fallback.speech && !fallback.lines.length) return null;
  return { id: module.id, title: module.title, ...fallback };
}

function parseSpoken(raw: string): { speech: string; lines: string[] } {
  try {
    const value = extractJson(raw) as { speech?: unknown; lines?: unknown };
    const speech = clip(typeof value.speech === "string" ? value.speech : "", 600);
    const lines = Array.isArray(value.lines)
      ? value.lines
          .map((line) => clip(typeof line === "string" ? line : "", 180))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    return { speech, lines: lines.length ? lines : speech ? [speech] : [] };
  } catch {
    const speech = clip(raw, 600);
    return { speech, lines: speech ? [speech] : [] };
  }
}

function assertModuleUrlTemplate(url: string): void {
  const concrete = url.replace(/\{\{\s*[a-zA-Z0-9_-]+\s*\}\}/g, "1");
  assertPublicHttpsUrl(concrete);
}

function parseSettings(raw: unknown): BriefingModuleSetting[] {
  if (!Array.isArray(raw)) return [];
  const settings: BriefingModuleSetting[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const settingKey = typeof row.key === "string" ? row.key.trim() : "";
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(settingKey)) continue;
    const label = clip(typeof row.label === "string" ? row.label : settingKey, 40);
    const type = row.type === "boolean" ? "boolean" : "text";
    const fallback = type === "boolean" ? false : "";
    const def =
      type === "boolean"
        ? boolValue(row.default)
        : clip(row.default == null ? "" : String(row.default), 80);
    settings.push({
      key: settingKey,
      label: label || settingKey,
      type,
      default: type === "boolean" ? def : def || fallback,
    });
  }
  return settings;
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function parseValues(
  raw: unknown,
  settings: BriefingModuleSetting[],
): Record<string, string | boolean> {
  if (!raw || typeof raw !== "object") return {};
  const values: Record<string, string | boolean> = {};
  const allowed = new Set(settings.map((setting) => setting.key));
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const setting = settings.find((item) => item.key === key);
    if (!setting) continue;
    values[key] = setting.type === "boolean" ? boolValue(value) : clip(String(value ?? ""), 80);
  }
  return values;
}

function resolvedValues(module: BriefingModule): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const setting of module.settings) {
    values[setting.key] = module.values[setting.key] ?? setting.default;
  }
  return values;
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced?.[1] ?? raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in the draft.");
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function slug(raw: string): string {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ID_RE.test(id) ? id : "";
}

function clip(raw: string, max: number): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

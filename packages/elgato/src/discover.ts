import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { getAccessoryInfo } from "./client.js";
import { ELGATO_DEFAULT_PORT, type StudioLight } from "./types.js";

export const DEFAULT_ELGATO_CACHE_PATH = "data/elgato-lights.json";

export interface DiscoverOpts {
  hosts?: string[];
  fetchImpl?: typeof fetch;
  browse?: () => Promise<Array<{ instanceName: string; host: string; port: number }>>;
  knownLights?: StudioLight[];
  /** Set null to skip last-known cache. */
  cachePath?: string | null;
}

function parseHostEntry(raw: string): { host: string; port: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const v6 = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) return { host: v6[1]!, port: Number(v6[2]) };
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(trimmed.slice(lastColon + 1))) {
    return { host: trimmed.slice(0, lastColon), port: Number(trimmed.slice(lastColon + 1)) };
  }
  return { host: trimmed, port: ELGATO_DEFAULT_PORT };
}

export function hostsFromEnv(env = process.env): { host: string; port: number }[] {
  const raw = env.ELGATO_LIGHT_HOSTS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => parseHostEntry(part))
    .filter((entry): entry is { host: string; port: number } => entry != null);
}

/** Elgato instance "Elgato Key Light 9BAD" → elgato-key-light-9bad.local */
export function hostnameFromInstanceName(instanceName: string): string {
  const slug = instanceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug}.local`;
}

export function lightKey(light: Pick<StudioLight, "id" | "host" | "port" | "serialNumber">): string {
  if (light.serialNumber?.trim()) return `serial:${light.serialNumber.trim().toLowerCase()}`;
  if (light.id?.trim() && !light.id.includes(":")) return `id:${light.id.trim().toLowerCase()}`;
  return `host:${light.host.toLowerCase()}:${light.port}`;
}

export function mergeLights(...groups: StudioLight[][]): StudioLight[] {
  const byKey = new Map<string, StudioLight>();
  for (const group of groups) {
    for (const light of group) {
      byKey.set(lightKey(light), light);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function lightLabel(info: {
  displayName?: string;
  productName?: string;
  serialNumber?: string;
  instanceName?: string;
}): string {
  const display = info.displayName?.trim();
  if (display) return display;
  const instance = info.instanceName?.trim();
  if (instance) return instance;
  const product = info.productName?.trim() || "Elgato light";
  const serial = info.serialNumber?.slice(-4);
  return serial ? `${product} ${serial}` : product;
}

function runTimed(command: string, args: string[], ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 400);
    }, ms);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Parse `dns-sd -B _elg._tcp local` instance names. */
export function parseDnsSdBrowse(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/_elg\._tcp\.\s+(.+)\s*$/);
    if (!match) continue;
    const name = match[1]!.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Parse `dns-sd -L …` host:port. */
export function parseDnsSdLookup(output: string): { host: string; port: number } | null {
  const match = output.match(/can be reached at (\S+):(\d+)/i);
  if (!match) return null;
  return { host: match[1]!.replace(/\.$/, ""), port: Number(match[2]) };
}

export async function browseElgatoDnsSd(): Promise<
  Array<{ instanceName: string; host: string; port: number }>
> {
  if (process.platform !== "darwin") return [];
  let browseOut = "";
  try {
    browseOut = await runTimed("dns-sd", ["-B", "_elg._tcp", "local"], 2_200);
  } catch {
    return [];
  }
  const instances = parseDnsSdBrowse(browseOut);
  return instances.map((instanceName) => ({
    instanceName,
    host: hostnameFromInstanceName(instanceName),
    port: ELGATO_DEFAULT_PORT,
  }));
}

async function identify(
  host: string,
  port: number,
  instanceName: string | undefined,
  fetchImpl: typeof fetch,
): Promise<StudioLight | null> {
  try {
    const info = await getAccessoryInfo(host, port, fetchImpl);
    const name = lightLabel({ ...info, instanceName });
    const serial = info.serialNumber?.trim();
    return {
      id: serial || `${host}:${port}`,
      name,
      productName: info.productName?.trim() || "Elgato light",
      host,
      port,
      serialNumber: serial,
    };
  } catch {
    if (!instanceName) return null;
    return {
      id: `${host}:${port}`,
      name: instanceName,
      productName: "Elgato light",
      host,
      port,
    };
  }
}

async function readCachedLights(path: string): Promise<StudioLight[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is StudioLight => {
      return (
        row &&
        typeof row === "object" &&
        typeof row.host === "string" &&
        typeof row.port === "number" &&
        typeof row.name === "string"
      );
    });
  } catch {
    return [];
  }
}

async function writeCachedLights(path: string, lights: StudioLight[]): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(lights, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn("[elgato] failed to write light cache:", err);
  }
}

export async function discoverElgatoLights(opts: DiscoverOpts = {}): Promise<StudioLight[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cachePath = opts.cachePath === undefined ? DEFAULT_ELGATO_CACHE_PATH : opts.cachePath;
  const explicit = (opts.hosts ?? hostsFromEnv()).map((entry) =>
    typeof entry === "string" ? parseHostEntry(entry) : entry,
  );
  const fromEnv = explicit.filter((entry): entry is { host: string; port: number } => entry != null);
  const browsed = opts.browse ? await opts.browse() : await browseElgatoDnsSd();
  const remembered = [
    ...(opts.knownLights ?? []),
    ...(cachePath ? await readCachedLights(cachePath) : []),
  ];

  const seen = new Set<string>();
  const candidates: Array<{ host: string; port: number; instanceName?: string }> = [
    ...fromEnv,
    ...browsed,
    ...remembered.map((light) => ({
      host: light.host,
      port: light.port,
      instanceName: light.name,
    })),
  ];

  const identified = await Promise.all(
    candidates.map(async (candidate) => {
      const key = `${candidate.host}:${candidate.port}`.toLowerCase();
      if (seen.has(key)) return null;
      seen.add(key);
      return identify(candidate.host, candidate.port, candidate.instanceName, fetchImpl);
    }),
  );

  const live = identified.filter((light): light is StudioLight => light != null);
  const merged = mergeLights(remembered, live);
  if (cachePath && merged.length) await writeCachedLights(cachePath, merged);
  return merged;
}

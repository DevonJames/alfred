import { existsSync, readFileSync } from "node:fs";

/** Minimal .env loader so the ESM host bundle never `require()`s dotenv. */
export function parseEnvFile(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFile(path: string, override = false): void {
  if (!existsSync(path)) return;
  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

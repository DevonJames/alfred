/**
 * Local memory + persona inspect / export / import.
 *
 *   pnpm memory -- inspect
 *   pnpm memory -- persona
 *   pnpm memory -- export [file]
 *   pnpm memory -- import <file>
 */
import { config as loadEnv } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanonicalMemoryRecord } from "@alfred/contracts";
import {
  defaultMemoryPath,
  defaultPersonaDir,
  ensureAndLoadPersona,
  getItemKind,
  LocalFileMemoryProvider,
  PERSONA_FILES,
} from "@alfred/memory";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const cmd = args[0] ?? "inspect";
  const profileId = process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const filePath = defaultMemoryPath(profileId);
  const provider = new LocalFileMemoryProvider(filePath);

  if (cmd === "inspect") {
    const items = await provider.inspect(200);
    console.log(`Memory file: ${filePath}`);
    console.log(`Items: ${items.length}\n`);
    const facts = items.filter((i) => {
      const k = getItemKind(i);
      return k === "fact" || k === "note";
    });
    const turns = items.filter((i) => getItemKind(i) === "turn");

    console.log("--- Facts / notes ---");
    if (!facts.length) console.log("(none)");
    for (const f of facts) {
      console.log(`  [${f.sourceId}] ${f.content}`);
    }
    console.log("\n--- Recent turns ---");
    if (!turns.length) console.log("(none)");
    for (const t of turns.slice(0, 40)) {
      console.log(`  ${t.content}`);
    }
    console.log(`\nPersona dir: ${defaultPersonaDir(profileId)}`);
    console.log(`(use \`pnpm memory -- persona\` to print SOUL / IDENTITY / USER)`);
    return;
  }

  if (cmd === "persona") {
    const persona = await ensureAndLoadPersona(profileId);
    console.log(`Persona dir: ${persona.dir}`);
    for (const name of PERSONA_FILES) {
      const key = name === "SOUL.md" ? "soul" : name === "IDENTITY.md" ? "identity" : "user";
      const body = persona[key];
      console.log(`\n===== ${name} =====`);
      console.log(body ?? "(empty or missing)");
    }
    return;
  }

  if (cmd === "export") {
    const out = args[1];
    const records = await provider.exportCanonical();
    const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    if (out) {
      await writeFile(resolve(out), body, "utf8");
      console.log(`Exported ${records.length} records → ${resolve(out)}`);
    } else {
      process.stdout.write(body);
    }
    return;
  }

  if (cmd === "import") {
    const src = args[1];
    if (!src) {
      console.error("Usage: pnpm memory -- import <file.jsonl>");
      process.exitCode = 1;
      return;
    }
    const raw = await readFile(resolve(src), "utf8");
    const records: CanonicalMemoryRecord[] = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CanonicalMemoryRecord);
    await provider.importCanonical(records);
    console.log(`Imported ${records.length} records → ${filePath}`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  console.error("Usage: pnpm memory -- inspect|persona|export|import");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

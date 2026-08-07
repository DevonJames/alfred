/**
 * Local memory + persona inspect / export / import / ingest-export.
 *
 *   pnpm memory -- inspect
 *   pnpm memory -- persona
 *   pnpm memory -- export [file]
 *   pnpm memory -- import <file>
 *   pnpm memory -- ingest-export <report.md> [--dry-run] [--no-user] [--no-memory]
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path, { resolve } from "node:path";
import type { CanonicalMemoryRecord } from "@alfred/contracts";
import {
  defaultMemoryPath,
  defaultPersonaDir,
  ensureAndLoadPersona,
  ensurePersonaFiles,
  getItemKind,
  LocalFileMemoryProvider,
  mergeUserMd,
  PERSONA_FILES,
  planIngestExport,
  resolveRepoRoot,
} from "@alfred/memory";

function resolveInputPath(src: string): string {
  if (path.isAbsolute(src)) return src;
  const fromCwd = resolve(src);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRepo = path.join(resolveRepoRoot(), src);
  if (existsSync(fromRepo)) return fromRepo;
  return fromCwd;
}

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
    const raw = await readFile(resolveInputPath(src), "utf8");
    const records: CanonicalMemoryRecord[] = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CanonicalMemoryRecord);
    await provider.importCanonical(records);
    console.log(`Imported ${records.length} records → ${filePath}`);
    return;
  }

  if (cmd === "ingest-export") {
    const src = args[1];
    if (!src) {
      console.error(
        "Usage: pnpm memory -- ingest-export <report.md> [--dry-run] [--no-user] [--no-memory]",
      );
      process.exitCode = 1;
      return;
    }
    const flags = new Set(args.slice(2));
    const dryRun = flags.has("--dry-run");
    const noUser = flags.has("--no-user");
    const noMemory = flags.has("--no-memory");

    const abs = resolveInputPath(src);
    const markdown = await readFile(abs, "utf8");
    const sourceLabel = path.basename(abs);
    const plan = planIngestExport(markdown, { sourceLabel });

    console.log(`Source: ${abs}`);
    console.log(`USER sections: ${plan.userSectionsFound.join(", ") || "(none found)"}`);
    console.log(`Memory records planned: ${plan.memoryRecords.length}`);
    console.log(`Skipped sections: ${plan.skippedSections.join(", ") || "(none)"}`);

    const personaDir = defaultPersonaDir(profileId);
    const userPath = path.join(personaDir, "USER.md");
    const exportsDir = path.join(resolveRepoRoot(), "data", "knowledge", "exports");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = path.join(exportsDir, `${path.parse(sourceLabel).name}-${stamp}.md`);

    if (dryRun) {
      console.log("\n--dry-run: no files written");
      if (plan.userPatch) {
        console.log("\n----- USER.md patch preview (first 1200 chars) -----");
        console.log(plan.userPatch.slice(0, 1200));
      }
      console.log("\n----- sample memory records -----");
      for (const r of plan.memoryRecords.slice(0, 8)) {
        console.log(`  [${r.metadata?.sourceId}] ${r.content.slice(0, 120)}`);
      }
      return;
    }

    await mkdir(exportsDir, { recursive: true });
    await writeFile(archivePath, markdown, "utf8");
    console.log(`Archived full export → ${archivePath}`);

    if (!noUser) {
      await ensurePersonaFiles(personaDir);
      let existing = "";
      try {
        existing = await readFile(userPath, "utf8");
      } catch {
        existing = "# USER.md — User Model\n";
      }
      if (plan.userPatch) {
        const merged = mergeUserMd(existing, plan.userPatch, plan.markers);
        await writeFile(userPath, merged, "utf8");
        console.log(
          `Updated USER.md ← ${plan.userSectionsFound.join(", ")} (${plan.markers.start})`,
        );
      } else {
        console.log(
          "No High-Priority / How to Work sections found — USER.md left unchanged.",
        );
      }
    }

    if (!noMemory && plan.memoryRecords.length) {
      await provider.importCanonical(plan.memoryRecords);
      console.log(`Imported ${plan.memoryRecords.length} memory notes → ${filePath}`);
    } else if (noMemory) {
      console.log("Skipped memory import (--no-memory)");
    }

    console.log("\nDone. Verify with:");
    console.log("  pnpm memory -- persona");
    console.log("  pnpm memory -- inspect");
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  console.error(
    "Usage: pnpm memory -- inspect|persona|export|import|ingest-export",
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

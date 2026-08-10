/**
 * Local memory + persona inspect / export / import / ingest-export.
 *
 *   pnpm memory -- inspect
 *   pnpm memory -- persona
 *   pnpm memory -- export [file]
 *   pnpm memory -- import <file>
 *   pnpm memory -- ingest-export <report.md> [--dry-run] [--no-user] [--no-memory]
 *   pnpm memory -- dedupe-user [--dry-run]
 *   pnpm memory -- cleanup-user [--dry-run] [--no-memory] [--target N]
 *   pnpm memory -- oip-inspect
 *   pnpm memory -- oip-verify
 *   pnpm memory -- oip-rebuild
 *   pnpm memory -- oip-export [file]
 *   pnpm memory -- oip-import <file>
 *   pnpm memory -- erase --yes [--all]
 *   pnpm memory -- ingest-knowledge <file.json|.md> [--dry-run]
 *   pnpm memory -- seed-reminder [text...]
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path, { resolve } from "node:path";
import { seedDueReminder } from "@alfred/briefing";
import type { CanonicalMemoryRecord } from "@alfred/contracts";
import {
  cleanupUserMd,
  dedupeUserMd,
  defaultMemoryPath,
  defaultOipMemoryRoot,
  defaultPersonaDir,
  ensureAndLoadPersona,
  ensurePersonaFiles,
  eraseOipMemory,
  getItemKind,
  ingestKnowledgeDocument,
  LocalFileMemoryProvider,
  mergeUserMd,
  OipLocalMemoryProvider,
  PERSONA_FILES,
  planIngestExport,
  resolveRepoRoot,
  USER_MD_MAX_CHARS,
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
  const oipRoot = defaultOipMemoryRoot(profileId);
  const oip = () => new OipLocalMemoryProvider(oipRoot);

  if (cmd === "erase") {
    const yes = args.includes("--yes") || args.includes("-y");
    const includeLocalJsonl = args.includes("--all");
    if (!yes) {
      console.error(
        "This permanently deletes local OIP memory packages/artifacts/indexes" +
          (includeLocalJsonl ? " and memory.local JSONL" : "") +
          ".\nRe-run with --yes to confirm.\n  pnpm memory -- erase --yes\n  pnpm memory -- erase --yes --all",
      );
      process.exitCode = 1;
      return;
    }
    const result = await eraseOipMemory({ profileId, includeLocalJsonl });
    console.log(`Erased OIP memory under ${result.oipRoot}`);
    for (const p of result.removed) console.log(`  removed ${p}`);
    if (result.jsonlPath) console.log(`  removed JSONL ${result.jsonlPath}`);
    console.log("USER.md / persona files were not modified.");
    return;
  }

  if (cmd === "ingest-knowledge") {
    const src = args[1];
    if (!src) {
      console.error("Usage: pnpm memory -- ingest-knowledge <file.json|.md> [--dry-run]");
      process.exitCode = 1;
      return;
    }
    const dryRun = args.includes("--dry-run");
    const abs = resolveInputPath(src);
    const text = await readFile(abs, "utf8");
    if (dryRun) {
      const planned = planIngestExport(text, { sourceLabel: path.basename(abs) });
      console.log(`Source: ${abs}`);
      console.log(`Mode preview: ${text.trim().startsWith("{") ? "json-or-markdown" : "markdown"}`);
      console.log(`USER sections: ${planned.userSectionsFound.join(", ") || "(none)"}`);
      console.log(`Memory chunks (markdown splitter): ${planned.memoryRecords.length}`);
      console.log("--dry-run: no files written (JSON path not fully simulated)");
      return;
    }
    const result = await ingestKnowledgeDocument({
      filename: path.basename(abs),
      text,
      bytes: Buffer.from(text, "utf8"),
      profileId,
    });
    console.log(`Ingested ${result.filename} as ${result.mode} → ${result.providerId}`);
    console.log(`USER.md updated: ${result.userMdUpdated} ${result.userSections.join(", ")}`);
    console.log(
      `Created: entities=${result.created.entities} episodes=${result.created.episodes} assertions=${result.created.assertions} observations=${result.created.observations} notes=${result.created.notes}`,
    );
    if (result.errors.length) {
      console.log(`Warnings (${result.errors.length}):`);
      for (const e of result.errors.slice(0, 20)) console.log(`  ${e}`);
    }
    console.log(`Root: ${result.root}`);
    return;
  }

  if (cmd === "oip-inspect") {
    const p = oip();
    const items = await p.inspect(200);
    console.log(`OIP memory root: ${oipRoot}`);
    console.log(`Packages (current revisions): ${items.length}\n`);
    for (const item of items) {
      const type = String(item.provenance?.type ?? "?");
      console.log(`  [${type}] ${item.id}`);
      console.log(`    ${item.content.slice(0, 160)}`);
    }
    return;
  }

  if (cmd === "oip-verify") {
    const p = oip();
    const report = await p.verify();
    console.log(`OIP memory root: ${oipRoot}`);
    console.log(
      `ok=${report.ok} packages=${report.packagesChecked} revisions=${report.revisionsChecked} artifacts=${report.artifactsChecked}`,
    );
    for (const issue of report.issues) {
      console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
      if (issue.path) console.log(`    path: ${issue.path}`);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "oip-rebuild") {
    const p = oip();
    await p.rebuildIndexes();
    console.log(`Rebuilt indexes under ${path.join(oipRoot, "indexes")}`);
    return;
  }

  if (cmd === "oip-export") {
    const p = oip();
    const out = args[1];
    const records = await p.exportCanonical();
    const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    if (out) {
      await writeFile(resolve(out), body, "utf8");
      console.log(`Exported ${records.length} OIP records → ${resolve(out)}`);
    } else {
      process.stdout.write(body);
    }
    return;
  }

  if (cmd === "oip-import") {
    const src = args[1];
    if (!src) {
      console.error("Usage: pnpm memory -- oip-import <file.jsonl>");
      process.exitCode = 1;
      return;
    }
    const p = oip();
    const raw = await readFile(resolveInputPath(src), "utf8");
    const records: CanonicalMemoryRecord[] = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CanonicalMemoryRecord);
    await p.importCanonical(records);
    console.log(`Imported ${records.length} OIP records → ${oipRoot}`);
    return;
  }

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
      if (name === "USER.md") {
        const onDisk = await readFile(path.join(persona.dir, "USER.md"), "utf8").catch(() => "");
        const diskChars = onDisk.trim().length;
        const injected = body?.replace(/\n\n…\[truncated[\s\S]*$/, "").length ?? 0;
        if (diskChars > USER_MD_MAX_CHARS) {
          console.log(
            `\n(USER.md on disk: ${diskChars} chars; inject budget ${USER_MD_MAX_CHARS}; showing ~${injected}. Run: pnpm memory -- cleanup-user)`,
          );
        }
      }
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

  if (cmd === "dedupe-user") {
    const dryRun = args.includes("--dry-run");
    const personaDir = defaultPersonaDir(profileId);
    const userPath = path.join(personaDir, "USER.md");
    await ensurePersonaFiles(personaDir);
    const existing = await readFile(userPath, "utf8");
    const result = dedupeUserMd(existing);

    console.log(`USER.md: ${userPath}`);
    console.log(
      `Chars: ${result.beforeChars} → ${result.afterChars} (removed ${result.removedUnits} redundant units, kept ${result.keptUnits} content units)`,
    );
    if (result.notes.length) {
      console.log(`Notes: ${result.notes.slice(0, 5).join("; ")}`);
    }

    if (dryRun) {
      console.log("\n--dry-run: no files written");
      console.log("\n----- preview (first 1500 chars) -----");
      console.log(result.text.slice(0, 1500));
      return;
    }

    if (result.removedUnits === 0 && result.text === existing) {
      console.log("Nothing to dedupe.");
      return;
    }

    const backup = `${userPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await writeFile(backup, existing, "utf8");
    await writeFile(userPath, result.text, "utf8");
    console.log(`Wrote deduped USER.md (backup: ${backup})`);
    return;
  }

  if (cmd === "cleanup-user") {
    const dryRun = args.includes("--dry-run");
    const noMemory = args.includes("--no-memory");
    const targetIdx = args.indexOf("--target");
    const targetChars =
      targetIdx >= 0 && args[targetIdx + 1] ? Number(args[targetIdx + 1]) : undefined;
    if (targetIdx >= 0 && (targetChars === undefined || Number.isNaN(targetChars))) {
      console.error("Usage: pnpm memory -- cleanup-user [--dry-run] [--no-memory] [--target N]");
      process.exitCode = 1;
      return;
    }

    const personaDir = defaultPersonaDir(profileId);
    const userPath = path.join(personaDir, "USER.md");
    await ensurePersonaFiles(personaDir);
    const existing = await readFile(userPath, "utf8");
    const result = cleanupUserMd(existing, {
      targetChars,
      sourceLabel: "cleanup-user",
    });

    console.log(`USER.md: ${userPath}`);
    console.log(
      `Chars: ${result.beforeChars} → ${result.afterChars} (inject budget ${USER_MD_MAX_CHARS})`,
    );
    console.log(
      `Dropped junk units: ${result.droppedJunk}; overflow notes: ${result.overflowNotes.length}`,
    );
    if (result.notes.length) {
      console.log(`Notes: ${result.notes.slice(0, 8).join("; ")}`);
    }

    if (dryRun) {
      console.log("\n--dry-run: no files written");
      console.log("\n----- preview (first 2000 chars) -----");
      console.log(result.text.slice(0, 2000));
      if (result.overflowNotes.length) {
        console.log("\n----- overflow sample -----");
        for (const r of result.overflowNotes.slice(0, 6)) {
          console.log(`  [${r.metadata?.sourceId}] ${r.content.slice(0, 140)}`);
        }
      }
      return;
    }

    const backup = `${userPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await writeFile(backup, existing, "utf8");
    await writeFile(userPath, result.text, "utf8");
    console.log(`Wrote cleaned USER.md (backup: ${backup})`);

    if (!noMemory && result.overflowNotes.length) {
      await provider.importCanonical(result.overflowNotes);
      console.log(`Imported ${result.overflowNotes.length} overflow notes → ${filePath}`);
    } else if (noMemory) {
      console.log("Skipped overflow memory import (--no-memory)");
    }

    console.log("\nVerify with: pnpm memory -- persona");
    return;
  }

  if (cmd === "seed-reminder") {
    const text =
      args
        .slice(1)
        .filter((a) => !a.startsWith("--"))
        .join(" ")
        .trim() || "Call Sarah about the cabin";
    const timezone = process.env.BRIEFING_TIMEZONE ?? "America/Los_Angeles";
    const dayStart = process.env.BRIEFING_DAY_START ?? "04:30";
    const mem = oip();
    const seeded = await seedDueReminder(mem, { text, timezone, dayStart });
    console.log(`Seeded due reminder for briefing day ${seeded.remindAt}`);
    console.log(`  id: ${seeded.recordId}`);
    console.log(`  text: ${text}`);
    console.log(`  store: ${oipRoot}`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  console.error(
    "Usage: pnpm memory -- inspect|persona|export|import|ingest-export|ingest-knowledge|dedupe-user|cleanup-user|erase|oip-inspect|oip-verify|oip-rebuild|oip-export|oip-import|seed-reminder",
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

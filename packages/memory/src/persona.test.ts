import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePersonaFiles, loadPersonaContext } from "./persona.js";

describe("persona files", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("seeds defaults once and does not overwrite edits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-persona-"));
    dirs.push(dir);
    await ensurePersonaFiles(dir);
    const soulPath = path.join(dir, "SOUL.md");
    await writeFile(soulPath, "# Custom soul\nBe weird.\n", "utf8");
    await ensurePersonaFiles(dir);
    expect(await readFile(soulPath, "utf8")).toContain("Be weird.");
  });

  it("loads soul, identity, user and skips blanks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-persona-"));
    dirs.push(dir);
    await ensurePersonaFiles(dir);
    await writeFile(path.join(dir, "USER.md"), "   \n", "utf8");
    const ctx = await loadPersonaContext(dir);
    expect(ctx.soul).toMatch(/SOUL\.md/i);
    expect(ctx.identity).toMatch(/ALFRED/);
    expect(ctx.user).toBeUndefined();
  });
});

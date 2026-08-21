import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkMarkdownFiles } from "./walk.js";

describe("walkMarkdownFiles", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("finds md files and skips node_modules and dist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-docswalk-"));
    dirs.push(root);
    await writeFile(path.join(root, "README.md"), "# Hi\n");
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "sub", "arch.mdx"), "# Arch\n");
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "README.md"), "# skip\n");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "out.md"), "# skip\n");

    const files = await walkMarkdownFiles(root);
    expect(files.map((f) => f.relPath).sort()).toEqual(["README.md", "sub/arch.mdx"]);
  });
});

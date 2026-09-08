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

  it("finds md, txt, rtf, and pdf files and skips node_modules and dist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-docswalk-"));
    dirs.push(root);
    await writeFile(path.join(root, "README.md"), "# Hi\n");
    await writeFile(path.join(root, "notes.txt"), "plain notes\n");
    await writeFile(path.join(root, "letter.rtf"), "{\\rtf1 hello}\n");
    await writeFile(path.join(root, "brief.pdf"), "%PDF-1.4");
    await writeFile(path.join(root, "photo.png"), "nope");
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "sub", "arch.mdx"), "# Arch\n");
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "README.md"), "# skip\n");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "out.md"), "# skip\n");

    const files = await walkMarkdownFiles(root);
    expect(files.map((f) => f.relPath).sort()).toEqual([
      "README.md",
      "brief.pdf",
      "letter.rtf",
      "notes.txt",
      "sub/arch.mdx",
    ]);
  });
});

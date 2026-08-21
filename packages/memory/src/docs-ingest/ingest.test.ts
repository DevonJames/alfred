import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyExtraction } from "./extract.js";
import { ingestDocsFolders } from "./ingest.js";
import { OipLocalMemoryProvider } from "../oip-local/provider.js";
import { addDocsSource } from "./sources.js";
import type { DocsExtractor } from "./extract.js";

describe("ingestDocsFolders", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    delete process.env.ALFRED_X_INGEST_DIR;
    delete process.env.ALFRED_MEMORY_OIP_PATH;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("ingests a folder graph, skips unchanged hashes, and re-ingests edits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-docsingest-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(dir, "oip");

    const docs = path.join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(
      path.join(docs, "architecture.md"),
      `# Architecture

Alfred stores memories as OIP packages.

## LiveKit

Pairing uses a QR claim flow.
`,
    );

    await addDocsSource("p", { path: docs, label: "Alfred docs" });
    const provider = new OipLocalMemoryProvider(path.join(dir, "oip"));
    const extractor: DocsExtractor = async (input) => {
      if (!/LiveKit/i.test(input.sectionTitle)) return emptyExtraction();
      return {
        ...emptyExtraction(),
        entities: [
          {
            tempId: "e1",
            name: "QR claim",
            entityClass: "Thing",
            summary: "Pairing uses QR",
            quote: "Pairing uses a QR claim flow.",
          },
        ],
        assertions: [
          {
            subjectTempId: "e1",
            predicate: "used for",
            object: "phone pairing",
            quote: "QR claim flow",
          },
        ],
      };
    };

    const first = await ingestDocsFolders({
      profileId: "p",
      provider,
      extractor,
      now: new Date("2026-08-21T18:00:00.000Z"),
    });
    expect(first.processed).toHaveLength(1);
    expect(first.processed[0]?.status).toBe("ingested");
    expect(first.processed[0]?.sections).toBeGreaterThan(1);
    expect(first.processed[0]?.extracted).toBeGreaterThan(0);

    const fileDid = first.processed[0]?.fileDid;
    expect(fileDid).toBeTruthy();
    const fileRev = await provider.resolveRef(fileDid!);
    expect(fileRev?.drefs.isPartOf).toBeTruthy();
    const folderRev = await provider.resolveRef(String(fileRev?.drefs.isPartOf));
    expect(folderRev?.name).toBe("Alfred docs");

    const sectionHits = provider.sqlite.findBySearchSubstring("OIP packages");
    expect(sectionHits.length).toBeGreaterThan(0);
    const section = await provider.resolveRef(sectionHits[0]!.id);
    expect(section?.drefs.isPartOf).toBe(fileDid);
    expect(section?.drefs.sourceArtifact).toBeTruthy();

    const entityHits = provider.sqlite.findByName("QR claim", "Entity");
    expect(entityHits.length).toBeGreaterThan(0);
    const entity = await provider.resolveRef(entityHits[0]!.id);
    expect(entity?.drefs.isPartOf).toBe(fileDid);
    expect(entity?.drefs.derivedFrom).toBeTruthy();

    const retrieved = await provider.retrieve({
      text: "architecture documentation in the Alfred docs folder about LiveKit pairing",
      limit: 8,
    });
    expect(retrieved.items.some((i) => /source=docs/.test(i.content))).toBe(true);
    expect(retrieved.items.some((i) => /folder=Alfred docs/.test(i.content))).toBe(true);
    expect(
      retrieved.items.some((i) => /OIP packages|QR claim|LiveKit/i.test(i.content)),
    ).toBe(true);

    const second = await ingestDocsFolders({
      profileId: "p",
      provider,
      extractor,
      now: new Date("2026-08-21T19:00:00.000Z"),
    });
    expect(second.processed[0]?.status).toBe("skipped");

    await writeFile(
      path.join(docs, "architecture.md"),
      `# Architecture

Alfred stores memories as OIP packages with drefs.

## LiveKit

Pairing uses a QR claim flow.
`,
    );
    const third = await ingestDocsFolders({
      profileId: "p",
      provider,
      extractor,
      now: new Date("2026-08-21T20:00:00.000Z"),
    });
    expect(third.processed[0]?.status).toBe("ingested");
    const updated = provider.sqlite.findBySearchSubstring("packages with drefs");
    expect(updated.length).toBeGreaterThan(0);
  });
});

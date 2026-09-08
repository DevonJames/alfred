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
    const folderDid = String(fileRev?.drefs.isPartOf);
    const folderRev = await provider.resolveRef(folderDid);
    expect(folderRev?.name).toBe("Alfred docs");

    const sectionHits = provider.sqlite.findBySearchSubstring("OIP packages");
    expect(sectionHits.length).toBeGreaterThan(0);
    const section = await provider.resolveRef(sectionHits[0]!.id);
    expect(partOf(section)).toEqual(expect.arrayContaining([fileDid, folderDid]));
    expect(section?.drefs.sourceArtifact).toBeTruthy();

    const entityHits = provider.sqlite.findByName("QR claim", "Entity");
    expect(entityHits.length).toBeGreaterThan(0);
    const entity = await provider.resolveRef(entityHits[0]!.id);
    expect(partOf(entity)).toEqual(expect.arrayContaining([fileDid, folderDid]));
    expect(entity?.drefs.derivedFrom).toBeTruthy();
    const inbound = provider.sqlite.edgesTo(folderDid);
    expect(inbound.some((e) => e.source_id === fileDid && e.predicate === "isPartOf")).toBe(true);
    expect(inbound.some((e) => e.source_id === section?.id && e.predicate === "isPartOf")).toBe(true);
    expect(inbound.some((e) => e.source_id === entity?.id && e.predicate === "isPartOf")).toBe(true);

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

  it("ingests txt, rtf, and pdf alongside markdown", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-docsmix-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(dir, "oip");

    const docs = path.join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(path.join(docs, "plain.txt"), "Devon prefers short answers.\n");
    await writeFile(path.join(docs, "letter.rtf"), "{\\rtf1\\ansi Pairing uses a QR claim flow.\\par}");
    await writeFile(path.join(docs, "brief.pdf"), minimalPdf("Alfred stores memories as OIP packages."));

    await addDocsSource("p", { path: docs, label: "Mixed notes" });
    const provider = new OipLocalMemoryProvider(path.join(dir, "oip"));
    const run = await ingestDocsFolders({
      profileId: "p",
      provider,
      extractor: async () => emptyExtraction(),
    });
    expect(run.processed.map((p) => p.relPath).sort()).toEqual(["brief.pdf", "letter.rtf", "plain.txt"]);
    expect(run.processed.every((p) => p.status === "ingested")).toBe(true);
    expect(provider.sqlite.findBySearchSubstring("short answers").length).toBeGreaterThan(0);
    expect(provider.sqlite.findBySearchSubstring("QR claim flow").length).toBeGreaterThan(0);
    expect(provider.sqlite.findBySearchSubstring("OIP packages").length).toBeGreaterThan(0);
    expect(provider.sqlite.findBySearchSubstring("rtf1").length).toBe(0);
  });
});

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function partOf(rev: { drefs?: { isPartOf?: unknown } } | null): string[] {
  const value = rev?.drefs?.isPartOf;
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

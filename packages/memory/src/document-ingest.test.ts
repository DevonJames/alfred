import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestDocument, pagesToMarkdown } from "./document-ingest.js";
import { emptyExtraction, type DocsExtractor } from "./docs-ingest/extract.js";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";

describe("pagesToMarkdown", () => {
  it("prefixes each non-empty page", () => {
    expect(pagesToMarkdown(["alpha", "", "beta"])).toBe("# Page 1\n\nalpha\n\n# Page 3\n\nbeta");
  });
});

describe("ingestDocument", () => {
  const dirs: string[] = [];
  const prevOip = process.env.ALFRED_MEMORY_OIP_PATH;
  const prevPersona = process.env.ALFRED_PERSONA_DIR;

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
    if (prevOip === undefined) delete process.env.ALFRED_MEMORY_OIP_PATH;
    else process.env.ALFRED_MEMORY_OIP_PATH = prevOip;
    if (prevPersona === undefined) delete process.env.ALFRED_PERSONA_DIR;
    else process.env.ALFRED_PERSONA_DIR = prevPersona;
  });

  it("stores a file entity, page observations, and extracted facts without USER.md", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-docupload-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");

    const extractor: DocsExtractor = async (input) => {
      if (!/Page 2/i.test(input.sectionTitle)) return emptyExtraction();
      return {
        ...emptyExtraction(),
        entities: [
          {
            tempId: "e1",
            name: "LiveKit",
            entityClass: "Thing",
            summary: "Pairing uses LiveKit",
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

    const result = await ingestDocument({
      filename: "brief.pdf",
      bytes: Buffer.from("%PDF-fake-bytes"),
      pages: [
        "Alfred stores memories as OIP packages.",
        "Pairing uses a QR claim flow.",
      ],
      extractor,
    });

    expect(result.mode).toBe("document");
    expect(result.userMdUpdated).toBe(false);
    expect(result.userSections).toEqual([]);
    expect(result.pages).toBe(2);
    expect(result.sections).toBe(2);
    expect(result.created.observations).toBe(2);
    expect(result.created.entities).toBeGreaterThanOrEqual(2);
    expect(result.created.assertions).toBe(1);
    expect(result.artifactId).toBeTruthy();

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const fileHits = provider.sqlite.findByName("brief.pdf", "Entity");
    expect(fileHits.length).toBeGreaterThan(0);
    const file = await provider.resolveRef(fileHits[0]!.id);
    expect(file?.drefs.sourceArtifact).toBe(result.artifactId);
    expect(file?.drefs.isPartOf).toBeFalsy();

    const pageHits = provider.sqlite.findBySearchSubstring("OIP packages");
    expect(pageHits.length).toBeGreaterThan(0);
    const page = await provider.resolveRef(pageHits[0]!.id);
    expect(page?.drefs.isPartOf).toBe(file?.id);
    expect(page?.drefs.sourceArtifact).toBe(result.artifactId);
    expect(page?.provenance?.sourceType).toBe("document_upload");

    const retrieved = await provider.retrieve({
      text: "what does the uploaded pdf say about pairing",
      limit: 8,
    });
    expect(retrieved.items.some((i) => /source=document/.test(i.content))).toBe(true);
    expect(retrieved.items.some((i) => /file=brief\.pdf/.test(i.content))).toBe(true);
    expect(retrieved.items.some((i) => /OIP packages|QR claim|LiveKit/i.test(i.content))).toBe(true);
  });

  it("rejects empty extracted text", async () => {
    await expect(
      ingestDocument({
        filename: "empty.pdf",
        bytes: Buffer.from("%PDF"),
        pages: ["", "   "],
      }),
    ).rejects.toThrow(/no extractable text/);
  });
});

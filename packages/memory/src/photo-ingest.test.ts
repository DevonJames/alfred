import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyExtraction, type DocsExtractor } from "./docs-ingest/extract.js";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";
import { ingestPhoto, ingestPhotos } from "./photo-ingest.js";

describe("ingestPhoto", () => {
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

  it("stores an image entity, OCR observations, and extracted facts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-photoupload-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");

    const extractor: DocsExtractor = async (input) => {
      if (!/Osteria/i.test(input.sectionText)) return emptyExtraction();
      return {
        ...emptyExtraction(),
        entities: [
          {
            tempId: "e1",
            name: "Osteria",
            entityClass: "Organization",
            summary: "Restaurant on the menu",
            quote: "Osteria",
          },
        ],
        assertions: [
          {
            subjectTempId: "e1",
            predicate: "serves",
            object: "Barolo",
            quote: "Barolo 2016",
          },
        ],
      };
    };

    const result = await ingestPhoto({
      filename: "menu.jpg",
      bytes: Buffer.from("fake-jpeg-bytes"),
      mimeType: "image/jpeg",
      analysis: {
        backend: "grok",
        model: "grok-2-vision-latest",
        summary: "A dinner menu",
        fullText: "Osteria\nBarolo 2016",
        handwrittenNotes: [],
        names: ["Osteria"],
        dates: ["2016"],
        places: [],
        objects: ["wine list"],
        documentType: "photo",
      },
      extractor,
    });

    expect(result.mode).toBe("photo");
    expect(result.userMdUpdated).toBe(false);
    expect(result.backend).toBe("grok");
    expect(result.created.observations).toBeGreaterThanOrEqual(1);
    expect(result.created.entities).toBeGreaterThanOrEqual(2);
    expect(result.created.assertions).toBeGreaterThanOrEqual(1);
    expect(result.artifactId).toBeTruthy();

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const fileHits = provider.sqlite.findByName("menu.jpg", "Entity");
    expect(fileHits.length).toBeGreaterThanOrEqual(1);
    const file = await provider.packages.readCurrent(fileHits[0]!.logical_id);
    expect(file?.provenance?.sourceType).toBe("photo_upload");
    expect(String(file?.schemaType ?? "")).toMatch(/ImageObject/i);
  });

  it("attaches multiple photos and their extracts to a label hub", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-photoset-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");

    const extractor: DocsExtractor = async (input) => {
      if (!/KOHLER/i.test(input.sectionText)) return emptyExtraction();
      expect(input.folderLabel).toBe("Kitchen remodel");
      return {
        ...emptyExtraction(),
        entities: [
          {
            tempId: "e1",
            name: "Kohler sink",
            entityClass: "Product",
            summary: "Sink brand from the photo",
            quote: "KOHLER",
          },
        ],
      };
    };

    const result = await ingestPhotos({
      label: "Kitchen remodel",
      extractor,
      files: [
        {
          filename: "sink.jpg",
          bytes: Buffer.from("sink-bytes"),
          mimeType: "image/jpeg",
          analysis: {
            backend: "openai",
            model: "gpt-4o",
            summary: "A kitchen sink",
            fullText: "KOHLER",
            handwrittenNotes: [],
            names: [],
            dates: [],
            places: [],
            objects: ["sink"],
            documentType: "photo",
          },
        },
        {
          filename: "tile.jpg",
          bytes: Buffer.from("tile-bytes"),
          mimeType: "image/jpeg",
          analysis: {
            backend: "openai",
            model: "gpt-4o",
            summary: "Backsplash tile",
            fullText: "subway tile",
            handwrittenNotes: [],
            names: [],
            dates: [],
            places: [],
            objects: ["tile"],
            documentType: "photo",
          },
        },
      ],
    });

    expect(result.label).toBe("Kitchen remodel");
    expect(result.photos).toBe(2);
    expect(result.albumId).toBeTruthy();

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const hubs = provider.sqlite.findByName("Kitchen remodel", "Entity");
    expect(hubs.length).toBeGreaterThanOrEqual(1);
    const hub = await provider.packages.readCurrent(hubs[0]!.logical_id);
    expect(hub?.alfred?.entityClass).toBe("photo_album");
    expect(hub?.id).toBe(result.albumId);

    const sink = provider.sqlite.findByName("sink.jpg", "Entity")[0];
    expect(sink).toBeTruthy();
    const sinkRev = await provider.packages.readCurrent(sink!.logical_id);
    expect(partOf(sinkRev)).toEqual(expect.arrayContaining([result.albumId]));

    const inbound = provider.sqlite.edgesTo(result.albumId!);
    expect(inbound.some((e) => e.source_id === sinkRev?.id && e.predicate === "isPartOf")).toBe(true);

    const extractHits = provider.sqlite.findByName("Kohler sink", "Entity");
    expect(extractHits.length).toBeGreaterThan(0);
    const extract = await provider.packages.readCurrent(extractHits[0]!.logical_id);
    expect(partOf(extract)).toEqual(expect.arrayContaining([sinkRev?.id, result.albumId]));
    expect(inbound.some((e) => e.source_id === extract?.id && e.predicate === "isPartOf")).toBe(true);
  });

  it("connects unlabeled photos without creating a label hub", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-photolink-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");

    const result = await ingestPhotos({
      extractor: async () => emptyExtraction(),
      files: [
        {
          filename: "left.jpg",
          bytes: Buffer.from("left-bytes"),
          mimeType: "image/jpeg",
          analysis: {
            backend: "openai",
            model: "gpt-4o",
            summary: "Left wall",
            fullText: "left",
            handwrittenNotes: [],
            names: [],
            dates: [],
            places: [],
            objects: [],
            documentType: "photo",
          },
        },
        {
          filename: "right.jpg",
          bytes: Buffer.from("right-bytes"),
          mimeType: "image/jpeg",
          analysis: {
            backend: "openai",
            model: "gpt-4o",
            summary: "Right wall",
            fullText: "right",
            handwrittenNotes: [],
            names: [],
            dates: [],
            places: [],
            objects: [],
            documentType: "photo",
          },
        },
      ],
    });

    expect(result.label).toBeUndefined();
    expect(result.albumId).toBeUndefined();
    expect(result.photos).toBe(2);

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const albums = provider.sqlite.findBySearchSubstring("photo_album");
    expect(albums).toHaveLength(0);

    const left = provider.sqlite.findByName("left.jpg", "Entity")[0];
    const right = provider.sqlite.findByName("right.jpg", "Entity")[0];
    expect(left && right).toBeTruthy();
    const links = provider.sqlite.findByName("relatedTo", "Assertion");
    expect(links.length).toBeGreaterThan(0);
    const link = await provider.packages.readCurrent(links[0]!.logical_id);
    expect(link?.subject).toBe(left!.id);
    expect(link?.object).toBe(right!.id);
  });

  it("indexes the label hub if a later photo fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-photofail-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");

    const analysis = {
      backend: "openai" as const,
      model: "gpt-4o",
      summary: "First photo",
      fullText: "ok",
      handwrittenNotes: [],
      names: [],
      dates: [],
      places: [],
      objects: [],
      documentType: "photo",
    };

    await expect(
      ingestPhotos({
        label: "Partial set",
        extractor: async () => emptyExtraction(),
        analyze: async ({ filename }) => {
          if (filename === "bad.jpg") throw new Error("vision down");
          return analysis;
        },
        files: [
          {
            filename: "ok.jpg",
            bytes: Buffer.from("ok-bytes"),
            mimeType: "image/jpeg",
          },
          {
            filename: "bad.jpg",
            bytes: Buffer.from("bad-bytes"),
            mimeType: "image/jpeg",
          },
        ],
      }),
    ).rejects.toThrow(/vision down/);

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    expect(provider.sqlite.findByName("Partial set", "Entity").length).toBeGreaterThan(0);
    expect(provider.sqlite.findByName("ok.jpg", "Entity").length).toBeGreaterThan(0);
  });
});

function partOf(rev: { drefs?: { isPartOf?: unknown } } | null): string[] {
  const value = rev?.drefs?.isPartOf;
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

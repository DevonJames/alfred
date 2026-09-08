import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverMemoryLinks,
  filterLinkProposals,
  parseDiscoveryProposal,
  parseLinkProposals,
  type CatalogEntry,
} from "./link-discovery.js";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";
import { SCHEMA_ORG } from "./oip-local/schema-org.js";

describe("discoverMemoryLinks", () => {
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

  async function tempProvider(): Promise<OipLocalMemoryProvider> {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-links-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");
    return new OipLocalMemoryProvider(path.join(root, "oip"));
  }

  async function collection(
    provider: OipLocalMemoryProvider,
    name: string,
    summary: string,
    entityClass = "photo_album",
  ) {
    return provider.createRecord(
      "Entity",
      {
        name,
        text: summary,
        schemaType: SCHEMA_ORG.Collection,
        schema: { "@type": "Collection", name },
        alfred: { entityClass, visibility: "private" as const, confidence: 1 },
        learnedAt: new Date().toISOString(),
      },
      undefined,
      { reindex: false },
    );
  }

  it("parses proposed links from JSON", () => {
    const links = parseLinkProposals(
      'Here:\n{"links":[{"from":"E1","to":"E2","predicate":"relatedTo","reason":"same car"}]}\n',
    );
    expect(links).toEqual([
      { from: "E1", to: "E2", predicate: "relatedTo", reason: "same car" },
    ]);
  });

  it("parses grouping hubs from JSON", () => {
    const parsed = parseDiscoveryProposal(
      '{"links":[],"groups":[{"name":"USPTO","summary":"patents","members":["E1","E2"],"reason":"filings"}]}',
    );
    expect(parsed.groups).toEqual([
      { name: "USPTO", summary: "patents", members: ["E1", "E2"], reason: "filings" },
    ]);
  });

  it("ignores self-links and unknown catalog ids", () => {
    const catalog: CatalogEntry[] = [
      {
        catalogId: "E1",
        id: "did:memory:aaa",
        logicalId: "aaa",
        name: "Album A",
        kind: "Collection/photo_album",
        summary: "headlights",
        isCollection: true,
      },
      {
        catalogId: "E2",
        id: "did:memory:bbb",
        logicalId: "bbb",
        name: "Album B",
        kind: "Collection/photo_album",
        summary: "headlights",
        isCollection: true,
      },
    ];
    const filtered = filterLinkProposals({
      catalog,
      proposals: [
        { from: "E1", to: "E1", predicate: "relatedTo", reason: "self" },
        { from: "E1", to: "E99", predicate: "relatedTo", reason: "ghost" },
        { from: "E1", to: "E2", predicate: "invented", reason: "bad predicate" },
      ],
      edges: [],
    });
    expect(filtered.accepted).toHaveLength(0);
    expect(filtered.skippedInvalid).toBe(3);
  });

  it("creates a relatedTo assertion between unconnected hubs", async () => {
    const provider = await tempProvider();
    await collection(provider, "headlight restoration kit", "iPhone photos of headlight restoration");
    await collection(provider, "Car maintenance docs", "Notes about restoring headlights on the Civic");
    await provider.rebuildIndexes();

    const result = await discoverMemoryLinks({
      provider,
      propose: async ({ catalog }) => {
        const a = catalog.find((e) => e.name === "headlight restoration kit");
        const b = catalog.find((e) => e.name === "Car maintenance docs");
        expect(a && b).toBeTruthy();
        return [
          {
            from: a!.catalogId,
            to: b!.catalogId,
            predicate: "relatedTo",
            reason: "both about headlight restoration",
          },
        ];
      },
    });

    expect(result.created).toBe(1);
    expect(result.skippedAlreadyLinked).toBe(0);
    expect(result.samples[0]?.from).toBe("headlight restoration kit");
    expect(result.samples[0]?.to).toBe("Car maintenance docs");

    const links = provider.sqlite.findByName("relatedTo", "Assertion");
    expect(links.length).toBeGreaterThan(0);
    const rev = await provider.packages.readCurrent(links[0]!.logical_id);
    expect(rev?.predicate).toBe("relatedTo");
    expect(rev?.provenance?.sourceType).toBe("link_discovery");
  });

  it("does not recreate a pair that already has relatedTo", async () => {
    const provider = await tempProvider();
    const a = await collection(provider, "headlight restoration kit", "photos");
    const b = await collection(provider, "Car maintenance docs", "notes");
    await provider.createRecord(
      "Assertion",
      {
        name: "relatedTo",
        text: "already linked",
        predicate: "relatedTo",
        subject: a.id,
        object: b.id,
        schemaType: SCHEMA_ORG.Thing,
        schema: { "@type": "Statement", name: "relatedTo" },
        drefs: { subject: a.id, object: b.id },
      },
      undefined,
      { reindex: false },
    );
    await provider.rebuildIndexes();

    const result = await discoverMemoryLinks({
      provider,
      propose: async ({ catalog }) => {
        const from = catalog.find((e) => e.name === "headlight restoration kit");
        const to = catalog.find((e) => e.name === "Car maintenance docs");
        return [{ from: from!.catalogId, to: to!.catalogId, predicate: "relatedTo", reason: "again" }];
      },
    });

    expect(result.created).toBe(0);
    expect(result.skippedAlreadyLinked).toBe(1);
  });

  it("does not link a file that is already isPartOf a hub", async () => {
    const provider = await tempProvider();
    const hub = await collection(provider, "Kitchen remodel", "album");
    const file = await provider.createRecord(
      "Entity",
      {
        name: "sink.jpg",
        text: "A kitchen sink",
        schemaType: SCHEMA_ORG.ImageObject,
        schema: { "@type": "ImageObject", name: "sink.jpg" },
        alfred: { entityClass: "uploaded_photo", visibility: "private" as const, confidence: 1 },
        drefs: { isPartOf: hub.id },
      },
      undefined,
      { reindex: false },
    );
    await provider.rebuildIndexes();

    const result = await discoverMemoryLinks({
      provider,
      propose: async ({ catalog }) => {
        const from = catalog.find((e) => e.name === "sink.jpg");
        const to = catalog.find((e) => e.name === "Kitchen remodel");
        return [{ from: from!.catalogId, to: to!.catalogId, predicate: "relatedTo", reason: "child" }];
      },
    });

    expect(file.id).toBeTruthy();
    expect(result.created).toBe(0);
    expect(result.skippedAlreadyLinked).toBe(1);
  });

  it("creates a concept hub and attaches disparate memories", async () => {
    const provider = await tempProvider();
    await collection(provider, "headlight restoration kit", "photos of headlight kits");
    await collection(provider, "Patent docket 2024", "USPTO filings for the restoration tool");
    await provider.rebuildIndexes();

    const result = await discoverMemoryLinks({
      provider,
      propose: async ({ catalog }) => ({
        links: [],
        groups: [
          {
            name: "USPTO",
            summary: "patent office work",
            members: catalog.map((e) => e.catalogId),
            reason: "both touch patent / restoration IP",
          },
        ],
      }),
    });

    expect(result.hubsCreated).toBe(1);
    expect(result.membersLinked).toBeGreaterThanOrEqual(2);
    const hubRow = provider.sqlite
      .findByName("USPTO", "Entity")
      .find((row) => row.name.toLowerCase() === "uspto");
    expect(hubRow).toBeTruthy();
    const hub = await provider.packages.readCurrent(hubRow!.logical_id);
    expect(hub?.alfred?.entityClass).toBe("concept");
    const inbound = provider.sqlite.edgesTo(hub!.id);
    expect(inbound.filter((e) => e.predicate === "isPartOf").length).toBeGreaterThanOrEqual(2);
  });

  it("reuses an existing hub with the same name instead of duplicating it", async () => {
    const provider = await tempProvider();
    const uspto = await collection(provider, "USPTO", "existing patent hub", "concept");
    await collection(provider, "Patent docket 2024", "filings");
    await collection(provider, "Office action notes", "responses");
    await provider.rebuildIndexes();

    const result = await discoverMemoryLinks({
      provider,
      propose: async ({ catalog }) => ({
        links: [],
        groups: [
          {
            name: "USPTO",
            members: catalog.filter((e) => e.name !== "USPTO").map((e) => e.catalogId),
          },
        ],
      }),
    });

    expect(result.hubsCreated).toBe(0);
    expect(result.hubsReused).toBe(1);
    expect(result.membersLinked).toBeGreaterThanOrEqual(2);
    const inbound = provider.sqlite.edgesTo(uspto.id);
    expect(inbound.filter((e) => e.predicate === "isPartOf").length).toBeGreaterThanOrEqual(2);
  });

  it("ignores generic grouping names", async () => {
    const provider = await tempProvider();
    await collection(provider, "Album A", "one");
    await collection(provider, "Album B", "two");
    await provider.rebuildIndexes();

    const result = await discoverMemoryLinks({
      provider,
      propose: async ({ catalog }) => ({
        links: [],
        groups: [
          {
            name: "memories",
            members: catalog.map((e) => e.catalogId),
          },
        ],
      }),
    });

    expect(result.hubsCreated).toBe(0);
    expect(result.membersLinked).toBe(0);
  });
});

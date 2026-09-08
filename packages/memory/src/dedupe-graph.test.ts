import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dedupeMemoryGraph, restoreDisplayName } from "./dedupe-graph.js";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";
import { SCHEMA_ORG, schemaOrgPerson } from "./oip-local/schema-org.js";

describe("restoreDisplayName", () => {
  it("strips legacy superseded prefixes and merge arrows", () => {
    expect(restoreDisplayName("[superseded] Tim Pool → Tim Pool")).toBe("Tim Pool");
    expect(restoreDisplayName("[superseded] USPTO")).toBe("USPTO");
    expect(
      restoreDisplayName("[superseded] [superseded] Foo → Bar → Baz"),
    ).toBe("Foo");
    expect(restoreDisplayName("Superseded - Amy James")).toBe("Amy James");
    expect(restoreDisplayName("Clean Name")).toBe("Clean Name");
  });
});

describe("dedupeMemoryGraph", () => {
  let root = "";
  let provider: OipLocalMemoryProvider;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("merges duplicate people and unions their connections", async () => {
    root = await mkdtemp(path.join(tmpdir(), "alfred-dedupe-"));
    provider = new OipLocalMemoryProvider(root);
    await provider.packages.ensureRoot();
    provider.sqlite.open();
    const now = new Date().toISOString();

    const timA = await provider.createRecord(
      "Entity",
      {
        name: "Tim Pool",
        schemaType: SCHEMA_ORG.Person,
        schema: { ...schemaOrgPerson("Tim Pool"), description: "Media personality" },
        alfred: { entityClass: "Person", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );
    const timB = await provider.createRecord(
      "Entity",
      {
        name: "Tim Pool",
        schemaType: SCHEMA_ORG.Person,
        schema: schemaOrgPerson("Tim Pool"),
        alfred: { entityClass: "Person", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );
    const orgX = await provider.createRecord(
      "Entity",
      {
        name: "Company X",
        schemaType: SCHEMA_ORG.Organization,
        schema: { "@type": "Organization", name: "Company X" },
        alfred: { entityClass: "Organization", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );
    const orgY = await provider.createRecord(
      "Entity",
      {
        name: "Company Y",
        schemaType: SCHEMA_ORG.Organization,
        schema: { "@type": "Organization", name: "Company Y" },
        alfred: { entityClass: "Organization", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );

    // A connected to X and Y; B only to X — after merge survivor must keep X and Y
    await provider.createRecord(
      "Assertion",
      {
        name: "Tim Pool worksAt",
        text: "Tim Pool works at Company X.",
        subject: timA.id,
        predicate: "worksAt",
        object: orgX.id,
        schema: { "@type": "Statement", name: "Tim Pool worksAt" },
        drefs: { subject: timA.id, object: orgX.id },
        alfred: { assertionType: "explicit", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );
    await provider.createRecord(
      "Assertion",
      {
        name: "Tim Pool relatedTo",
        text: "Tim Pool related to Company Y.",
        subject: timA.id,
        predicate: "relatedTo",
        object: orgY.id,
        schema: { "@type": "Statement", name: "Tim Pool relatedTo" },
        drefs: { subject: timA.id, object: orgY.id },
        alfred: { assertionType: "explicit", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );
    await provider.createRecord(
      "Assertion",
      {
        name: "Tim Pool worksAt",
        text: "Tim Pool works at Company X.",
        subject: timB.id,
        predicate: "worksAt",
        object: orgX.id,
        schema: { "@type": "Statement", name: "Tim Pool worksAt" },
        drefs: { subject: timB.id, object: orgX.id },
        alfred: { assertionType: "explicit", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: true },
    );

    const phases: string[] = [];
    const result = await dedupeMemoryGraph(provider, {
      onProgress: (p) => {
        phases.push(p.phase);
      },
    });
    expect(phases).toContain("scrub");
    expect(phases).toContain("scan");
    expect(phases).toContain("merge");
    expect(phases.at(-1)).toBe("done");
    expect(result.groupsMerged).toBeGreaterThanOrEqual(1);
    expect(result.entitiesSuperseded).toBeGreaterThanOrEqual(1);
    expect(result.namesScrubbed).toBeGreaterThanOrEqual(0);

    // Loser keeps a clean name; marked via alfred.supersededBy only
    let supersededLoser = 0;
    for (const row of provider.sqlite.listByType("Entity", 200)) {
      const rev = await provider.packages.readCurrent(row.logical_id);
      if ((rev?.alfred as { supersededBy?: unknown } | undefined)?.supersededBy) {
        expect(row.name ?? "").not.toMatch(/^\[superseded\]/i);
        supersededLoser += 1;
      }
    }
    expect(supersededLoser).toBeGreaterThanOrEqual(1);

    const active = [];
    for (const row of provider.sqlite.findByName("Tim Pool", "Entity")) {
      const rev = await provider.packages.readCurrent(row.logical_id);
      if (rev && !(rev.alfred as { supersededBy?: unknown } | undefined)?.supersededBy) {
        active.push(row);
      }
    }
    expect(active.length).toBe(1);
    const keptId = active[0]!.id.startsWith("did:")
      ? active[0]!.id
      : `did:memory:${active[0]!.id}`;

    const objects = new Set<string>();
    for (const row of provider.sqlite.listByType("Assertion", 200)) {
      const rev = await provider.packages.readCurrent(row.logical_id);
      if (!rev || rev.subject == null) continue;
      if ((rev.alfred as { supersededBy?: unknown } | undefined)?.supersededBy) continue;
      const sub = String(rev.subject);
      if (sub !== keptId && sub !== active[0]!.logical_id && !sub.endsWith(active[0]!.logical_id)) {
        continue;
      }
      if (rev.object != null) objects.add(String(rev.object));
    }

    const xId = orgX.id;
    const yId = orgY.id;
    expect([...objects].some((o) => o === xId || o.endsWith(orgX.logical_id ?? ""))).toBe(true);
    expect([...objects].some((o) => o === yId || o.endsWith(orgY.logical_id ?? ""))).toBe(true);
  });
});

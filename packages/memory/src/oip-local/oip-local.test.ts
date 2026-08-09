import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeRevisionHash } from "./integrity.js";
import { parseMemoryRef, revisionSpecificDid, toMemoryDid } from "./ids.js";
import { OipLocalMemoryProvider } from "./provider.js";
import {
  SCHEMA_ORG,
  schemaOrgEvent,
  schemaOrgPerson,
  schemaOrgPlace,
  schemaOrgProduct,
} from "./schema-org.js";
import type { TaggedHash } from "./hashing.js";

describe("memory.oip-local", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  async function tempProvider(): Promise<OipLocalMemoryProvider> {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-oip-"));
    dirs.push(dir);
    return new OipLocalMemoryProvider(dir);
  }

  it("1–4: creates package with stable did:memory, immutable revision, manifest pointer, append on edit", async () => {
    const p = await tempProvider();
    const created = await p.createRecord("Entity", {
      name: "Sarah Miller",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Sarah Miller", ["Sarah"]),
      alfred: { entityClass: "Person", confidence: 0.92, visibility: "private" },
    });

    expect(created.id.startsWith("did:memory:")).toBe(true);
    expect(created.revision.startsWith("sha256:")).toBe(true);
    expect(created.previousRevision).toBeNull();

    const logicalId = parseMemoryRef(created.id).logicalId;
    const revPath = p.packages.revisionPath(logicalId, created.revision as TaggedHash);
    const onDisk = JSON.parse(await readFile(revPath, "utf8"));
    expect(onDisk.revision).toBe(created.revision);

    const manifest = await p.packages.readManifest(logicalId);
    expect(manifest?.currentRevision).toBe(created.revision);

    const updated = await p.updateRecord(created.id, {
      schema: schemaOrgPerson("Sarah Miller", ["Sarah", "Sar"]),
    });
    expect(updated.revision).not.toBe(created.revision);
    expect(updated.previousRevision).toBe(created.revision);

    // Old revision file still intact
    const oldStill = JSON.parse(await readFile(revPath, "utf8"));
    expect(oldStill.revision).toBe(created.revision);

    const manifest2 = await p.packages.readManifest(logicalId);
    expect(manifest2?.currentRevision).toBe(updated.revision);
  });

  it("5: tampering with old revision fails verification", async () => {
    const p = await tempProvider();
    const created = await p.createRecord("Entity", {
      name: "Tamper Target",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Tamper Target"),
      alfred: { entityClass: "Person" },
    });
    const logicalId = parseMemoryRef(created.id).logicalId;
    await p.updateRecord(created.id, { name: "Tamper Target II" });

    const revPath = p.packages.revisionPath(logicalId, created.revision as TaggedHash);
    const raw = JSON.parse(await readFile(revPath, "utf8"));
    raw.name = "EVIL";
    await writeFile(revPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const report = await p.verify();
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "revision_hash_mismatch")).toBe(true);
  });

  it("6: artifact bytes dedupe by SHA-256", async () => {
    const p = await tempProvider();
    const bytes = Buffer.from("identical-photo-bytes");
    const a = await p.putArtifactBytes(bytes, {
      mimeType: "image/jpeg",
      originalFilename: "a.jpg",
    });
    const b = await p.putArtifactBytes(bytes, {
      mimeType: "image/jpeg",
      originalFilename: "b.jpg",
    });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.storedAt).toBe(b.storedAt);
  });

  it("7–8: dref resolves current and revision-specific refs", async () => {
    const p = await tempProvider();
    const v1 = await p.createRecord("Entity", {
      name: "Wine",
      schemaType: SCHEMA_ORG.Product,
      schema: schemaOrgProduct("Wine v1"),
      alfred: { entityClass: "Product" },
    });
    const v2 = await p.updateRecord(v1.id, {
      name: "Wine",
      schema: schemaOrgProduct("Wine v2"),
    });

    const current = await p.resolveRef(v1.id);
    expect(current?.revision).toBe(v2.revision);
    expect(displayName(current)).toContain("v2");

    const historicRef = revisionSpecificDid(v1.id, v1.revision as TaggedHash);
    const historic = await p.resolveRef(historicRef);
    expect(historic?.revision).toBe(v1.revision);
    expect(displayName(historic)).toContain("v1");
  });

  it("9: indexes can be deleted and rebuilt", async () => {
    const p = await tempProvider();
    await p.createRecord("Entity", {
      name: "Rebuild Me",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Rebuild Me"),
      alfred: { entityClass: "Person" },
    });
    expect(p.sqlite.findByName("Rebuild Me").length).toBeGreaterThan(0);

    await p.sqlite.deleteDatabase();
    // Fresh open has empty tables until rebuild
    p.sqlite.open();
    expect(p.sqlite.findByName("Rebuild Me").length).toBe(0);

    await p.rebuildIndexes();
    expect(p.sqlite.findByName("Rebuild Me").length).toBeGreaterThan(0);
  });

  it("10: wine at Sarah's retrieves through person → episode → wine", async () => {
    const p = await tempProvider();

    const sarah = await p.createRecord("Entity", {
      name: "Sarah Miller",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Sarah Miller", ["Sarah"]),
      alfred: { entityClass: "Person", confidence: 0.95 },
    });
    const home = await p.createRecord("Entity", {
      name: "Sarah's House",
      schemaType: SCHEMA_ORG.Place,
      schema: schemaOrgPlace("Sarah's House"),
      alfred: { entityClass: "Place" },
      drefs: { hostedBy: sarah.id },
    });
    const wine = await p.createRecord("Entity", {
      name: "Marchesi di Barolo 2018",
      schemaType: SCHEMA_ORG.Product,
      schema: schemaOrgProduct("Marchesi di Barolo 2018", { category: "Wine" }),
      alfred: { entityClass: "Product" },
    });
    const episode = await p.createRecord("Episode", {
      name: "Dinner at Sarah's",
      schemaType: SCHEMA_ORG.Event,
      schema: schemaOrgEvent("Dinner at Sarah's"),
      participants: [sarah.id],
      location: home.id,
      validTimeStart: "2026-12-24T18:00:00-08:00",
      drefs: {
        hostedBy: sarah.id,
        occurredAt: home.id,
        involved: wine.id,
      },
      alfred: { visibility: "private" },
    });
    await p.createRecord("Assertion", {
      subject: toMemoryDid(parseMemoryRef(episode.id).logicalId),
      predicate: "served",
      object: wine.id,
      schema: { "@type": "Statement", name: "served Marchesi di Barolo 2018" },
      name: "served Marchesi di Barolo 2018",
      drefs: {
        subject: episode.id,
        object: wine.id,
      },
      alfred: {
        assertionType: "explicit",
        confidence: 0.97,
        confidenceLabel: "high",
      },
      learnedAt: "2026-12-24T21:14:00-08:00",
    });

    // Sanity: graph edges exist
    const edges = p.sqlite.edgesFrom(episode.id);
    expect(edges.some((e) => e.target_id === wine.id && e.predicate === "involved")).toBe(true);

    const result = await p.retrieve({
      text: "What was the wine we had at Sarah's?",
      limit: 10,
    });
    const blob = result.items.map((i) => i.content).join("\n");
    expect(blob.toLowerCase()).toMatch(/barolo|wine|marchesi/);
    expect(result.items.some((i) => i.id === wine.id || i.content.includes("Barolo"))).toBe(true);
  });

  it("revision hash is stable across canonicalization", async () => {
    const p = await tempProvider();
    const created = await p.createRecord("Observation", {
      text: "hello",
      observedAt: "2026-01-01T00:00:00.000Z",
      schema: { "@type": "CreativeWork", text: "hello" },
    });
    expect(computeRevisionHash(created)).toBe(created.revision);
  });
});

function displayName(rev: { schema?: Record<string, unknown>; name?: string } | null): string {
  if (!rev) return "";
  if (typeof rev.schema?.name === "string") return rev.schema.name;
  return rev.name ?? "";
}

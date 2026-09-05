import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportAlfredMemoryBundle,
  mergeAlfredMemoryBundle,
  mergeAlfredMemoryFromDir,
} from "./bundle.js";
import { parseMemoryRef } from "./ids.js";
import { OipLocalMemoryProvider } from "./provider.js";
import { SCHEMA_ORG, schemaOrgPerson } from "./schema-org.js";

describe("alfred-memory bundle export/merge", () => {
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

  it("exports a zip and merges remote-only packages into local without wiping local-only", async () => {
    const nodeA = await tempProvider();
    const nodeB = await tempProvider();

    const aOnly = await nodeA.createRecord("Entity", {
      name: "Local Only Person",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Local Only Person"),
    });
    const shared = await nodeA.createRecord("Entity", {
      name: "Shared Person",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Shared Person"),
    });

    // Put shared + B-only on B by exporting A shared package... simpler: create on B independently
    const bOnly = await nodeB.createRecord("Entity", {
      name: "Remote Only Person",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Remote Only Person"),
    });

    // Copy shared package from A into B via filesystem so they share logical id
    const sharedLogical = parseMemoryRef(shared.id).logicalId;
    const { cp } = await import("node:fs/promises");
    await cp(
      nodeA.packages.packageDir(sharedLogical),
      nodeB.packages.packageDir(sharedLogical),
      { recursive: true },
    );
    await nodeB.rebuildIndexes();

    const zipPath = path.join(nodeB.path, "from-b.alfred-memory.zip");
    const exported = await exportAlfredMemoryBundle({
      rootDir: nodeB.path,
      outPath: zipPath,
      profileId: "profile.test",
    });
    expect(exported.packageCount).toBeGreaterThanOrEqual(2);
    expect(exported.byteSize).toBeGreaterThan(100);

    const report = await mergeAlfredMemoryBundle({
      localRoot: nodeA.path,
      zipPath,
      rebuildIndexes: true,
    });

    expect(report.packagesAdded).toBeGreaterThanOrEqual(1);
    expect(report.errors).toEqual([]);

    // Local-only still present
    expect(await nodeA.packages.readCurrent(parseMemoryRef(aOnly.id).logicalId)).toBeTruthy();
    // Remote-only now present
    expect(await nodeA.packages.readCurrent(parseMemoryRef(bOnly.id).logicalId)).toBeTruthy();
    // Shared still present
    expect(await nodeA.packages.readCurrent(sharedLogical)).toBeTruthy();
  });

  it("keeps both revision files and prefers newer head on divergent packages", async () => {
    const nodeA = await tempProvider();
    const created = await nodeA.createRecord("Entity", {
      name: "Sarah",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Sarah"),
    });
    const logicalId = parseMemoryRef(created.id).logicalId;

    // Clone package to node B
    const nodeB = await tempProvider();
    const { cp } = await import("node:fs/promises");
    await cp(nodeA.packages.packageDir(logicalId), nodeB.packages.packageDir(logicalId), {
      recursive: true,
    });
    await nodeB.packages.ensureRoot();

    // Divergent edits
    const a2 = await nodeA.updateRecord(logicalId, { name: "Sarah A" });
    // Ensure B's update is newer
    await new Promise((r) => setTimeout(r, 5));
    const b2 = await nodeB.updateRecord(logicalId, { name: "Sarah B" });

    const remoteDir = await mkdtemp(path.join(tmpdir(), "alfred-remote-"));
    dirs.push(remoteDir);
    await cp(nodeB.packages.packageDir(logicalId), path.join(remoteDir, "memory", "packages", logicalId), {
      recursive: true,
    });
    await writeFile(
      path.join(remoteDir, "storage-format.json"),
      await readFile(path.join(nodeB.path, "storage-format.json")),
    );

    const report = await mergeAlfredMemoryFromDir({
      localRoot: nodeA.path,
      remoteRoot: remoteDir,
      rebuildIndexes: true,
    });

    expect(report.revisionsAdded).toBe(1);
    expect(report.currentHeadUpdates).toBe(1);

    const revs = await nodeA.packages.listRevisions(logicalId);
    expect(revs).toContain(a2.revision);
    expect(revs).toContain(b2.revision);

    const current = await nodeA.packages.readCurrent(logicalId);
    expect(current?.name).toBe("Sarah B");
    expect(current?.revision).toBe(b2.revision);
  });

  it("is a no-op when merging identical heads", async () => {
    const nodeA = await tempProvider();
    await nodeA.createRecord("Entity", {
      name: "Same",
      schemaType: SCHEMA_ORG.Person,
      schema: schemaOrgPerson("Same"),
    });
    const zipPath = path.join(nodeA.path, "self.alfred-memory.zip");
    await exportAlfredMemoryBundle({ rootDir: nodeA.path, outPath: zipPath });
    const report = await mergeAlfredMemoryBundle({
      localRoot: nodeA.path,
      zipPath,
      rebuildIndexes: true,
    });
    expect(report.packagesAdded).toBe(0);
    expect(report.revisionsAdded).toBe(0);
    expect(report.errors).toEqual([]);
  });
});

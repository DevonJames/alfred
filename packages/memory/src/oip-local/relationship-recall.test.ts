import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConversationalMemory } from "../conversation-memory.js";
import { setSelfPerson } from "../self-identity.js";
import { OipLocalMemoryProvider } from "./provider.js";
import { retrieveMemories } from "./retrieval.js";
import { SCHEMA_ORG, schemaOrgPerson, schemaOrgPlace } from "./schema-org.js";

describe("relationship-aware retrieval", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  async function seedGraph() {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-rel-"));
    dirs.push(dir);
    const p = new OipLocalMemoryProvider(dir);
    await p.packages.ensureRoot();
    p.sqlite.open();

    const devon = await p.createRecord("Entity", {
      name: "Devon James",
      schemaType: SCHEMA_ORG.Person,
      schema: { ...schemaOrgPerson("Devon James"), birthDate: "1980-08-29" },
      alfred: { entityClass: "Person", isSelf: true },
    });
    await setSelfPerson(p, devon.id);

    await writeConversationalMemory(p, {
      entities: [
        { name: "__user__", entityClass: "Person" },
        { name: "USPTO", entityClass: "Organization" },
        { name: "JF Customs", entityClass: "Organization" },
        { name: "James Nosal", entityClass: "Person" },
        { name: "Fred", entityClass: "Person" },
        { name: "Bridgeyard Apartments", entityClass: "Place" },
        { name: "Amy James", entityClass: "Person", birthDate: "1981-07-21" },
      ],
      assertions: [
        {
          subjectName: "__user__",
          predicate: "worksAt",
          objectName: "USPTO",
          text: "Devon works at USPTO.",
        },
        {
          subjectName: "__user__",
          predicate: "workedAt",
          objectName: "JF Customs",
          text: "Devon worked at JF Customs.",
        },
        {
          subjectName: "__user__",
          predicate: "reportsTo",
          objectName: "James Nosal",
          text: "Devon reports to James Nosal.",
        },
        {
          subjectName: "James Nosal",
          predicate: "supervisorOf",
          objectName: "__user__",
          text: "James Nosal is Devon's supervisor.",
        },
        {
          subjectName: "Fred",
          predicate: "worksAt",
          objectName: "USPTO",
          text: "Fred works at USPTO.",
        },
        {
          subjectName: "Fred",
          predicate: "livesIn",
          objectName: "Bridgeyard Apartments",
          text: "Fred lives at Bridgeyard Apartments.",
        },
        {
          subjectName: "__user__",
          predicate: "worksWith",
          objectName: "Fred",
          text: "Devon works with Fred.",
        },
        {
          subjectName: "__user__",
          predicate: "spouseOf",
          objectName: "Amy James",
          text: "Amy is Devon's wife.",
        },
        {
          subjectName: "Amy James",
          predicate: "hasBirthDate",
          objectName: "July 21, 1981",
          text: "Amy's birthday is July 21, 1981.",
        },
      ],
    });

    // Place entity type for Bridgeyard if write path used Thing
    const placeHits = p.sqlite.findByName("Bridgeyard Apartments", "Entity");
    for (const hit of placeHits) {
      const rev = await p.packages.readCurrent(hit.logical_id);
      if (rev && !/Place/i.test(String(rev.schemaType ?? ""))) {
        await p.updateRecord(hit.id, {
          schemaType: SCHEMA_ORG.Place,
          schema: schemaOrgPlace("Bridgeyard Apartments"),
          alfred: { ...(rev.alfred ?? {}), entityClass: "Place" },
        });
      }
    }

    return p;
  }

  it("answers where I work from worksAt, not past employers alone", async () => {
    const p = await seedGraph();
    const items = await retrieveMemories(
      { text: "where do I work currently", limit: 8 },
      { packages: p.packages, sqlite: p.sqlite, providerId: "memory.oip-local" },
    );
    const blob = items.map((i) => i.content).join("\n");
    expect(blob).toMatch(/USPTO/);
    expect(blob).toMatch(/worksAt/);
    expect(items[0]?.content).toMatch(/USPTO|worksAt/);
  });

  it("answers who is my boss from reportsTo / supervisorOf", async () => {
    const p = await seedGraph();
    const items = await retrieveMemories(
      { text: "who is my boss", limit: 8 },
      { packages: p.packages, sqlite: p.sqlite, providerId: "memory.oip-local" },
    );
    const blob = items.map((i) => i.content).join("\n");
    expect(blob).toMatch(/James Nosal/);
    expect(blob).toMatch(/reportsTo|supervisorOf/);
  });

  it("finds coworker who shares employer and home", async () => {
    const p = await seedGraph();
    const items = await retrieveMemories(
      {
        text: "who is the person I work with at USPTO who also lives at Bridgeyard Apartments",
        limit: 8,
      },
      { packages: p.packages, sqlite: p.sqlite, providerId: "memory.oip-local" },
    );
    const blob = items.map((i) => i.content).join("\n");
    expect(blob).toMatch(/Fred/);
  });

  it("formats assertions with human-readable names", async () => {
    const p = await seedGraph();
    const items = await retrieveMemories(
      { text: "who is my supervisor", limit: 8 },
      { packages: p.packages, sqlite: p.sqlite, providerId: "memory.oip-local" },
    );
    const assertion = items.find((i) => /reportsTo|supervisorOf/.test(i.content));
    expect(assertion?.content).toMatch(/Devon James|James Nosal/);
    expect(assertion?.content).not.toMatch(/did:memory:/);
  });

  it("surfaces supervisor email and phone from Person schema", async () => {
    const p = await seedGraph();
    // Patch Nosal with contact fields like the live graph UI
    const nosal = p.sqlite.findByName("James Nosal", "Entity").find((r) => r.name === "James Nosal");
    expect(nosal).toBeTruthy();
    await p.updateRecord(nosal!.id, {
      schema: {
        ...schemaOrgPerson("James Nosal"),
        email: "james.nosal@uspto.gov",
        telephone: "571-272-3572",
      },
    });

    const items = await retrieveMemories(
      { text: "what is my supervisor's phone number", limit: 8 },
      { packages: p.packages, sqlite: p.sqlite, providerId: "memory.oip-local" },
    );
    const blob = items.map((i) => i.content).join("\n");
    expect(blob).toMatch(/571-272-3572/);
    expect(blob).toMatch(/james\.nosal@uspto\.gov|James Nosal/);

    const personLine = items.find((i) => /Person:\s*James Nosal/.test(i.content));
    expect(personLine?.content).toMatch(/phone 571-272-3572/);
    expect(personLine?.content).toMatch(/email james\.nosal@uspto\.gov/);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractConversationalMemory,
  writeConversationalMemory,
} from "./conversation-memory.js";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";

describe("extractConversationalMemory", () => {
  it("extracts boss relation for 'my boss is James Nosal'", () => {
    const got = extractConversationalMemory("Hey, my boss is James Nosal at work.");
    expect(got.entities?.some((e) => e.name === "James Nosal")).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "supervisorOf" &&
          a.subjectName === "James Nosal" &&
          a.objectName === "__user__",
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) => a.predicate === "reportsTo" && a.objectName === "James Nosal",
      ),
    ).toBe(true);
  });

  it("extracts boss relation for 'James Nosal is my supervisor'", () => {
    const got = extractConversationalMemory("James Nosal is my supervisor.");
    expect(got.entities?.some((e) => e.name === "James Nosal")).toBe(true);
  });
  it("extracts email and phone onto a named person", () => {
    const got = extractConversationalMemory(
      "James Nosal's email is james.nosal@acme.com and his phone is 805-555-0199.",
    );
    const james = got.entities?.find((e) => e.name === "James Nosal");
    expect(james?.email).toBe("james.nosal@acme.com");
    expect(james?.telephone).toMatch(/805/);
  });

  it("extracts boss email via role phrase", () => {
    const got = extractConversationalMemory(
      "My boss is James Nosal. My boss's email is jn@corp.com.",
    );
    const james = got.entities?.find((e) => e.name === "James Nosal");
    expect(james?.email).toBe("jn@corp.com");
  });

  it("extracts employer organization from 'I now work for USPTO'", () => {
    const got = extractConversationalMemory("I now work for USPTO.");
    const org = got.entities?.find((e) => e.name === "USPTO");
    expect(org?.entityClass).toBe("Organization");
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "__user__" &&
          a.objectName === "USPTO",
      ),
    ).toBe(true);
  });

  it("does not swallow 'I want you to remember' into the org name", () => {
    const got = extractConversationalMemory(
      "I now work at USPTO. I want you to remember.",
    );
    const org = got.entities?.find((e) => e.entityClass === "Organization");
    expect(org?.name).toBe("USPTO");
  });

  it("extracts spoken email onto boss via his/her follow-up", () => {
    const got = extractConversationalMemory(
      "And his email address is james dot nosal at uspto dot gov.",
    );
    const role = got.entities?.find((e) => e.name === "__role:boss__");
    expect(role?.email).toBe("james.nosal@uspto.gov");
  });

  it("parses spaced-acronym spoken emails from STT", () => {
    const got = extractConversationalMemory(
      "And his email address is james dot nosall at u s p t o dot gov.",
    );
    const role = got.entities?.find((e) => e.name === "__role:boss__");
    expect(role?.email).toBe("james.nosall@uspto.gov");
  });

  it("links supervisor to the same employer as the user", () => {
    const got = extractConversationalMemory(
      "I now work at USPTO. My boss is James Nosal.",
    );
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "__user__" &&
          a.objectName === "USPTO",
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "James Nosal" &&
          a.objectName === "USPTO",
      ),
    ).toBe(true);
  });

  it("extracts boss at organization in one phrase", () => {
    const got = extractConversationalMemory("My boss is James Nosal at USPTO.");
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "James Nosal" &&
          a.objectName === "USPTO",
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) => a.predicate === "worksAt" && a.subjectName === "__user__",
      ),
    ).toBe(true);
  });

  it("links coworker to the same employer as the user", () => {
    const got = extractConversationalMemory(
      "I work at USPTO. I work with Sarah Chen.",
    );
    expect(got.entities?.some((e) => e.name === "Sarah Chen")).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksWith" &&
          a.subjectName === "__user__" &&
          a.objectName === "Sarah Chen",
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "Sarah Chen" &&
          a.objectName === "USPTO",
      ),
    ).toBe(true);
  });

  it("extracts coworker at organization in one phrase", () => {
    const got = extractConversationalMemory(
      "My colleague is Sarah Chen at USPTO.",
    );
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "Sarah Chen" &&
          a.objectName === "USPTO",
      ),
    ).toBe(true);
  });

  it("extracts explicit third-party worksAt", () => {
    const got = extractConversationalMemory(
      "I work at USPTO. Sarah Chen also works at USPTO.",
    );
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "Sarah Chen" &&
          a.objectName === "USPTO",
      ),
    ).toBe(true);
  });

  it("extracts past-tense worked at", () => {
    const got = extractConversationalMemory(
      "Amy James also worked at Happy Owl Studio.",
    );
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "Amy James" &&
          a.objectName === "Happy Owl Studio",
      ),
    ).toBe(true);
  });

  it("resolves she/he worked at to a named person in the same turn", () => {
    const got = extractConversationalMemory(
      "Amy James also worked. She also worked at Happy Owl Studio.",
    );
    expect(got.entities?.some((e) => e.name === "Amy James")).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "Amy James" &&
          a.objectName === "Happy Owl Studio",
      ),
    ).toBe(true);
  });

  it("extracts co-inventor as inventorOf (not only spouse)", () => {
    const got = extractConversationalMemory(
      "My wife, Amy James, is also the co inventor of open index protocol.",
    );
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "spouseOf" &&
          a.subjectName === "__user__" &&
          a.objectName === "Amy James",
      ),
    ).toBe(true);
    expect(
      got.entities?.some(
        (e) =>
          e.name === "Open Index Protocol" &&
          (e.entityClass === "Thing" || e.entityClass === "CreativeWork"),
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "inventorOf" &&
          a.subjectName === "Amy James" &&
          a.objectName === "Open Index Protocol",
      ),
    ).toBe(true);
  });

  it("extracts founderOf and cofounderOf for networking", () => {
    const founded = extractConversationalMemory(
      "Devon James founded Happy Owl Studio.",
    );
    expect(
      founded.assertions?.some(
        (a) =>
          a.predicate === "founderOf" &&
          a.subjectName === "Devon James" &&
          a.objectName === "Happy Owl Studio",
      ),
    ).toBe(true);

    const cofounder = extractConversationalMemory(
      "Sarah Chen is a co-founder of Alexandria Labs.",
    );
    expect(
      cofounder.assertions?.some(
        (a) =>
          a.predicate === "cofounderOf" &&
          a.subjectName === "Sarah Chen" &&
          a.objectName === "Alexandria Labs",
      ),
    ).toBe(true);

    const userFounded = extractConversationalMemory(
      "I founded Blockchain Technology Group.",
    );
    expect(
      userFounded.assertions?.some(
        (a) =>
          a.predicate === "founderOf" &&
          a.subjectName === "__user__" &&
          a.objectName === "Blockchain Technology Group",
      ),
    ).toBe(true);

    const cofounded = extractConversationalMemory(
      "Jordan Lee co-founded Tech Force.",
    );
    expect(
      cofounded.assertions?.some(
        (a) =>
          a.predicate === "cofounderOf" &&
          a.subjectName === "Jordan Lee" &&
          a.objectName === "Tech Force",
      ),
    ).toBe(true);
  });

  it("extracts birthday onto Person + hasBirthDate connection", () => {
    const mine = extractConversationalMemory("My birthday is March 15th.");
    expect(mine.entities?.some((e) => e.name === "__user__" && e.birthDate === "--03-15")).toBe(
      true,
    );
    expect(
      mine.assertions?.some(
        (a) =>
          a.predicate === "hasBirthDate" &&
          a.subjectName === "__user__" &&
          a.objectName === "March 15",
      ),
    ).toBe(true);

    const withYear = extractConversationalMemory("I was born on June 3, 1985.");
    expect(
      withYear.entities?.some((e) => e.name === "__user__" && e.birthDate === "1985-06-03"),
    ).toBe(true);

    const amy = extractConversationalMemory("Amy James's birthday is December 1st.");
    expect(
      amy.entities?.some((e) => e.name === "Amy James" && e.birthDate === "--12-01"),
    ).toBe(true);
    expect(
      amy.assertions?.some(
        (a) =>
          a.predicate === "hasBirthDate" &&
          a.subjectName === "Amy James" &&
          a.objectName === "December 1",
      ),
    ).toBe(true);
  });

  it("extracts multi-level org hierarchy from a networking utterance", () => {
    const got = extractConversationalMemory(
      "Jordan Lee works for OPM, the department of the federal government that runs Tech Force which hired me.",
    );

    const orgNames = (got.entities ?? [])
      .filter((e) => e.entityClass === "Organization")
      .map((e) => e.name);
    expect(orgNames).toEqual(expect.arrayContaining(["OPM", "Federal Government", "Tech Force"]));
    expect(got.entities?.some((e) => e.name === "Jordan Lee")).toBe(true);

    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "Jordan Lee" &&
          a.objectName === "OPM",
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "partOf" &&
          a.subjectName === "OPM" &&
          a.objectName === "Federal Government",
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "runs" &&
          a.subjectName === "OPM" &&
          a.objectName === "Tech Force",
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "partOf" &&
          a.subjectName === "Tech Force" &&
          a.objectName === "OPM",
      ),
    ).toBe(true);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "__user__" &&
          a.objectName === "Tech Force",
      ),
    ).toBe(true);
  });

  it("extracts HR specialist with worksAt org and deferred name", () => {
    const got = extractConversationalMemory(
      "Another person that works at USPTO is my HR specialist. Her name is Regina Anderson.",
    );
    expect(got.entities?.some((e) => e.name === "Regina Anderson")).toBe(true);
    expect(got.entities?.some((e) => e.name === "USPTO")).toBe(true);
    expect(got.entities?.some((e) => /person that/i.test(e.name))).toBe(false);
    expect(got.entities?.some((e) => /hr specialist/i.test(e.name))).toBe(false);
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "worksAt" &&
          a.subjectName === "Regina Anderson" &&
          a.objectName === "USPTO",
      ),
    ).toBe(true);
  });

  it("extracts my HR specialist is named …", () => {
    const got = extractConversationalMemory(
      "My HR specialist is named Regina Anderson.",
    );
    expect(got.entities?.some((e) => e.name === "Regina Anderson")).toBe(true);
  });

  it("does not treat 'Person that works at USPTO is my HR…' as Person That", () => {
    const got = extractConversationalMemory(
      "Person that works at USPTO is my HR specialist",
    );
    expect(got.entities?.some((e) => e.name === "Person That")).toBe(false);
    expect(got.entities?.some((e) => /Is My HR/i.test(e.name ?? ""))).toBe(false);
  });

  it("extracts standalone org runs / partOf relations", () => {
    const got = extractConversationalMemory("OPM runs Tech Force.");
    expect(
      got.assertions?.some(
        (a) =>
          a.predicate === "runs" &&
          a.subjectName === "OPM" &&
          a.objectName === "Tech Force",
      ),
    ).toBe(true);
  });
});

describe("writeConversationalMemory", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("creates Person entity and reportsTo/supervisorOf assertions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-conv-mem-"));
    dirs.push(dir);
    const provider = new OipLocalMemoryProvider(dir);
    process.env.BRIEFING_USER_NAME = "Devon James";

    const extracted = extractConversationalMemory("My boss is James Nosal.");
    const result = await writeConversationalMemory(provider, extracted, {
      userDisplayName: "Devon James",
    });

    expect(result.entitiesUpserted).toBeGreaterThanOrEqual(1);
    expect(result.assertionsCreated).toBeGreaterThanOrEqual(1);

    const james = provider.sqlite.findByName("James Nosal", "Entity");
    expect(james.length).toBeGreaterThan(0);
    const assertions = provider.sqlite.listByType("Assertion", 20);
    expect(assertions.some((a) => (a.name ?? "").includes("James Nosal"))).toBe(true);
  });

  it("merges email/phone onto an existing Person entity", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-conv-mem-"));
    dirs.push(dir);
    const provider = new OipLocalMemoryProvider(dir);

    await writeConversationalMemory(
      provider,
      extractConversationalMemory("My boss is James Nosal."),
      { userDisplayName: "Devon James" },
    );
    await writeConversationalMemory(
      provider,
      extractConversationalMemory("James Nosal's email is james@acme.com"),
      { userDisplayName: "Devon James" },
    );

    const hits = provider.sqlite.findByName("James Nosal", "Entity");
    expect(hits.length).toBe(1);
    const rev = await provider.packages.readCurrent(hits[0]!.logical_id);
    expect(rev?.schema?.email).toBe("james@acme.com");
  });

  it("creates Organization entity for employer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-conv-mem-"));
    dirs.push(dir);
    const provider = new OipLocalMemoryProvider(dir);

    const result = await writeConversationalMemory(
      provider,
      extractConversationalMemory("I now work for the USPTO."),
      { userDisplayName: "Devon James" },
    );

    expect(result.entitiesUpserted).toBeGreaterThanOrEqual(1);
    const hits = provider.sqlite.findByName("USPTO", "Entity");
    expect(hits.length).toBeGreaterThan(0);
    const rev = await provider.packages.readCurrent(hits[0]!.logical_id);
    expect(rev?.schema?.["@type"]).toBe("Organization");
    expect(rev?.alfred?.entityClass).toBe("Organization");
  });

  it("writes supervisor worksAt employer across separate turns", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-conv-mem-"));
    dirs.push(dir);
    const provider = new OipLocalMemoryProvider(dir);

    await writeConversationalMemory(
      provider,
      extractConversationalMemory("I now work at USPTO."),
      { userDisplayName: "Devon James" },
    );
    const second = await writeConversationalMemory(
      provider,
      extractConversationalMemory("My boss is James Nosal."),
      { userDisplayName: "Devon James" },
    );

    expect(second.assertionsCreated).toBeGreaterThanOrEqual(1);
    const assertions = provider.sqlite.listByType("Assertion", 40);
    expect(
      assertions.some(
        (a) =>
          (a.name ?? "").includes("James Nosal worksAt") ||
          (a.name ?? "") === "James Nosal worksAt",
      ),
    ).toBe(true);
  });

  it("writes coworker worksAt employer across separate turns", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-conv-mem-"));
    dirs.push(dir);
    const provider = new OipLocalMemoryProvider(dir);

    await writeConversationalMemory(
      provider,
      extractConversationalMemory("I now work at USPTO."),
      { userDisplayName: "Devon James" },
    );
    const second = await writeConversationalMemory(
      provider,
      extractConversationalMemory("I work with Sarah Chen."),
      { userDisplayName: "Devon James" },
    );

    expect(second.assertionsCreated).toBeGreaterThanOrEqual(1);
    const assertions = provider.sqlite.listByType("Assertion", 40);
    expect(
      assertions.some(
        (a) =>
          (a.name ?? "").includes("Sarah Chen worksAt") ||
          (a.name ?? "") === "Sarah Chen worksAt",
      ),
    ).toBe(true);
  });

  it("writes hierarchical orgs and person worksAt from a networking utterance", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-conv-mem-"));
    dirs.push(dir);
    const provider = new OipLocalMemoryProvider(dir);

    const result = await writeConversationalMemory(
      provider,
      extractConversationalMemory(
        "Jordan Lee works for OPM, the department of the federal government that runs Tech Force which hired me.",
      ),
      { userDisplayName: "Devon James" },
    );

    expect(result.entitiesUpserted).toBeGreaterThanOrEqual(3);
    expect(result.assertionsCreated).toBeGreaterThanOrEqual(3);

    const orgs = provider.sqlite
      .listByType("Entity", 40)
      .filter((r) => (r.schema_type ?? "").includes("Organization"))
      .map((r) => r.name);
    expect(orgs).toEqual(expect.arrayContaining(["OPM", "Federal Government", "Tech Force"]));

    const assertions = provider.sqlite.listByType("Assertion", 40).map((a) => a.name);
    expect(assertions.some((n) => (n ?? "").includes("Jordan Lee worksAt"))).toBe(true);
    expect(
      assertions.some(
        (n) => (n ?? "").includes("OPM runs") || (n ?? "").includes("Tech Force partOf"),
      ),
    ).toBe(true);
  });

  it("retargets worksAt from a wrong entity onto the Organization", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-conv-mem-"));
    dirs.push(dir);
    const provider = new OipLocalMemoryProvider(dir);

    await writeConversationalMemory(
      provider,
      extractConversationalMemory("I now work at USPTO. My boss is James Nosal."),
      { userDisplayName: "Devon James" },
    );

    const orgHits = provider.sqlite
      .findByName("USPTO", "Entity")
      .filter((r) => (r.schema_type ?? "").includes("Organization"));
    expect(orgHits.length).toBe(1);
    const orgDid = orgHits[0]!.id;

    const place = await provider.createRecord(
      "Entity",
      {
        name: "Alexandria, Virginia",
        text: "USPTO headquarters area",
        schemaType: "https://schema.org/Place",
        schema: { "@type": "Place", name: "Alexandria, Virginia", description: "near USPTO" },
        alfred: { entityClass: "Place", visibility: "private" },
      },
      undefined,
      { reindex: true },
    );

    const jamesAssert = provider.sqlite
      .findByName("James Nosal worksAt", "Assertion")
      .find((a) => a.name === "James Nosal worksAt");
    expect(jamesAssert).toBeTruthy();
    const jamesDid = (
      await provider.packages.readCurrent(jamesAssert!.logical_id)
    )?.subject as string;

    await provider.updateRecord(
      jamesAssert!.logical_id,
      {
        object: place.id,
        drefs: { subject: jamesDid, object: place.id },
      },
      { reindex: true },
    );

    await writeConversationalMemory(
      provider,
      {
        entities: [
          { name: "James Nosal", entityClass: "Person" },
          { name: "USPTO", entityClass: "Organization", summary: "User's employer" },
        ],
        assertions: [
          {
            subjectName: "James Nosal",
            predicate: "worksAt",
            objectName: "USPTO",
            text: "James Nosal works at USPTO.",
          },
        ],
      },
      { userDisplayName: "Devon James" },
    );

    const rev = await provider.packages.readCurrent(jamesAssert!.logical_id);
    expect(rev?.object).toBe(orgDid);
  });
});

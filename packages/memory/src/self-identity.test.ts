import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";
import { SCHEMA_ORG, schemaOrgPerson } from "./oip-local/schema-org.js";
import {
  resolveSelfEntity,
  setSelfPerson,
} from "./self-identity.js";
import { writeConversationalMemory } from "./conversation-memory.js";

describe("self-identity", () => {
  let root = "";
  let provider: OipLocalMemoryProvider;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function setup() {
    root = await mkdtemp(path.join(tmpdir(), "alfred-self-"));
    provider = new OipLocalMemoryProvider(root);
    await provider.packages.ensureRoot();
    provider.sqlite.open();
  }

  it("marks a Person as self and resolves it for conversational writes", async () => {
    await setup();
    const now = new Date().toISOString();

    const devon = await provider.createRecord(
      "Entity",
      {
        name: "Devon James",
        schemaType: SCHEMA_ORG.Person,
        schema: {
          ...schemaOrgPerson("Devon James"),
          description: "Primary user",
        },
        alfred: { entityClass: "Person", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );

    const user = await provider.createRecord(
      "Entity",
      {
        name: "User",
        schemaType: SCHEMA_ORG.Person,
        schema: schemaOrgPerson("User"),
        text: "The user Alfred serves",
        alfred: { entityClass: "Person", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );

    const amy = await provider.createRecord(
      "Entity",
      {
        name: "Amy James",
        schemaType: SCHEMA_ORG.Person,
        schema: schemaOrgPerson("Amy James"),
        alfred: { entityClass: "Person", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: false },
    );

    await provider.createRecord(
      "Assertion",
      {
        name: "User spouseOf",
        text: "Amy James is the user's wife.",
        subject: user.id,
        predicate: "spouseOf",
        object: amy.id,
        schema: { "@type": "Statement", name: "User spouseOf" },
        drefs: { subject: user.id, object: amy.id },
        alfred: { assertionType: "explicit", visibility: "private" },
        learnedAt: now,
      },
      undefined,
      { reindex: true },
    );

    const result = await setSelfPerson(provider, devon.id);
    expect(result.selfName).toBe("Devon James");
    expect(result.supersededPlaceholder).toBe(true);
    expect(result.migratedAssertions).toBeGreaterThanOrEqual(1);

    const self = await resolveSelfEntity(provider);
    expect(self?.name).toBe("Devon James");
    expect(self?.id).toBe(devon.id);

    const wrote = await writeConversationalMemory(
      provider,
      {
        entities: [{ name: "__user__", entityClass: "Person", birthDate: "--03-15" }],
        assertions: [
          {
            subjectName: "__user__",
            predicate: "hasBirthDate",
            objectName: "March 15",
            text: "User's birthday is March 15.",
          },
        ],
      },
      { userDisplayName: "ignored when self is set" },
    );
    expect(wrote.entityIds.__user__).toBe(devon.id);

    const rev = await provider.packages.readCurrent(devon.id.replace(/^did:memory:/, ""));
    expect(rev?.schema?.birthDate).toBe("--03-15");
    expect(rev?.alfred?.isSelf).toBe(true);
  });
});

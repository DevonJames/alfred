/**
 * Profile self-identity: which Person entity is "me" for conversational writes.
 * Stored as `alfred.isSelf` on the Entity revision.
 */

import type { OipLocalMemoryProvider } from "./oip-local/provider.js";

function asDid(id: string): string {
  return id.startsWith("did:memory:") ? id : `did:memory:${id}`;
}

function logicalOf(id: string): string {
  return id.replace(/^did:memory:/, "").split("#")[0]!;
}

export async function resolveSelfEntity(
  provider: OipLocalMemoryProvider,
): Promise<{ id: string; name: string } | null> {
  provider.sqlite.open();
  for (const row of provider.sqlite.listByType("Entity", 8000)) {
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev) continue;
    const alfred = (rev.alfred ?? {}) as Record<string, unknown>;
    if (alfred.isSelf === true) {
      const name =
        (typeof rev.schema?.name === "string" && rev.schema.name) ||
        row.name ||
        "User";
      if (name.startsWith("[superseded]")) continue;
      return { id: asDid(row.id), name };
    }
  }
  return null;
}

/** Prefer an explicit self, else env/display name, else a Person named exactly that. */
export async function resolveOrCreateSelfEntity(
  provider: OipLocalMemoryProvider,
  preferredName: string,
  now: string,
  upsertPerson: (
    name: string,
    summary: string | undefined,
    now: string,
  ) => Promise<string>,
): Promise<{ id: string; name: string }> {
  const existing = await resolveSelfEntity(provider);
  if (existing) return existing;

  const needle = preferredName.trim().toLowerCase();
  if (needle && needle !== "user") {
    const hits = provider.sqlite
      .findByName(preferredName, "Entity")
      .filter((r) => (r.name ?? "").toLowerCase() === needle)
      .filter((r) => (r.schema_type ?? "").includes("Person"));
    // Prefer a Person whose description marks them as the primary user
    for (const hit of hits) {
      const rev = await provider.packages.readCurrent(hit.logical_id);
      const desc = String(rev?.schema?.description ?? "");
      if (/primary user/i.test(desc)) {
        return { id: asDid(hit.id), name: hit.name ?? preferredName };
      }
    }
    if (hits[0]) {
      return { id: asDid(hits[0].id), name: hits[0].name ?? preferredName };
    }
  }

  const id = await upsertPerson(preferredName, "The user Alfred serves", now);
  return { id: asDid(id), name: preferredName };
}

export interface SetSelfPersonResult {
  selfId: string;
  selfName: string;
  clearedPrevious: number;
  migratedAssertions: number;
  supersededPlaceholder: boolean;
}

/**
 * Mark a Person entity as the profile self ("This is Me").
 * Retargets assertions that pointed at a previous self / generic "User" placeholder.
 */
export async function setSelfPerson(
  provider: OipLocalMemoryProvider,
  personId: string,
): Promise<SetSelfPersonResult> {
  await provider.packages.ensureRoot();
  provider.sqlite.open();

  const target = provider.sqlite.getRecord(personId);
  if (!target || target.record_type !== "Entity") {
    throw new Error(`Not an Entity: ${personId}`);
  }
  const targetRev = await provider.packages.readCurrent(target.logical_id);
  if (!targetRev) throw new Error(`Missing revision for ${personId}`);

  const schemaType = String(target.schema_type ?? targetRev.schemaType ?? "");
  const typeName = String(targetRev.schema?.["@type"] ?? "");
  if (!schemaType.includes("Person") && typeName.toLowerCase() !== "person") {
    throw new Error("Only Person entities can be marked as you");
  }

  const now = new Date().toISOString();
  const selfDid = asDid(target.id);
  const selfName =
    (typeof targetRev.schema?.name === "string" && targetRev.schema.name) ||
    target.name ||
    "User";

  let clearedPrevious = 0;
  const previousIds = new Set<string>();

  for (const row of provider.sqlite.listByType("Entity", 8000)) {
    if (row.logical_id === target.logical_id) continue;
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev) continue;
    const alfred = { ...((rev.alfred ?? {}) as Record<string, unknown>) };
    if (alfred.isSelf === true) {
      previousIds.add(asDid(row.id));
      alfred.isSelf = false;
      await provider.updateRecord(
        row.logical_id,
        { alfred, updatedAt: now },
        { reindex: false },
      );
      clearedPrevious += 1;
    }
  }

  // Generic conversational placeholder created when BRIEFING_USER_NAME was unset
  const placeholder = provider.sqlite
    .findByName("User", "Entity")
    .find(
      (r) =>
        (r.name ?? "").toLowerCase() === "user" &&
        (r.schema_type ?? "").includes("Person") &&
        r.logical_id !== target.logical_id,
    );
  if (placeholder) previousIds.add(asDid(placeholder.id));

  // Copy personal fields from placeholder/previous onto self when self is missing them
  for (const prevId of previousIds) {
    const prev = await provider.packages.readCurrent(logicalOf(prevId));
    if (!prev?.schema) continue;
    const schema = { ...(targetRev.schema ?? {}) } as Record<string, unknown>;
    let changed = false;
    for (const key of ["email", "telephone", "birthDate"] as const) {
      if (!schema[key] && typeof prev.schema[key] === "string") {
        schema[key] = prev.schema[key];
        changed = true;
      }
    }
    if (changed) {
      Object.assign(targetRev, { schema });
      await provider.updateRecord(
        target.logical_id,
        { schema, updatedAt: now },
        { reindex: false },
      );
    }
  }

  const alfred = {
    ...((targetRev.alfred ?? {}) as Record<string, unknown>),
    isSelf: true,
    entityClass: "Person",
  };
  await provider.updateRecord(
    target.logical_id,
    {
      alfred,
      updatedAt: now,
      provenance: {
        ...(targetRev.provenance ?? {}),
        sourceType: "graph_editor",
        extractionMethod: "set_self",
        learnedAt: now,
      },
    },
    { reindex: false },
  );

  let migratedAssertions = 0;
  for (const prevId of previousIds) {
    if (prevId === selfDid) continue;
    migratedAssertions += await migrateAssertionsToSelf(
      provider,
      prevId,
      selfDid,
      selfName,
      now,
    );
  }

  let supersededPlaceholder = false;
  if (placeholder) {
    const prev = await provider.packages.readCurrent(placeholder.logical_id);
    if (prev) {
      await provider.updateRecord(
        placeholder.logical_id,
        {
          name: "User",
          schema: {
            ...(prev.schema ?? {}),
            name: "User",
            description: `Superseded placeholder; self is now ${selfName} (${selfDid}).`,
          },
          alfred: {
            ...((prev.alfred ?? {}) as Record<string, unknown>),
            isSelf: false,
            supersededBy: selfDid,
          },
          updatedAt: now,
        },
        { reindex: false },
      );
      supersededPlaceholder = true;
    }
  }

  await provider.rebuildIndexes();

  return {
    selfId: selfDid,
    selfName,
    clearedPrevious,
    migratedAssertions,
    supersededPlaceholder,
  };
}

async function migrateAssertionsToSelf(
  provider: OipLocalMemoryProvider,
  fromDid: string,
  toDid: string,
  toName: string,
  now: string,
): Promise<number> {
  let migrated = 0;
  const fromLogical = logicalOf(fromDid);

  for (const row of provider.sqlite.listByType("Assertion", 8000)) {
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev) continue;
    const subject = rev.subject != null ? asDid(String(rev.subject)) : null;
    const object = rev.object != null ? asDid(String(rev.object)) : null;
    if (subject !== fromDid && object !== fromDid) continue;

    const nextSubject = subject === fromDid ? toDid : subject;
    const nextObject = object === fromDid ? toDid : object;

    // Skip if an equivalent assertion already exists on the real self
    if (nextSubject && nextObject && rev.predicate) {
      const dup = await findDuplicateAssertion(
        provider,
        nextSubject,
        String(rev.predicate),
        nextObject,
        row.logical_id,
      );
      if (dup) {
        // Drop the placeholder assertion by renaming it superseded
        await provider.updateRecord(
          row.logical_id,
          {
            name: row.name ?? "assertion",
            alfred: {
              ...((rev.alfred ?? {}) as Record<string, unknown>),
              supersededBy: dup,
            },
            updatedAt: now,
          },
          { reindex: false },
        );
        migrated += 1;
        continue;
      }
    }

    const pred = String(rev.predicate ?? "relatedTo");
    const assertionName = `${toName} ${pred}`;
    const text =
      typeof rev.text === "string"
        ? rev.text.replace(/\bUser\b/g, toName)
        : `${toName} ${pred}`;

    await provider.updateRecord(
      row.logical_id,
      {
        name: assertionName,
        text,
        subject: nextSubject ?? undefined,
        object: nextObject,
        drefs: {
          ...(rev.drefs ?? {}),
          ...(nextSubject ? { subject: nextSubject } : {}),
          ...(nextObject ? { object: nextObject } : {}),
        },
        schema: {
          ...(rev.schema ?? {}),
          "@type": "Statement",
          name: assertionName,
          text,
        },
        updatedAt: now,
        provenance: {
          ...(rev.provenance ?? {}),
          sourceType: "graph_editor",
          extractionMethod: "set_self_migrate",
          learnedAt: now,
          migratedFrom: fromLogical,
        },
      },
      { reindex: false },
    );
    migrated += 1;
  }

  return migrated;
}

async function findDuplicateAssertion(
  provider: OipLocalMemoryProvider,
  subjectDid: string,
  predicate: string,
  objectDid: string,
  excludeLogicalId: string,
): Promise<string | null> {
  for (const row of provider.sqlite.listByType("Assertion", 8000)) {
    if (row.logical_id === excludeLogicalId) continue;
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev?.predicate) continue;
    if (String(rev.predicate) !== predicate) continue;
    if (rev.subject != null && asDid(String(rev.subject)) !== subjectDid) continue;
    if (rev.object != null && asDid(String(rev.object)) !== objectDid) continue;
    return asDid(row.id);
  }
  return null;
}

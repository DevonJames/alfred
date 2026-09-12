/**
 * Query-time relationship recall: seed the profile self and walk employment /
 * supervisor / home / birthday edges so voice answers don't depend on the
 * utterance literally containing a person's name.
 */

import type { PackageStore } from "./package-store.js";
import type { MemoryRevision } from "./schemas.js";
import type { RecordRow, SqliteMemoryIndex } from "./indexes/sqlite-index.js";

export interface RelationshipRecallDeps {
  packages: PackageStore;
  sqlite: SqliteMemoryIndex;
}

export interface RelationshipHit {
  id: string;
  score: number;
  reason: string;
}

const EMPLOYER_RE =
  /\b(?:where\s+do\s+i\s+work|where\s+i\s+work|who\s+do\s+i\s+work\s+for|who\s+i\s+work\s+for|my\s+(?:current\s+)?(?:job|employer|workplace|company|office)|(?:currently\s+)?work(?:s|ing)?\s+(?:at|for)|what\s+(?:company|org(?:anization)?|office)\s+do\s+i\s+work)\b/i;

const SUPERVISOR_RE =
  /\b(?:my\s+)?(?:boss|supervisor|manager|direct\s+report(?:s)?\s+to|who\s+do\s+i\s+report\s+to|who\s+i\s+report\s+to|reports?\s+to)\b/i;

const SPOUSE_RE =
  /\b(?:my\s+)?(?:wife|husband|spouse|partner)\b/i;

const BIRTHDAY_RE =
  /\b(?:birthday|born\s+on|date\s+of\s+birth|how\s+old\s+(?:am\s+i|is))\b/i;

const CONTACT_RE =
  /\b(?:email|e-mail|phone|telephone|cell|mobile|contact(?:\s+(?:info|details|number|address))?)\b/i;

const COWORKER_INTERSECT_RE =
  /\b(?:work(?:s|ed|ing)?\s+with|coworker|colleague|teammate).{0,80}\b(?:live|lives|living|lives?\s+(?:at|in)|same\s+building|apartment)\b|\b(?:live|lives|living|apartment|building).{0,80}\b(?:work(?:s|ed|ing)?\s+(?:with|at|for)|coworker|colleague)\b/i;

const PRESENT_EMPLOYMENT = new Set(["worksAt", "employedBy", "hiredBy"]);
const PAST_EMPLOYMENT = new Set(["workedAt", "formerlyWorkedAt"]);
const SUPERVISOR_OUT = new Set(["reportsTo", "hasSupervisor"]);
const SUPERVISOR_IN = new Set(["supervisorOf", "manages", "bossOf"]);
const HOME_PREDICATES = new Set(["livesIn", "livesAt", "homeIs", "residesIn"]);
const COWORKER_PREDICATES = new Set(["worksWith", "colleagueOf", "teammateOf"]);

function asDid(id: string): string {
  return id.startsWith("did:memory:") ? id : `did:memory:${id}`;
}

function logicalOf(id: string): string {
  return id.replace(/^did:memory:/, "").split("#")[0]!;
}

function isSuperseded(rev: MemoryRevision | null | undefined): boolean {
  if (!rev) return true;
  const alfred = (rev.alfred ?? {}) as Record<string, unknown>;
  return Boolean(alfred.supersededBy);
}

export async function findSelfEntity(
  deps: RelationshipRecallDeps,
): Promise<{ id: string; name: string; row: RecordRow } | null> {
  deps.sqlite.open();
  for (const row of deps.sqlite.listByType("Entity", 8000)) {
    const rev = await deps.packages.readCurrent(row.logical_id);
    if (isSuperseded(rev)) continue;
    const alfred = (rev?.alfred ?? {}) as Record<string, unknown>;
    if (alfred.isSelf !== true) continue;
    const name =
      (typeof rev?.schema?.name === "string" && rev.schema.name) ||
      row.name ||
      "User";
    if (name.startsWith("[superseded]")) continue;
    return { id: asDid(row.id), name, row };
  }
  return null;
}

export function detectRelationshipIntents(text: string): {
  employer: boolean;
  supervisor: boolean;
  spouse: boolean;
  birthday: boolean;
  contact: boolean;
  coworkerIntersection: boolean;
  seedSelf: boolean;
} {
  const employer = EMPLOYER_RE.test(text);
  const supervisor = SUPERVISOR_RE.test(text);
  const spouse = SPOUSE_RE.test(text);
  const birthday = BIRTHDAY_RE.test(text);
  const contact = CONTACT_RE.test(text);
  const coworkerIntersection = COWORKER_INTERSECT_RE.test(text);
  const seedSelf =
    employer ||
    supervisor ||
    spouse ||
    birthday ||
    contact ||
    coworkerIntersection ||
    /\b(?:my|i|me|mine)\b/i.test(text);
  return {
    employer,
    supervisor,
    spouse,
    birthday,
    contact,
    coworkerIntersection,
    seedSelf,
  };
}

interface LinkedAssertion {
  assertionId: string;
  assertionLogicalId: string;
  predicate: string;
  otherId: string | null;
  otherName: string;
  otherType: string;
  updatedAt: string;
  learnedAt: string;
  role: "subject" | "object";
}

async function listLinkedAssertions(
  deps: RelationshipRecallDeps,
  entityDid: string,
): Promise<LinkedAssertion[]> {
  const out: LinkedAssertion[] = [];
  for (const e of deps.sqlite.edgesTo(entityDid)) {
    if (e.predicate !== "subject" && e.predicate !== "object") continue;
    const logicalId = logicalOf(e.source_id);
    const rev = await deps.packages.readCurrent(logicalId);
    if (!rev || rev.type !== "Assertion" || isSuperseded(rev) || !rev.predicate) continue;
    const otherRaw = e.predicate === "subject" ? rev.object : rev.subject;
    const otherId = otherRaw != null ? asDid(String(otherRaw)) : null;
    const other = otherId ? deps.sqlite.getRecord(otherId) : null;
    out.push({
      assertionId: asDid(e.source_id),
      assertionLogicalId: logicalId,
      predicate: String(rev.predicate),
      otherId,
      otherName: other?.name ?? "",
      otherType: other?.schema_type ?? "",
      updatedAt: rev.updatedAt ?? rev.learnedAt ?? "",
      learnedAt: rev.learnedAt ?? "",
      role: e.predicate,
    });
  }
  return out;
}

function extractProperPhrases(text: string): string[] {
  const phrases = new Set<string>();
  for (const m of text.matchAll(
    /\b([A-Z][A-Za-z0-9&]*(?:\s+(?:and|&|of|the|for)?\s*[A-Z][A-Za-z0-9&]*){0,4})\b/g,
  )) {
    const p = m[1]?.trim();
    if (!p || p.length < 2) continue;
    if (/^(Who|What|Where|When|Which|How|The|I|My|Me)$/i.test(p)) continue;
    phrases.add(p);
  }
  // USPTO-style all-caps tokens
  for (const m of text.matchAll(/\b([A-Z]{2,})\b/g)) {
    if (m[1]) phrases.add(m[1]);
  }
  return [...phrases];
}

function nameMatchesHint(name: string, hints: string[]): boolean {
  const n = name.toLowerCase();
  return hints.some((h) => {
    const hl = h.toLowerCase();
    return n === hl || n.includes(hl) || hl.includes(n);
  });
}

function isOrgType(schemaType: string): boolean {
  return /Organization/i.test(schemaType);
}

function isPlaceType(schemaType: string): boolean {
  return /Place/i.test(schemaType);
}

function isPersonType(schemaType: string): boolean {
  return /Person/i.test(schemaType);
}

function rankEmployment(a: LinkedAssertion): number {
  let score = 0;
  if (PRESENT_EMPLOYMENT.has(a.predicate)) score += 100;
  if (PAST_EMPLOYMENT.has(a.predicate)) score += 20;
  if (isOrgType(a.otherType)) score += 30;
  if (/Person/i.test(a.otherType) && !isOrgType(a.otherType)) score -= 40;
  // Prefer established org labels over conversational junk
  if (/^[A-Z]{2,}$/.test(a.otherName) || /\b(USPTO|Inc|LLC|Corp|Office|Agency)\b/i.test(a.otherName)) {
    score += 25;
  }
  if (/guy named|someone named|a person/i.test(a.otherName)) score -= 80;
  if (isJunkPersonLabel(a.otherName)) score -= 60;
  const t = Date.parse(a.updatedAt || a.learnedAt);
  if (Number.isFinite(t)) score += Math.min(40, Math.floor((t - Date.parse("2026-01-01")) / 86_400_000));
  return score;
}

function isJunkPersonLabel(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (/^(and|what|who|the|a|an)\b/i.test(n) && n.split(/\s+/).length <= 2) return true;
  if (/^(and what|what|who|someone|somebody)$/i.test(n)) return true;
  // STT fragments like "James Noss al"
  if (/\b[a-z]{1,2}\b/.test(n) && /[A-Z]/.test(n)) return true;
  return false;
}

function rankSupervisor(a: LinkedAssertion, deps?: RelationshipRecallDeps): number {
  let score = 50;
  if (!isJunkPersonLabel(a.otherName)) score += 40;
  // Prefer multi-token proper names (James Nosal > Nassol typos only when fuller)
  const parts = a.otherName.trim().split(/\s+/);
  if (parts.length >= 2) score += 20;
  if (parts.length === 1) score -= 5;
  // Prefer people with contact fields / richer records (canonical over STT typo)
  if (deps && a.otherId) {
    const row = deps.sqlite.getRecord(a.otherId);
    const search = `${row?.search_text ?? ""} ${row?.name ?? ""}`;
    if (/@/.test(search) || /email/i.test(search)) score += 35;
  }
  // Prefer earlier learned canonical edges over today's correction spam
  const t = Date.parse(a.learnedAt || a.updatedAt);
  if (Number.isFinite(t)) {
    score += Math.max(0, 15 - Math.floor((Date.now() - t) / (7 * 86_400_000)));
  }
  return score;
}

/**
 * Boost self-linked assertions/entities for relationship-shaped questions.
 */
export async function relationshipRecallHits(
  text: string,
  deps: RelationshipRecallDeps,
): Promise<RelationshipHit[]> {
  const intents = detectRelationshipIntents(text);
  if (!intents.seedSelf) return [];

  const self = await findSelfEntity(deps);
  if (!self) return [];

  const hits = new Map<string, RelationshipHit>();
  const bump = (id: string, score: number, reason: string) => {
    const key = asDid(id);
    const prev = hits.get(key);
    if (!prev || score > prev.score) hits.set(key, { id: key, score, reason });
  };

  bump(self.id, intents.employer || intents.supervisor || intents.birthday ? 1.2 : 0.85, "self");
  // Also bump Person schema birthDate when asking about birthdays
  if (intents.birthday) {
    const rev = await deps.packages.readCurrent(self.row.logical_id);
    if (typeof rev?.schema?.birthDate === "string" && rev.schema.birthDate) {
      bump(self.id, 1.35, "self-birthDate");
    }
  }

  const linked = await listLinkedAssertions(deps, self.id);

  if (intents.employer) {
    const employment = linked
      .filter((a) => PRESENT_EMPLOYMENT.has(a.predicate) || PAST_EMPLOYMENT.has(a.predicate))
      .sort((a, b) => rankEmployment(b) - rankEmployment(a));
    for (const [i, a] of employment.entries()) {
      if (/guy named|someone named/i.test(a.otherName)) continue;
      const boost = PRESENT_EMPLOYMENT.has(a.predicate) ? 1.45 - i * 0.08 : 0.65 - i * 0.04;
      if (boost < 0.45) break;
      bump(a.assertionId, boost, `employer:${a.predicate}`);
      if (a.otherId) bump(a.otherId, Math.max(0.4, boost - 0.05), `employer-org:${a.otherName}`);
    }
  }

  if (intents.supervisor) {
    const supervisors = linked
      .filter(
        (a) =>
          (SUPERVISOR_OUT.has(a.predicate) && a.role === "subject") ||
          (SUPERVISOR_IN.has(a.predicate) && a.role === "object"),
      )
      .sort((a, b) => rankSupervisor(b, deps) - rankSupervisor(a, deps));
    for (const [i, a] of supervisors.entries()) {
      if (isJunkPersonLabel(a.otherName) && i > 0) continue;
      const boost = 1.55 - i * 0.06;
      if (boost < 0.7) break;
      bump(a.assertionId, boost, `supervisor:${a.predicate}`);
      if (a.otherId) bump(a.otherId, boost - 0.05, `supervisor-person:${a.otherName}`);
    }
  }

  if (intents.contact) {
    await boostContactDetails(text, deps, linked, intents, bump);
  }

  if (intents.spouse) {
    for (const a of linked) {
      if (!/^(spouseOf|marriedTo|partnerOf|wifeOf|husbandOf)$/i.test(a.predicate)) continue;
      bump(a.assertionId, 1.4, `spouse:${a.predicate}`);
      if (a.otherId) bump(a.otherId, 1.35, `spouse-person:${a.otherName}`);
    }
  }

  if (intents.birthday) {
    for (const a of linked) {
      if (a.predicate !== "hasBirthDate") continue;
      bump(a.assertionId, 1.4, "hasBirthDate");
      if (a.otherId) bump(a.otherId, 1.2, `birth-label:${a.otherName}`);
    }
    // Named birthday: "Amy's birthday"
    const named = text.match(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*(?:'s|s')?\s+birthday\b|\b(?:birthday|born).{0,20}\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
    );
    const personName = named?.[1] || named?.[2];
    if (personName && !/^(My|His|Her|Their|Our)$/i.test(personName)) {
      for (const row of deps.sqlite.findByName(personName, "Entity")) {
        if (!/Person/i.test(row.schema_type ?? "")) continue;
        bump(row.id, 1.3, `birthday-person:${row.name}`);
        const personLinks = await listLinkedAssertions(deps, asDid(row.id));
        for (const a of personLinks) {
          if (a.predicate === "hasBirthDate") {
            bump(a.assertionId, 1.45, "named-hasBirthDate");
            if (a.otherId) bump(a.otherId, 1.2, `named-birth-label:${a.otherName}`);
          }
        }
        const rev = await deps.packages.readCurrent(row.logical_id);
        if (typeof rev?.schema?.birthDate === "string" && rev.schema.birthDate) {
          bump(row.id, 1.4, `named-birthDate:${rev.schema.birthDate}`);
        }
      }
    }
  }

  if (intents.coworkerIntersection) {
    const hints = extractProperPhrases(text);
    const selfOrgs = linked
      .filter((a) => PRESENT_EMPLOYMENT.has(a.predicate) && a.otherId)
      .map((a) => a);
    const selfPlaces = linked
      .filter((a) => HOME_PREDICATES.has(a.predicate) && a.otherId)
      .map((a) => a);

    const orgCandidates = [
      ...selfOrgs.filter((a) => !hints.length || nameMatchesHint(a.otherName, hints)),
      ...linked.filter(
        (a) =>
          PRESENT_EMPLOYMENT.has(a.predicate) &&
          a.otherId &&
          hints.some((h) => nameMatchesHint(a.otherName, [h])),
      ),
    ];
    // Also resolve org/place entities by name from the query even if self edge missing
    for (const hint of hints) {
      for (const row of deps.sqlite.findByName(hint, "Entity")) {
        if (isOrgType(row.schema_type ?? "")) {
          orgCandidates.push({
            assertionId: row.id,
            assertionLogicalId: row.logical_id,
            predicate: "worksAt",
            otherId: asDid(row.id),
            otherName: row.name ?? hint,
            otherType: row.schema_type ?? "",
            updatedAt: "",
            learnedAt: "",
            role: "subject",
          });
        }
        if (isPlaceType(row.schema_type ?? "") || /apartment|building|place/i.test(row.name ?? "")) {
          selfPlaces.push({
            assertionId: row.id,
            assertionLogicalId: row.logical_id,
            predicate: "livesIn",
            otherId: asDid(row.id),
            otherName: row.name ?? hint,
            otherType: row.schema_type ?? SCHEMA_PLACE_FALLBACK,
            updatedAt: "",
            learnedAt: "",
            role: "subject",
          });
        }
      }
    }

    const orgIds = uniqueIds(orgCandidates.map((a) => a.otherId).filter(Boolean) as string[]);
    const placeIds = uniqueIds(
      [
        ...selfPlaces.map((a) => a.otherId),
        ...hints.flatMap((h) =>
          deps.sqlite
            .findByName(h, "Entity")
            .filter((r) => isPlaceType(r.schema_type ?? "") || /apartment|building/i.test(r.name ?? ""))
            .map((r) => asDid(r.id)),
        ),
      ].filter(Boolean) as string[],
    );

    for (const orgId of orgIds) bump(orgId, 0.9, "intersect-org");
    for (const placeId of placeIds) bump(placeId, 0.9, "intersect-place");

    const peopleAtOrg = await peopleLinkedTo(deps, orgIds, PRESENT_EMPLOYMENT, "subject");
    const peopleAtPlace = await peopleLinkedTo(deps, placeIds, HOME_PREDICATES, "subject");
    const coworkers = new Set(
      linked
        .filter((a) => COWORKER_PREDICATES.has(a.predicate) && a.otherId)
        .map((a) => a.otherId as string),
    );
    const coworkerNames = new Set(
      linked
        .filter((a) => COWORKER_PREDICATES.has(a.predicate) && a.otherName)
        .map((a) => a.otherName.toLowerCase()),
    );

    // Match across duplicate Person nodes (same display name, different DIDs)
    const placeNames = new Set(
      [...peopleAtPlace.values()].map((m) => m.name.toLowerCase()).filter(Boolean),
    );

    for (const [personId, meta] of peopleAtOrg) {
      if (personId === self.id) continue;
      const nameKey = meta.name.toLowerCase();
      const atPlace =
        peopleAtPlace.has(personId) || (nameKey.length > 0 && placeNames.has(nameKey));
      const isCoworker =
        coworkers.has(personId) || (nameKey.length > 0 && coworkerNames.has(nameKey));
      if (placeIds.length > 0 && !atPlace) continue;
      if (placeIds.length === 0 && !isCoworker && orgIds.length === 0) continue;
      const score = atPlace && isCoworker ? 1.55 : atPlace ? 1.5 : isCoworker ? 1.2 : 1.05;
      bump(personId, score, `intersect-person:${meta.name}`);
      for (const aid of meta.assertionIds) bump(aid, score - 0.05, "intersect-assertion");
      // Also boost place-side duplicate Fred nodes + their edges
      for (const [placePersonId, placeMeta] of peopleAtPlace) {
        if (placePersonId === personId) continue;
        if (placeMeta.name.toLowerCase() !== nameKey) continue;
        bump(placePersonId, score - 0.02, `intersect-person-dup:${placeMeta.name}`);
        for (const aid of placeMeta.assertionIds) bump(aid, score - 0.08, "intersect-place-assertion");
      }
    }
  }

  // Light self-neighborhood for any first-person question
  if (intents.seedSelf && !intents.employer && !intents.supervisor && !intents.coworkerIntersection) {
    for (const a of linked.slice(0, 12)) {
      bump(a.assertionId, 0.55, `self-edge:${a.predicate}`);
      if (a.otherId) bump(a.otherId, 0.5, `self-neighbor:${a.otherName}`);
    }
  }

  return [...hits.values()];
}

const CONTACT_PREDICATES = new Set([
  "hasEmail",
  "hasPhone",
  "hasTelephone",
  "email",
  "telephone",
  "phoneNumber",
]);

async function boostContactDetails(
  text: string,
  deps: RelationshipRecallDeps,
  linked: LinkedAssertion[],
  intents: ReturnType<typeof detectRelationshipIntents>,
  bump: (id: string, score: number, reason: string) => void,
): Promise<void> {
  const wantEmail = /\b(?:email|e-mail)\b/i.test(text);
  const wantPhone = /\b(?:phone|telephone|cell|mobile|number)\b/i.test(text);

  const personIds = new Set<string>();

  // Role-resolved people (boss / spouse)
  if (intents.supervisor) {
    for (const a of linked) {
      if (
        (SUPERVISOR_OUT.has(a.predicate) && a.role === "subject" && a.otherId) ||
        (SUPERVISOR_IN.has(a.predicate) && a.role === "object" && a.otherId)
      ) {
        if (!isJunkPersonLabel(a.otherName)) personIds.add(a.otherId);
      }
    }
  }
  if (intents.spouse) {
    for (const a of linked) {
      if (/^(spouseOf|marriedTo|partnerOf|wifeOf|husbandOf)$/i.test(a.predicate) && a.otherId) {
        personIds.add(a.otherId);
      }
    }
  }

  // Named person in the query
  for (const phrase of extractProperPhrases(text)) {
    if (/^(Who|What|Where|When|My|Boss|Supervisor)$/i.test(phrase)) continue;
    for (const row of deps.sqlite.findByName(phrase, "Entity")) {
      if (!isPersonType(row.schema_type ?? "")) continue;
      personIds.add(asDid(row.id));
    }
  }

  // Self contact ("what's my phone number")
  if (/\b(?:my|mine)\b/i.test(text) && !intents.supervisor && !intents.spouse) {
    const self = await findSelfEntity(deps);
    if (self) personIds.add(self.id);
  }

  for (const personId of personIds) {
    const row = deps.sqlite.getRecord(personId);
    if (!row) continue;
    const rev = await deps.packages.readCurrent(row.logical_id);
    if (isSuperseded(rev)) continue;
    const email = typeof rev?.schema?.email === "string" ? rev.schema.email.trim() : "";
    const telephone =
      typeof rev?.schema?.telephone === "string" ? rev.schema.telephone.trim() : "";
    const hasWanted =
      (wantEmail && email) ||
      (wantPhone && telephone) ||
      ((!wantEmail && !wantPhone) && (email || telephone));
    // Prefer the Person record itself — schema fields are the source of truth in the UI
    bump(personId, hasWanted ? 1.65 : 1.25, `contact-person:${row.name}`);

    const personLinks = await listLinkedAssertions(deps, personId);
    for (const a of personLinks) {
      if (!CONTACT_PREDICATES.has(a.predicate)) continue;
      const emailish = /email/i.test(a.predicate);
      const phoneish = /phone|tel/i.test(a.predicate);
      if (wantEmail && !emailish && !wantPhone) continue;
      if (wantPhone && !phoneish && !wantEmail) continue;
      bump(a.assertionId, 1.55, `contact-edge:${a.predicate}`);
      if (a.otherId) bump(a.otherId, 1.35, `contact-value:${a.otherName}`);
    }
  }
}

const SCHEMA_PLACE_FALLBACK = "https://schema.org/Place";

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map(asDid))];
}

async function peopleLinkedTo(
  deps: RelationshipRecallDeps,
  targetIds: string[],
  predicates: Set<string>,
  personRole: "subject" | "object",
): Promise<Map<string, { name: string; assertionIds: string[] }>> {
  const people = new Map<string, { name: string; assertionIds: string[] }>();
  for (const targetId of targetIds) {
    for (const e of deps.sqlite.edgesTo(targetId)) {
      if (e.predicate !== "subject" && e.predicate !== "object") continue;
      // Assertion --object--> Org/Place when person is subject
      if (personRole === "subject" && e.predicate !== "object") continue;
      if (personRole === "object" && e.predicate !== "subject") continue;
      const logicalId = logicalOf(e.source_id);
      const rev = await deps.packages.readCurrent(logicalId);
      if (!rev || isSuperseded(rev) || !rev.predicate) continue;
      if (!predicates.has(String(rev.predicate))) continue;
      const personRaw = personRole === "subject" ? rev.subject : rev.object;
      if (personRaw == null) continue;
      const personId = asDid(String(personRaw));
      const person = deps.sqlite.getRecord(personId);
      if (!person || !isPersonType(person.schema_type ?? "")) continue;
      const cur = people.get(personId) ?? { name: person.name ?? "", assertionIds: [] };
      cur.assertionIds.push(asDid(e.source_id));
      people.set(personId, cur);
    }
  }
  return people;
}

/** Resolve a memory DID to a display name when possible. */
export function resolveRecordName(
  sqlite: SqliteMemoryIndex,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  const row = sqlite.getRecord(asDid(id));
  if (!row?.name || row.name.startsWith("[superseded]")) return null;
  return row.name;
}

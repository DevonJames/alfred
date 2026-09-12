/**
 * Structured conversational memory writes — Entity / Assertion like knowledge ingest.
 * Used by OIP commitTurn heuristics and the remember_memory voice tool.
 */

import type { OipLocalMemoryProvider } from "./oip-local/provider.js";
import { SCHEMA_ORG, schemaOrgPerson } from "./oip-local/schema-org.js";
import { resolveSelfEntity } from "./self-identity.js";

/** Short org tokens that STT often lowercases; keep as acronyms. */
const ORG_ACRONYMS = new Set([
  "uspto",
  "nasa",
  "ibm",
  "opm",
  "fbi",
  "cia",
  "nsa",
  "irs",
  "doj",
  "dod",
  "va",
  "epa",
  "fda",
  "nih",
  "nsf",
  "sec",
  "ftc",
  "fcc",
  "mit",
  "cmu",
  "nyu",
  "ucla",
  "usc",
]);

const ORG_STOP_TRAIL =
  /\s+(?:as|and|but|where|because|since|starting|from|now|currently|today|recently|again|which|that|who|whom|whose|is|are|was|were|i|i'd|i'm|please|remember|don't|dont|can|could|would|just|also|so|okay|ok)\b.*$/i;

const FALSE_ORG =
  /^(a|an|the|my|his|her|their|our|your|work|job|company|office|place|home|there|here|them|him|her|want|remember|person|someone|people)$/i;

export interface ConversationalEntitySpec {
  name: string;
  entityClass?: string;
  summary?: string;
  /** schema.org Person.email */
  email?: string;
  /** schema.org Person.telephone */
  telephone?: string;
  /**
   * schema.org Person.birthDate — ISO `YYYY-MM-DD` or month-day `--MM-DD`
   * when the year is unknown.
   */
  birthDate?: string;
}

export interface ConversationalAssertionSpec {
  subjectName: string;
  predicate: string;
  objectName: string;
  text?: string;
}

export interface ConversationalMemoryWrite {
  entities?: ConversationalEntitySpec[];
  assertions?: ConversationalAssertionSpec[];
  /** Free-text durable note stored as Observation (not a turn transcript). */
  notes?: string[];
}

export interface ConversationalMemoryWriteResult {
  entitiesUpserted: number;
  assertionsCreated: number;
  notesCreated: number;
  entityIds: Record<string, string>;
}

const FALSE_PERSON =
  /^(a|an|the|my|his|her|their|our|your|boss|boss'?s|supervisor|manager|coworker|colleague|teammate|friend|wife|husband|son|daughter|mom|dad|alfred|albert|email|phone|number|person|someone|somebody|anybody|people|guy|gal|folks|that|who|whom|named|specialist|recruiter|at|for|from|to|in|on|of|is|are|was|were)$/i;

const WORKPLACE_ROLE =
  /^(boss|supervisor|manager|coworker|colleague|teammate|co-worker)$/i;

/** Generic subjects that look like "Person That works at…" from STT. */
const PLACEHOLDER_PERSON =
  /^(person|someone|somebody|anybody|people|guy|gal|folks)(?:\s+(?:that|who|whom))?$/i;

/** Workplace contact roles beyond boss/manager. */
const WORKPLACE_CONTACT_ROLE =
  /hr\s*specialist|hr\s*contact|hr\s*rep(?:resentative)?|human\s*resources|recruiter|onboarding(?:\s+contact)?|new\s*hire\s*poc|poc|point\s+of\s+contact|hiring\s+manager/i;

function cleanPersonName(raw: string): string {
  return titleCaseName(
    cleanPhrase(raw)
      .replace(/['’]s$/i, "")
      .replace(/s'$/i, ""),
  );
}

function isPlausiblePersonName(name: string): boolean {
  if (!name || name.length < 2) return false;
  if (FALSE_PERSON.test(name)) return false;
  if (PLACEHOLDER_PERSON.test(name)) return false;
  if (ORG_ACRONYMS.has(name.toLowerCase())) return false;
  const parts = name.split(/\s+/);
  if (parts.some((p) => FALSE_PERSON.test(p))) return false;
  // "Person That", "Someone Who", "Pratt Who"
  if (parts.length >= 2 && /^(that|who|whom|which)$/i.test(parts[parts.length - 1]!)) {
    return false;
  }
  return true;
}

function cleanOrgName(raw: string): string {
  const cleaned = cleanPhrase(raw)
    .replace(/^the\s+/i, "")
    // Speech often continues after the org: "USPTO. I want you to remember"
    .replace(/\.\s+.*$/s, "")
    // "USPTO is my HR specialist" — stop before role appositive
    .replace(/\s+is\s+my\b.*$/i, "")
    .replace(/[.!?,;:]+$/g, "")
    .replace(ORG_STOP_TRAIL, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      if (/^[A-Z0-9]{2,}(?:&[A-Z0-9]+)*$/.test(w)) return w;
      const lower = w.toLowerCase();
      if (ORG_ACRONYMS.has(lower)) return w.toUpperCase();
      if (/^(and|&|of|the|for|at)$/i.test(w)) return lower === "&" ? "&" : lower;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

function isPlausibleOrgName(name: string): boolean {
  if (!name || name.length < 2) return false;
  if (FALSE_ORG.test(name)) return false;
  if (FALSE_PERSON.test(name) && !ORG_ACRONYMS.has(name.toLowerCase())) return false;
  return true;
}

/** Heuristic extraction for common durable people/relations from a user utterance. */
export function extractConversationalMemory(text: string): ConversationalMemoryWrite {
  const t = text.trim();
  if (!t) return {};
  const entities: ConversationalEntitySpec[] = [];
  const assertions: ConversationalAssertionSpec[] = [];
  const notes: string[] = [];
  const seenPeople = new Set<string>();

  const addPerson = (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => {
    const name = cleanPersonName(raw);
    if (!isPlausiblePersonName(name)) return null;
    const key = name.toLowerCase();
    const existing = entities.find((e) => e.name.toLowerCase() === key);
    if (existing) {
      if (summary && !existing.summary) existing.summary = summary;
      if (contact?.email) existing.email = contact.email;
      if (contact?.telephone) existing.telephone = contact.telephone;
      return existing.name;
    }
    seenPeople.add(key);
    entities.push({
      name,
      entityClass: "Person",
      summary,
      email: contact?.email,
      telephone: contact?.telephone,
    });
    return name;
  };

  const addOrganization = (raw: string, summary?: string) => {
    const name = cleanOrgName(raw);
    if (!isPlausibleOrgName(name)) return null;
    const key = name.toLowerCase();
    const existing = entities.find((e) => e.name.toLowerCase() === key);
    if (existing) {
      if (!existing.entityClass) existing.entityClass = "Organization";
      if (summary && !existing.summary) existing.summary = summary;
      return existing.name;
    }
    entities.push({
      name,
      entityClass: "Organization",
      summary,
    });
    return name;
  };

  /** Protocols / products / projects (not orgs) — e.g. Open Index Protocol. */
  const addWork = (raw: string, summary?: string) => {
    const name = cleanOrgName(raw);
    if (!name || name.length < 2) return null;
    if (FALSE_ORG.test(name)) return null;
    const key = name.toLowerCase();
    const existing = entities.find((e) => e.name.toLowerCase() === key);
    if (existing) {
      if (
        !existing.entityClass ||
        existing.entityClass === "Person" ||
        existing.entityClass === "Organization"
      ) {
        // Prefer Thing when this name is used as an invented work
        if (existing.entityClass !== "Organization") existing.entityClass = "Thing";
      }
      if (summary && !existing.summary) existing.summary = summary;
      return existing.name;
    }
    entities.push({
      name,
      entityClass: "Thing",
      summary,
    });
    return name;
  };

  // "my name is Devon James"
  const nameMatch = t.match(
    /\bmy name is\s+([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)/i,
  );
  if (nameMatch?.[1]) {
    addPerson(nameMatch[1], "The user");
  }
  // "my boss/supervisor/manager is James Nosal" OR "James Nosal is my boss"
  // STT often lowercases names — titleCase after match.
  const bossAsObject = t.match(
    /\bmy\s+(boss|supervisor|manager)\s+(?:is\s+|named\s+)?([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)/i,
  );
  const bossAsSubject = t.match(
    /\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s+is\s+my\s+(boss|supervisor|manager)\b/i,
  );
  if (bossAsObject || bossAsSubject) {
    const roleWord = (bossAsObject?.[1] ?? bossAsSubject?.[2] ?? "boss").toLowerCase();
    const nameRaw = bossAsObject?.[2] ?? bossAsSubject?.[1] ?? "";
    const person = addPerson(nameRaw, `User's ${roleWord}`);
    if (person) {
      assertions.push({
        subjectName: person,
        predicate: "supervisorOf",
        objectName: "__user__",
        text: `${person} is the user's ${roleWord}.`,
      });
      assertions.push({
        subjectName: "__user__",
        predicate: "reportsTo",
        objectName: person,
        text: `User reports to ${person}.`,
      });
    }
  }

  // "my wife/husband/spouse is Amy" / "My wife, Amy James, is …"
  const spouse =
    t.match(
      /\bmy\s+(wife|husband|spouse|partner)\s*,?\s+(?:is\s+|named\s+)?([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)/i,
    ) ??
    t.match(
      /\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s+is\s+my\s+(wife|husband|spouse|partner)\b/i,
    );
  if (spouse) {
    const firstIsRole = /^(wife|husband|spouse|partner)$/i.test(spouse[1]!);
    const nameRaw = firstIsRole ? spouse[2]! : spouse[1]!;
    const roleWord = firstIsRole ? spouse[1]! : spouse[2]!;
    const person = addPerson(nameRaw, `User's ${roleWord.toLowerCase()}`);
    if (person) {
      assertions.push({
        subjectName: "__user__",
        predicate: "spouseOf",
        objectName: person,
        text: `${person} is the user's ${roleWord.toLowerCase()}.`,
      });
    }
  }

  // "my son/daughter is Matty"
  const child =
    t.match(
      /\bmy\s+(son|daughter|kid|child)\s+(?:is\s+|named\s+)?([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)/i,
    ) ??
    t.match(
      /\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s+is\s+my\s+(son|daughter|kid|child)\b/i,
    );
  if (child) {
    const firstIsRole = /^(son|daughter|kid|child)$/i.test(child[1]!);
    const nameRaw = firstIsRole ? child[2]! : child[1]!;
    const roleWord = firstIsRole ? child[1]! : child[2]!;
    const person = addPerson(nameRaw, `User's ${roleWord.toLowerCase()}`);
    if (person) {
      assertions.push({
        subjectName: "__user__",
        predicate: "parentOf",
        objectName: person,
        text: `${person} is the user's ${roleWord.toLowerCase()}.`,
      });
    }
  }

  // Employer / organization: "I work for USPTO", "I now work at Google", etc.
  extractOrganizations(t, addOrganization, assertions);

  // "my boss is James Nosal at USPTO" / "James Nosal at the USPTO is my supervisor"
  extractBossAtOrganization(t, addPerson, addOrganization, assertions);

  // Coworkers / teammates / "I work with …"
  extractCoworkers(t, addPerson, addOrganization, assertions);

  // HR specialist / recruiter / POC role people (before generic worksAt — avoids "person that works at…")
  extractWorkplaceRoleContacts(t, addPerson, addOrganization, assertions);

  // "Sarah also works at USPTO" + hierarchy trails
  // ("…works for OPM, the department of … that runs Tech Force which hired me")
  extractPersonWorksAt(t, addPerson, addOrganization, assertions);

  // "Her name is Regina Anderson" when a workplace role was just mentioned
  extractDeferredPersonName(t, addPerson, entities, assertions);

  // Standalone org↔org structure ("OPM runs Tech Force", "Tech Force is a program of OPM")
  extractOrgStructure(t, addOrganization, assertions);

  // "Amy is also the co-inventor of Open Index Protocol"
  extractInvention(t, addPerson, addWork, assertions);

  // "I was hired by Tech Force"
  extractHiredBy(t, addOrganization, assertions);

  // Anyone workplace-related this turn shares the user's employer worksAt.
  linkWorkplacePeopleToEmployer(assertions);

  // Explicit "remember that …" as a durable observation note
  const rememberMatch = t.match(
    /\b(?:remember that|don't forget(?: that)?|keep in mind(?: that)?|note that|for the record)\s+(.+?)(?:[.!?]|$)/i,
  );
  if (rememberMatch?.[1]) {
    const note = cleanPhrase(rememberMatch[1]);
    if (note.length >= 4) notes.push(note.endsWith(".") ? note : `${note}.`);
  }

  // Contact details: email / phone attached to a named person (or role like "my boss")
  extractContactDetails(t, addPerson, entities);

  // Birthday / born-on → Person.birthDate + hasBirthDate graph edge
  extractPersonalDetails(t, addPerson, addWork, entities, assertions);

  return { entities, assertions, notes };
}

/** Capture an organization name after employment phrasing (no periods — STT trails). */
const ORG_NAME_CAPTURE =
  /([A-Za-z][\w&]*(?:\s+(?:and|&|of|the|for)\s+[A-Za-z][\w&]*|\s+(?!that\b|which\b|who\b|whom\b|whose\b)[A-Za-z][\w&]*){0,5})/;

function pushWorksAt(
  assertions: ConversationalAssertionSpec[],
  subjectName: string,
  org: string,
  text?: string,
): void {
  if (
    assertions.some(
      (a) =>
        a.predicate === "worksAt" &&
        a.subjectName.toLowerCase() === subjectName.toLowerCase() &&
        a.objectName.toLowerCase() === org.toLowerCase(),
    )
  ) {
    return;
  }
  assertions.push({
    subjectName,
    predicate: "worksAt",
    objectName: org,
    text: text ?? `${subjectName === "__user__" ? "User" : subjectName} works at ${org}.`,
  });
}

/** Collect people tied to the user's workplace (bosses + coworkers). */
function workplaceColleagueNames(assertions: ConversationalAssertionSpec[]): Set<string> {
  const people = new Set<string>();
  for (const a of assertions) {
    if (a.predicate === "reportsTo" && a.subjectName === "__user__") people.add(a.objectName);
    if (a.predicate === "supervisorOf" && a.objectName === "__user__") people.add(a.subjectName);
    if (a.predicate === "worksWith" && a.subjectName === "__user__") people.add(a.objectName);
    if (a.predicate === "worksWith" && a.objectName === "__user__") people.add(a.subjectName);
    if (a.predicate === "colleagueOf" && a.subjectName === "__user__") people.add(a.objectName);
    if (a.predicate === "colleagueOf" && a.objectName === "__user__") people.add(a.subjectName);
  }
  return people;
}

/** When user works at Org, workplace colleagues also get worksAt Org. */
function linkWorkplacePeopleToEmployer(assertions: ConversationalAssertionSpec[]): void {
  const orgs = assertions
    .filter((a) => a.predicate === "worksAt" && a.subjectName === "__user__")
    .map((a) => a.objectName);
  const colleagues = workplaceColleagueNames(assertions);
  for (const org of orgs) {
    for (const person of colleagues) {
      pushWorksAt(assertions, person, org, `${person} works at ${org}.`);
    }
  }
}

function pushWorksWith(
  assertions: ConversationalAssertionSpec[],
  person: string,
  text?: string,
): void {
  if (
    assertions.some(
      (a) =>
        a.predicate === "worksWith" &&
        ((a.subjectName === "__user__" && a.objectName === person) ||
          (a.subjectName === person && a.objectName === "__user__")),
    )
  ) {
    return;
  }
  assertions.push({
    subjectName: "__user__",
    predicate: "worksWith",
    objectName: person,
    text: text ?? `User works with ${person}.`,
  });
  assertions.push({
    subjectName: person,
    predicate: "colleagueOf",
    objectName: "__user__",
    text: `${person} is a colleague of the user.`,
  });
}

/** "I work with Sarah" / "my coworker is Sarah" / "Sarah is my teammate at USPTO" */
function extractCoworkers(
  t: string,
  addPerson: (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => string | null,
  addOrganization: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): void {
  const role = "coworker|colleague|teammate|co-worker";
  const person = String.raw`([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)`;
  const patterns: Array<{ re: RegExp; nameIdx: number; orgIdx?: number; roleIdx?: number }> = [
    // my coworker/colleague/teammate is Sarah Chen [at USPTO]
    {
      re: new RegExp(
        String.raw`\bmy\s+(?:${role})\s+(?:is\s+|named\s+)?${person}(?:\s+at\s+(?:the\s+)?${ORG_NAME_CAPTURE.source})?`,
        "i",
      ),
      nameIdx: 1,
      orgIdx: 2,
    },
    // Sarah Chen is my coworker/colleague [at USPTO]
    {
      re: new RegExp(
        String.raw`\b${person}\s+is\s+my\s+(?:${role})(?:\s+at\s+(?:the\s+)?${ORG_NAME_CAPTURE.source})?`,
        "i",
      ),
      nameIdx: 1,
      orgIdx: 2,
    },
    // I work with Sarah Chen [at USPTO]
    {
      re: new RegExp(
        String.raw`\bi\s+work\s+with\s+${person}(?:\s+at\s+(?:the\s+)?${ORG_NAME_CAPTURE.source})?`,
        "i",
      ),
      nameIdx: 1,
      orgIdx: 2,
    },
    // Sarah Chen works with me [at USPTO]
    {
      re: new RegExp(
        String.raw`\b${person}\s+works\s+with\s+me(?:\s+at\s+(?:the\s+)?${ORG_NAME_CAPTURE.source})?`,
        "i",
      ),
      nameIdx: 1,
      orgIdx: 2,
    },
  ];

  for (const { re, nameIdx, orgIdx } of patterns) {
    const m = t.match(re);
    if (!m?.[nameIdx]) continue;
    if (WORKPLACE_ROLE.test(m[nameIdx]!)) continue;
    const personName = addPerson(m[nameIdx]!, "User's coworker");
    if (!personName) continue;
    pushWorksWith(assertions, personName);
    if (orgIdx != null && m[orgIdx]) {
      const org = addOrganization(m[orgIdx], "User's employer");
      if (org) {
        pushWorksAt(assertions, "__user__", org);
        pushWorksAt(assertions, personName, org);
      }
    }
    return;
  }
}

function pushOrgRelation(
  assertions: ConversationalAssertionSpec[],
  subjectName: string,
  predicate: string,
  objectName: string,
  text?: string,
): void {
  if (
    assertions.some(
      (a) =>
        a.predicate === predicate &&
        a.subjectName.toLowerCase() === subjectName.toLowerCase() &&
        a.objectName.toLowerCase() === objectName.toLowerCase(),
    )
  ) {
    return;
  }
  assertions.push({
    subjectName,
    predicate,
    objectName,
    text: text ?? `${subjectName} ${predicate} ${objectName}.`,
  });
}

const ORG_UNIT_WORD =
  "department|agency|office|bureau|division|program|arm|subsidiary|unit|branch|administration|service";

/**
 * Parse appositive / relative-clause org hierarchy after an anchor org, e.g.
 * ", the department of the federal government that runs Tech Force which hired me"
 */
function parseOrgHierarchyTrail(
  anchorOrg: string,
  trail: string,
  addOrganization: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): string {
  if (!trail?.trim()) return anchorOrg;
  let focus = anchorOrg;
  let lastChild = anchorOrg;

  const deptOf = new RegExp(
    String.raw`(?:(?:a|an|the)\s+)?(?:${ORG_UNIT_WORD})\s+of\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
    "i",
  );
  const deptMatch = trail.match(deptOf);
  if (deptMatch?.[1]) {
    const parent = addOrganization(deptMatch[1], "Parent organization");
    if (parent) {
      pushOrgRelation(
        assertions,
        focus,
        "partOf",
        parent,
        `${focus} is part of ${parent}.`,
      );
    }
  }

  const runsRe = new RegExp(
    String.raw`(?:that|which|who)\s+(?:runs|operates|manages|oversees|sponsors|hosts)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
    "gi",
  );
  let runsMatch: RegExpExecArray | null;
  while ((runsMatch = runsRe.exec(trail)) !== null) {
    const child = addOrganization(runsMatch[1]!, "Program or organization");
    if (!child) continue;
    pushOrgRelation(assertions, focus, "runs", child, `${focus} runs ${child}.`);
    pushOrgRelation(
      assertions,
      child,
      "partOf",
      focus,
      `${child} is part of ${focus}.`,
    );
    lastChild = child;
    // Nested "runs X that runs Y" — next runs clause focuses on the child
    focus = child;
  }

  // "Tech Force, a program of OPM" style inside the trail
  const programOf = new RegExp(
    String.raw`${ORG_NAME_CAPTURE.source}\s*,?\s*(?:(?:a|an|the)\s+)?(?:${ORG_UNIT_WORD})\s+of\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
    "i",
  );
  const programMatch = trail.match(programOf);
  if (programMatch?.[1] && programMatch[2]) {
    const child = addOrganization(programMatch[1], "Program or organization");
    const parent = addOrganization(programMatch[2], "Parent organization");
    if (child && parent) {
      pushOrgRelation(assertions, child, "partOf", parent, `${child} is part of ${parent}.`);
      lastChild = child;
    }
  }

  if (/\b(?:that|which|who)\s+hired\s+me\b/i.test(trail) || /\bhired\s+me\b/i.test(trail)) {
    pushWorksAt(assertions, "__user__", lastChild, `User was hired by ${lastChild}.`);
  }

  return lastChild;
}

/** Standalone org structure: "OPM runs Tech Force", "Tech Force is a program of OPM" */
function extractOrgStructure(
  t: string,
  addOrganization: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): void {
  const runs = new RegExp(
    String.raw`\b${ORG_NAME_CAPTURE.source}\s+(?:runs|operates|manages|oversees|sponsors)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
    "i",
  );
  const runsMatch = t.match(runs);
  if (runsMatch?.[1] && runsMatch[2] && !/^(i|he|she|they|who|that|which)$/i.test(runsMatch[1])) {
    const parent = addOrganization(runsMatch[1], "Parent organization");
    const child = addOrganization(runsMatch[2], "Program or organization");
    if (parent && child) {
      pushOrgRelation(assertions, parent, "runs", child, `${parent} runs ${child}.`);
      pushOrgRelation(assertions, child, "partOf", parent, `${child} is part of ${parent}.`);
    }
  }

  const partOf = new RegExp(
    String.raw`\b${ORG_NAME_CAPTURE.source}\s+is\s+(?:(?:a|an|the)\s+)?(?:${ORG_UNIT_WORD}|part)\s+of\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
    "i",
  );
  const partMatch = t.match(partOf);
  if (partMatch?.[1] && partMatch[2]) {
    const child = addOrganization(partMatch[1], "Program or organization");
    const parent = addOrganization(partMatch[2], "Parent organization");
    if (child && parent) {
      pushOrgRelation(assertions, child, "partOf", parent, `${child} is part of ${parent}.`);
    }
  }
}

function extractHiredBy(
  t: string,
  addOrganization: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): void {
  const re = new RegExp(
    String.raw`\bi\s+(?:was\s+|got\s+|was\s+just\s+)?hired\s+(?:by|through|via)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
    "i",
  );
  const m = t.match(re);
  if (!m?.[1]) return;
  const org = addOrganization(m[1], "User's employer");
  if (org) pushWorksAt(assertions, "__user__", org, `User was hired by ${org}.`);
}

function normalizeWorkplaceRoleLabel(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (/hr|human\s*resources/i.test(t)) return "HR specialist";
  if (/recruiter/i.test(t)) return "recruiter";
  if (/onboarding/i.test(t)) return "onboarding contact";
  if (/poc|point\s+of\s+contact|new\s*hire/i.test(t)) return "point of contact";
  if (/hiring\s+manager/i.test(t)) return "hiring manager";
  return t;
}

function pushWorkplaceRole(
  assertions: ConversationalAssertionSpec[],
  person: string,
  roleLabel: string,
): void {
  if (
    assertions.some(
      (a) =>
        a.predicate === "workplaceRole" &&
        a.subjectName === person &&
        a.objectName === "__user__",
    )
  ) {
    return;
  }
  assertions.push({
    subjectName: person,
    predicate: "workplaceRole",
    objectName: "__user__",
    text: `${person} is the user's ${roleLabel}.`,
  });
  // Soft colleague link so employer sharing applies
  pushWorksWith(assertions, person, `User works with ${person} (${roleLabel}).`);
}

/**
 * "my HR specialist is Regina Anderson"
 * "Regina Anderson is my HR specialist at USPTO"
 * "another person that works at USPTO is my HR specialist"
 * (name may arrive in a follow-up "her name is …")
 */
function extractWorkplaceRoleContacts(
  t: string,
  addPerson: (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => string | null,
  addOrganization: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): void {
  const role = String.raw`((?:HR\s*specialist|HR\s*contact|HR\s*rep(?:resentative)?|human\s*resources(?:\s*specialist)?|recruiter|onboarding(?:\s+contact)?|new\s*hire\s*poc|point\s+of\s+contact|hiring\s+manager|POC))`;
  const person = String.raw`([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)`;
  const patterns: Array<{
    re: RegExp;
    nameIdx: number;
    roleIdx: number;
    orgIdx?: number;
  }> = [
    // my HR specialist is named Regina Anderson [at USPTO]
    {
      re: new RegExp(
        String.raw`\bmy\s+${role}\s+(?:is\s+named\s+|named\s+|is\s+)${person}(?:\s+at\s+(?:the\s+)?${ORG_NAME_CAPTURE.source})?`,
        "i",
      ),
      roleIdx: 1,
      nameIdx: 2,
      orgIdx: 3,
    },
    // Regina Anderson is my HR specialist [at USPTO]
    {
      re: new RegExp(
        String.raw`\b${person}\s+is\s+my\s+${role}(?:\s+at\s+(?:the\s+)?${ORG_NAME_CAPTURE.source})?`,
        "i",
      ),
      nameIdx: 1,
      roleIdx: 2,
      orgIdx: 3,
    },
    // That's my HR specialist, Regina Anderson
    {
      re: new RegExp(
        String.raw`\b(?:that(?:'s|\s+is)\s+)?my\s+${role}\s*[,:-]\s*${person}`,
        "i",
      ),
      roleIdx: 1,
      nameIdx: 2,
    },
  ];

  for (const { re, nameIdx, roleIdx, orgIdx } of patterns) {
    const m = t.match(re);
    if (!m?.[nameIdx] || !m[roleIdx]) continue;
    if (PLACEHOLDER_PERSON.test(m[nameIdx]) || WORKPLACE_ROLE.test(m[nameIdx])) continue;
    // Avoid matching "at USPTO is my HR specialist"
    if (/^(at|for|from|to|in|on)\b/i.test(m[nameIdx])) continue;
    const roleLabel = normalizeWorkplaceRoleLabel(m[roleIdx]);
    const personName = addPerson(m[nameIdx], `User's ${roleLabel}`);
    if (!personName) continue;
    pushWorkplaceRole(assertions, personName, roleLabel);
    if (orgIdx != null && m[orgIdx]) {
      const org = addOrganization(m[orgIdx], "User's employer");
      if (org) {
        pushWorksAt(assertions, "__user__", org);
        pushWorksAt(assertions, personName, org);
      }
    }
    // Same utterance: "…works at USPTO is my HR specialist"
    const worksAtOrg = t.match(
      new RegExp(
        String.raw`\bworks?\s+(?:at|for)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}\s+is\s+my\s+`,
        "i",
      ),
    );
    if (worksAtOrg?.[1]) {
      const org = addOrganization(worksAtOrg[1], "User's employer");
      if (org) {
        pushWorksAt(assertions, "__user__", org);
        pushWorksAt(assertions, personName, org);
      }
    }
    return;
  }

  // Role mentioned with employer but name deferred ("…is my HR specialist. Her name is…")
  if (
    new RegExp(String.raw`\bis\s+my\s+${role}\b`, "i").test(t) ||
    new RegExp(String.raw`\bmy\s+${role}\b`, "i").test(t)
  ) {
    const worksAtOrg = t.match(
      new RegExp(
        String.raw`\bworks?\s+(?:at|for)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    );
    if (worksAtOrg?.[1]) {
      const org = addOrganization(worksAtOrg[1], "User's employer");
      if (org) pushWorksAt(assertions, "__user__", org);
    }
    // Placeholder role entity for "her name is" / contact follow-up
    addPerson("__role:hr__", "User's HR specialist");
  }
}

/** "Her name is Regina Anderson" / "His name is James" after a role mention. */
function extractDeferredPersonName(
  t: string,
  addPerson: (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => string | null,
  entities: ConversationalEntitySpec[],
  assertions: ConversationalAssertionSpec[],
): void {
  const m = t.match(
    /\b(?:her|his|their)\s+name\s+is\s+([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)/i,
  );
  if (!m?.[1]) return;
  const personName = addPerson(m[1], undefined);
  if (!personName) return;

  const roleEnt = entities.find((e) => e.name.startsWith("__role:"));
  if (roleEnt) {
    const named = entities.find((e) => e.name === personName);
    if (named && roleEnt.summary && !named.summary) named.summary = roleEnt.summary;
    for (const a of assertions) {
      if (a.subjectName === roleEnt.name) a.subjectName = personName;
      if (a.objectName === roleEnt.name) a.objectName = personName;
    }
    const idx = entities.indexOf(roleEnt);
    if (idx >= 0) entities.splice(idx, 1);
    pushWorkplaceRole(
      assertions,
      personName,
      roleEnt.summary?.replace(/^User's\s+/i, "") || "workplace contact",
    );
  } else if (WORKPLACE_CONTACT_ROLE.test(t) || /\bhr\s*specialist\b/i.test(t)) {
    pushWorkplaceRole(assertions, personName, "HR specialist");
  }

  const orgs = new Set(
    assertions
      .filter((a) => a.predicate === "worksAt")
      .map((a) => a.objectName),
  );
  // Also parse org from "works at USPTO" in this utterance
  const orgMention = t.match(
    new RegExp(
      String.raw`\bworks?\s+(?:at|for)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
      "i",
    ),
  );
  if (orgMention?.[1]) {
    const cleaned = cleanOrgName(orgMention[1]);
    if (cleaned) orgs.add(cleaned);
  }
  for (const org of orgs) {
    pushWorksAt(assertions, personName, org);
  }
}

/**
 * Invention / founding links for networking:
 * - inventorOf: "Amy is the co-inventor of Open Index Protocol"
 * - founderOf: "Devon founded Happy Owl Studio" / "is the founder of …"
 * - cofounderOf: "Sarah is a co-founder of Acme" / "co-founded …"
 */
function extractInvention(
  t: string,
  addPerson: (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => string | null,
  addWork: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): void {
  type Role = {
    predicate: "inventorOf" | "founderOf" | "cofounderOf";
    summary: string;
    text: (person: string, target: string) => string;
    re: RegExp;
  };

  const personCapture = String.raw`(I|we|[A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)`;

  const roles: Role[] = [
    {
      predicate: "inventorOf",
      summary: "Invented work",
      text: (p, w) => `${p === "__user__" ? "User" : p} is an inventor of ${w}.`,
      re: new RegExp(
        String.raw`\b${personCapture}\s*,?\s+is\s+(?:also\s+)?(?:(?:a|an|the)\s+)?co[-\s]?inventor\s+of\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    },
    {
      predicate: "inventorOf",
      summary: "Invented work",
      text: (p, w) => `${p === "__user__" ? "User" : p} is an inventor of ${w}.`,
      re: new RegExp(
        String.raw`\b${personCapture}\s*,?\s+is\s+(?:also\s+)?(?:(?:a|an|the)\s+)?inventor\s+of\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    },
    {
      predicate: "inventorOf",
      summary: "Invented work",
      text: (p, w) => `${p === "__user__" ? "User" : p} is an inventor of ${w}.`,
      re: new RegExp(
        String.raw`\b${personCapture}\s+(?:also\s+)?co[-\s]?invented\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    },
    {
      predicate: "inventorOf",
      summary: "Invented work",
      text: (p, w) => `${p === "__user__" ? "User" : p} is an inventor of ${w}.`,
      re: new RegExp(
        String.raw`\b${personCapture}\s+(?:also\s+)?invented\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    },
    {
      predicate: "cofounderOf",
      summary: "Co-founded venture",
      text: (p, w) => `${p === "__user__" ? "User" : p} is a co-founder of ${w}.`,
      re: new RegExp(
        String.raw`\b${personCapture}\s*,?\s+is\s+(?:also\s+)?(?:(?:a|an|the)\s+)?co[-\s]?founder\s+of\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    },
    {
      predicate: "cofounderOf",
      summary: "Co-founded venture",
      text: (p, w) => `${p === "__user__" ? "User" : p} is a co-founder of ${w}.`,
      re: new RegExp(
        String.raw`\b${personCapture}\s+(?:also\s+)?co[-\s]?founded\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    },
    {
      predicate: "founderOf",
      summary: "Founded venture",
      text: (p, w) => `${p === "__user__" ? "User" : p} is the founder of ${w}.`,
      re: new RegExp(
        String.raw`\b${personCapture}\s*,?\s+is\s+(?:also\s+)?(?:(?:a|an|the)\s+)?founder\s+of\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    },
    {
      predicate: "founderOf",
      summary: "Founded venture",
      text: (p, w) => `${p === "__user__" ? "User" : p} is the founder of ${w}.`,
      re: new RegExp(
        String.raw`\b${personCapture}\s+(?:also\s+)?founded\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
        "i",
      ),
    },
  ];

  const push = (
    predicate: Role["predicate"],
    person: string,
    target: string,
    text: string,
  ) => {
    if (
      assertions.some(
        (a) =>
          a.predicate === predicate &&
          a.subjectName.toLowerCase() === person.toLowerCase() &&
          a.objectName.toLowerCase() === target.toLowerCase(),
      )
    ) {
      return;
    }
    assertions.push({
      subjectName: person,
      predicate,
      objectName: target,
      text,
    });
  };

  for (const role of roles) {
    const m = t.match(role.re);
    if (!m?.[1] || !m[2]) continue;
    if (/^(he|she|they|my)\b/i.test(m[1])) continue;
    if (WORKPLACE_ROLE.test(m[1])) continue;
    if (PLACEHOLDER_PERSON.test(m[1])) continue;

    const person = /^(i|we)\b/i.test(m[1]) ? "__user__" : addPerson(m[1], undefined);
    if (!person) continue;
    const target = addWork(m[2], role.summary);
    if (!target) continue;

    push(role.predicate, person, target, role.text(person, target));
    return;
  }
}

/** Employment verb forms from speech: work / works / worked / working. */
const WORK_AT_VERB = String.raw`work(?:ed|ing|s)?`;

/** "Sarah Chen also works at USPTO" / "James worked for the USPTO" */
function extractPersonWorksAt(
  t: string,
  addPerson: (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => string | null,
  addOrganization: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): void {
  // Prefer role-contact phrasing — don't invent "Person That"
  if (
    new RegExp(
      String.raw`\b(?:another\s+)?(?:person|someone|somebody)\s+(?:that|who)\s+${WORK_AT_VERB}\s+(?:at|for)\b`,
      "i",
    ).test(t)
  ) {
    return;
  }

  const re = new RegExp(
    String.raw`\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s+(?:also\s+)?${WORK_AT_VERB}\s+(?:at|for)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}([\s\S]*)`,
    "i",
  );
  const m = t.match(re);
  if (!m?.[1] || !m[2]) return;
  // Skip "I work at …" / "I now work at …" (handled by extractOrganizations)
  if (/^(i|we|my)\b/i.test(m[1])) return;
  if (WORKPLACE_ROLE.test(m[1])) return;
  if (PLACEHOLDER_PERSON.test(m[1])) return;

  let nameRaw = m[1];
  // "She also worked at Happy Owl…" after naming Amy James in the same turn
  if (/^(he|she|they)\b/i.test(nameRaw)) {
    const before = t.slice(0, m.index ?? 0);
    const names = [
      ...before.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g),
    ].map((x) => x[1]!);
    const resolved = [...names]
      .reverse()
      .find((n) => isPlausiblePersonName(cleanPersonName(n)));
    if (!resolved) return;
    nameRaw = resolved;
  }

  const trail = m[3] ?? "";
  if (/^\s*is\s+my\b/i.test(trail) && PLACEHOLDER_PERSON.test(m[1])) return;

  const person = addPerson(nameRaw, undefined);
  const org = addOrganization(m[2], "Employer");
  if (!person || !org) return;
  pushWorksAt(assertions, person, org);

  parseOrgHierarchyTrail(org, trail, addOrganization, assertions);
  maybeLinkColleagueIfSharedEmployer(assertions, person);
}

function maybeLinkColleagueIfSharedEmployer(
  assertions: ConversationalAssertionSpec[],
  person: string,
): void {
  const userOrgs = new Set(
    assertions
      .filter((a) => a.predicate === "worksAt" && a.subjectName === "__user__")
      .map((a) => a.objectName.toLowerCase()),
  );
  const personOrgs = assertions
    .filter((a) => a.predicate === "worksAt" && a.subjectName === person)
    .map((a) => a.objectName.toLowerCase());
  if (personOrgs.some((o) => userOrgs.has(o))) {
    pushWorksWith(assertions, person);
  }
}

/** "my boss is James Nosal at USPTO" / "James at USPTO is my supervisor" */
function extractBossAtOrganization(
  t: string,
  addPerson: (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => string | null,
  addOrganization: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): void {
  const patterns: RegExp[] = [
    new RegExp(
      String.raw`\bmy\s+(boss|supervisor|manager)\s+(?:is\s+|named\s+)?([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s+at\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
      "i",
    ),
    new RegExp(
      String.raw`\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s+at\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}\s+is\s+my\s+(boss|supervisor|manager)\b`,
      "i",
    ),
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const firstIsRole = /^(boss|supervisor|manager)$/i.test(m[1]!);
    const roleWord = (firstIsRole ? m[1]! : m[3]!).toLowerCase();
    const nameRaw = firstIsRole ? m[2]! : m[1]!;
    const orgRaw = firstIsRole ? m[3]! : m[2]!;
    const person = addPerson(nameRaw, `User's ${roleWord}`);
    const org = addOrganization(orgRaw, "User's employer");
    if (!person || !org) continue;

    if (
      !assertions.some(
        (a) =>
          a.predicate === "supervisorOf" &&
          a.subjectName === person &&
          a.objectName === "__user__",
      )
    ) {
      assertions.push({
        subjectName: person,
        predicate: "supervisorOf",
        objectName: "__user__",
        text: `${person} is the user's ${roleWord}.`,
      });
      assertions.push({
        subjectName: "__user__",
        predicate: "reportsTo",
        objectName: person,
        text: `User reports to ${person}.`,
      });
    }
    pushWorksAt(assertions, "__user__", org);
    pushWorksAt(assertions, person, org);
    return;
  }
}

function extractOrganizations(
  t: string,
  addOrganization: (raw: string, summary?: string) => string | null,
  assertions: ConversationalAssertionSpec[],
): void {
  const patterns: RegExp[] = [
    // I (now) work(ing) for/at/with USPTO
    new RegExp(
      String.raw`\bi(?:'m|\s+am)?\s+(?:now\s+)?(?:also\s+)?work(?:ing)?\s+(?:for|at|with)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
      "i",
    ),
    // I'm employed by/at …
    new RegExp(
      String.raw`\bi(?:'m|\s+am)\s+(?:now\s+)?employed\s+(?:by|at|with)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
      "i",
    ),
    // I joined / started at / got a job at …
    new RegExp(
      String.raw`\bi\s+(?:just\s+)?(?:joined|started(?:\s+working)?\s+at|got\s+a\s+(?:new\s+)?job\s+at)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
      "i",
    ),
    // my (new) employer/company is …
    new RegExp(
      String.raw`\bmy\s+(?:new\s+)?(?:employer|company|workplace)\s+(?:is|at)\s+(?:the\s+)?${ORG_NAME_CAPTURE.source}`,
      "i",
    ),
    // USPTO is my (new) employer
    new RegExp(
      String.raw`\b${ORG_NAME_CAPTURE.source}\s+is\s+my\s+(?:new\s+)?(?:employer|company|workplace)\b`,
      "i",
    ),
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    const org = addOrganization(m[1], "User's employer");
    if (!org) continue;
    pushWorksAt(assertions, "__user__", org);
    // One employer write per utterance is enough
    return;
  }
}

const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE =
  /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/;
/** STT often spells emails: "james dot nosal at u s p t o dot gov" */
const SPOKEN_EMAIL_RE =
  /\b((?:[a-z0-9]+(?:\s+dot\s+[a-z0-9]+|\s+[a-z0-9])*))\s+at\s+((?:[a-z0-9]+(?:\s+dot\s+[a-z0-9]+|\s+[a-z0-9])*))/i;

function collapseSpokenEmailPart(raw: string): string {
  return raw
    .split(/\s+dot\s+/i)
    .map((seg) => {
      const toks = seg.trim().split(/\s+/).filter(Boolean);
      if (toks.length > 1 && toks.every((t) => t.length === 1)) return toks.join("");
      return toks.join("");
    })
    .join(".");
}

function parseSpokenEmail(text: string): string | undefined {
  const re = new RegExp(SPOKEN_EMAIL_RE.source, "gi");
  for (const m of text.matchAll(re)) {
    if (!m[1] || !m[2]) continue;
    const local = collapseSpokenEmailPart(m[1]);
    const domain = collapseSpokenEmailPart(m[2]);
    if (!local || !domain.includes(".")) continue;
    return `${local}@${domain}`.toLowerCase();
  }
  return undefined;
}

function extractContactDetails(
  t: string,
  addPerson: (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => string | null,
  entities: ConversationalEntitySpec[],
): void {
  const email = t.match(EMAIL_RE)?.[0] ?? parseSpokenEmail(t);
  const phoneRaw = t.match(PHONE_RE)?.[0];
  const telephone = phoneRaw ? normalizePhone(phoneRaw) : undefined;
  if (!email && !telephone) return;

  const contact = { email: email || undefined, telephone };

  // "James Nosal's email is …" / "James's phone number is …"
  // Skip "my boss's email" — role phrases are handled below.
  const possessive = t.match(
    /\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s*(?:'s|s')\s+(?:email|e-mail|phone|telephone|number|cell|mobile)\b/i,
  );
  if (possessive?.[1]) {
    const candidate = cleanPersonName(possessive[1]);
    if (isPlausiblePersonName(candidate)) {
      addPerson(candidate, undefined, contact);
      return;
    }
  }

  // "email for James Nosal is …" / "phone number for James is …"
  const forPerson = t.match(
    /\b(?:email|e-mail|phone|telephone|number|cell|mobile)(?:\s+(?:address|number))?\s+(?:for|of)\s+([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)/i,
  );
  if (forPerson?.[1]) {
    const candidate = cleanPersonName(forPerson[1]);
    if (isPlausiblePersonName(candidate)) {
      addPerson(candidate, undefined, contact);
      return;
    }
  }

  // "James Nosal email is …" / "James Nosal phone is 555…"
  // Avoid matching role words like "boss's email".
  const nameThenContact = t.match(
    /\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s+(?:email|e-mail|phone|telephone|number|cell|mobile)\s*(?:is|:)?\s*/i,
  );
  if (nameThenContact?.[1]) {
    const candidate = cleanPersonName(nameThenContact[1]);
    if (isPlausiblePersonName(candidate)) {
      addPerson(candidate, undefined, contact);
      return;
    }
  }

  // "my boss's email is …" / "my supervisor phone number is …"
  const roleContact = t.match(
    /\bmy\s+(boss|supervisor|manager|wife|husband|spouse|partner|son|daughter)\s*(?:'s|s')?\s+(?:email|e-mail|phone|telephone|number|cell|mobile)\b/i,
  );
  if (roleContact?.[1]) {
    const role = roleContact[1].toLowerCase();
    // Prefer a person already extracted this turn with that role in summary
    const fromTurn = entities.find((e) =>
      (e.summary ?? "").toLowerCase().includes(role),
    );
    if (fromTurn) {
      if (email) fromTurn.email = email;
      if (telephone) fromTurn.telephone = telephone;
      return;
    }
    // Fall back: create/update under a role placeholder name that write path can resolve
    // via existing supervisorOf / spouseOf / parentOf links — handled in writeConversationalMemory
    addPerson(`__role:${role}__`, `User's ${role}`, contact);
    return;
  }

  // "his/her email is …" — same-turn person, else assume supervisor (common follow-up)
  if (
    /\b(?:his|her|their)\s+(?:email|e-mail|phone|telephone|number|cell|mobile)(?:\s+address|\s+number)?\b/i.test(
      t,
    )
  ) {
    const people = entities.filter(
      (e) =>
        !e.name.startsWith("__role:") &&
        (e.entityClass ?? "Person") === "Person",
    );
    if (people.length === 1) {
      if (email) people[0]!.email = email;
      if (telephone) people[0]!.telephone = telephone;
      return;
    }
    // Prefer workplace-role person when several people are present
    const rolePerson = people.find((e) =>
      /hr|specialist|recruiter|coworker|colleague|boss|supervisor/i.test(
        e.summary ?? "",
      ),
    );
    if (rolePerson) {
      if (email) rolePerson.email = email;
      if (telephone) rolePerson.telephone = telephone;
      return;
    }
    addPerson("__role:boss__", "User's boss", contact);
    return;
  }

  // Bare contact with a person name elsewhere in the sentence
  const anyName = t.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/);
  if (anyName?.[1]) {
    addPerson(anyName[1], undefined, contact);
  }
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw.trim();
}

const MONTH_INDEX: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Spoken day ordinals / cardinals → 1–31 (longest phrases first). */
const SPOKEN_DAY: Array<[RegExp, number]> = [
  [/\bthirty[\s-]?first\b/gi, 31],
  [/\bthirtieth\b/gi, 30],
  [/\btwenty[\s-]?ninth\b/gi, 29],
  [/\btwenty[\s-]?eighth\b/gi, 28],
  [/\btwenty[\s-]?seventh\b/gi, 27],
  [/\btwenty[\s-]?sixth\b/gi, 26],
  [/\btwenty[\s-]?fifth\b/gi, 25],
  [/\btwenty[\s-]?fourth\b/gi, 24],
  [/\btwenty[\s-]?third\b/gi, 23],
  [/\btwenty[\s-]?second\b/gi, 22],
  [/\btwenty[\s-]?first\b/gi, 21],
  [/\btwentieth\b/gi, 20],
  [/\bnineteenth\b/gi, 19],
  [/\beighteenth\b/gi, 18],
  [/\bseventeenth\b/gi, 17],
  [/\bsixteenth\b/gi, 16],
  [/\bfifteenth\b/gi, 15],
  [/\bfourteenth\b/gi, 14],
  [/\bthirteenth\b/gi, 13],
  [/\btwelfth\b/gi, 12],
  [/\beleventh\b/gi, 11],
  [/\btenth\b/gi, 10],
  [/\bninth\b/gi, 9],
  [/\beighth\b/gi, 8],
  [/\bseventh\b/gi, 7],
  [/\bsixth\b/gi, 6],
  [/\bfifth\b/gi, 5],
  [/\bfourth\b/gi, 4],
  [/\bthird\b/gi, 3],
  [/\bsecond\b/gi, 2],
  [/\bfirst\b/gi, 1],
  // cardinals sometimes used without -th
  [/\btwenty[\s-]?nine\b/gi, 29],
  [/\btwenty[\s-]?eight\b/gi, 28],
  [/\btwenty[\s-]?seven\b/gi, 27],
  [/\btwenty[\s-]?six\b/gi, 26],
  [/\btwenty[\s-]?five\b/gi, 25],
  [/\btwenty[\s-]?four\b/gi, 24],
  [/\btwenty[\s-]?three\b/gi, 23],
  [/\btwenty[\s-]?two\b/gi, 22],
  [/\btwenty[\s-]?one\b/gi, 21],
];

const SPOKEN_ONES: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const SPOKEN_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/**
 * Turn spoken date phrases into digit forms the numeric parsers understand.
 * e.g. "August twenty ninth nineteen eighty" → "August 29 1980"
 */
export function normalizeSpokenDatePhrase(raw: string): string {
  let s = raw;
  for (const [re, n] of SPOKEN_DAY) {
    s = s.replace(re, String(n));
  }
  s = s.replace(
    /\b(nineteen|twenty)\s+([a-z]+)(?:[\s-]([a-z]+))?\b/gi,
    (full, century: string, a: string, b?: string) => {
      const base = century.toLowerCase() === "nineteen" ? 1900 : 2000;
      const al = a.toLowerCase();
      const bl = b?.toLowerCase();
      const tens = SPOKEN_TENS[al];
      if (tens != null) {
        if (!bl) return String(base + tens);
        const ones = SPOKEN_ONES[bl];
        if (ones == null || ones > 9) return full;
        return String(base + tens + ones);
      }
      const teen = SPOKEN_ONES[al];
      if (teen != null && teen >= 10 && !bl) return String(base + teen);
      const onesOnly = SPOKEN_ONES[al];
      if (onesOnly != null && onesOnly < 10 && !bl) return String(base + onesOnly);
      return full;
    },
  );
  return s;
}

/** Parse a spoken/written calendar date into schema.org birthDate + display label. */
export function parseSpokenDate(
  raw: string,
): { iso: string; label: string } | null {
  const t = normalizeSpokenDatePhrase(
    cleanPhrase(raw)
      .replace(/[.].*$/, "")
      .replace(/\b(?:this\s+year|last\s+year)\b/gi, "")
      .trim(),
  );
  if (!t) return null;

  const monthToken = Object.keys(MONTH_INDEX).join("|");
  const pad = (n: number) => String(n).padStart(2, "0");
  const build = (year: number | null, month: number, day: number) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const iso = year != null ? `${year}-${pad(month)}-${pad(day)}` : `--${pad(month)}-${pad(day)}`;
    const label =
      year != null
        ? `${MONTH_NAMES[month - 1]} ${day}, ${year}`
        : `${MONTH_NAMES[month - 1]} ${day}`;
    return { iso, label };
  };

  let m = t.match(
    new RegExp(
      String.raw`\b(${monthToken})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`,
      "i",
    ),
  );
  if (m?.[1] && m[2]) {
    const month = MONTH_INDEX[m[1]!.toLowerCase()]!;
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : null;
    return build(year, month, day);
  }

  m = t.match(
    new RegExp(
      String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${monthToken})(?:,?\s+(\d{4}))?\b`,
      "i",
    ),
  );
  if (m?.[1] && m[2]) {
    const day = Number(m[1]);
    const month = MONTH_INDEX[m[2]!.toLowerCase()]!;
    const year = m[3] ? Number(m[3]) : null;
    return build(year, month, day);
  }

  m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (m?.[1] && m[2]) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year: number | null = m[3] ? Number(m[3]) : null;
    if (year != null && year < 100) year += year >= 70 ? 1900 : 2000;
    return build(year, month, day);
  }

  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m?.[1] && m[2] && m[3]) {
    return build(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  return null;
}

function attachBirthDate(
  entities: ConversationalEntitySpec[],
  personName: string,
  iso: string,
): void {
  const existing =
    personName === "__user__"
      ? entities.find((e) => e.name === "__user__")
      : entities.find((e) => e.name.toLowerCase() === personName.toLowerCase());
  if (existing) {
    existing.birthDate = iso;
    if (!existing.entityClass) existing.entityClass = "Person";
    return;
  }
  entities.push({
    name: personName,
    entityClass: "Person",
    birthDate: iso,
  });
}

/**
 * Birthday / birth-date personal details.
 * Stores schema.org birthDate on the Person and a hasBirthDate edge to a
 * date Thing so the fact is visible when browsing connections.
 */
function extractPersonalDetails(
  t: string,
  addPerson: (
    raw: string,
    summary?: string,
    contact?: { email?: string; telephone?: string },
  ) => string | null,
  addWork: (raw: string, summary?: string) => string | null,
  entities: ConversationalEntitySpec[],
  assertions: ConversationalAssertionSpec[],
): void {
  const pushLink = (person: string, iso: string, label: string) => {
    attachBirthDate(entities, person, iso);
    const dateNode = addWork(label, "Birthday");
    if (!dateNode) return;
    if (
      assertions.some(
        (a) =>
          a.predicate === "hasBirthDate" &&
          a.subjectName.toLowerCase() === person.toLowerCase(),
      )
    ) {
      // Update object if re-stated
      const existing = assertions.find(
        (a) =>
          a.predicate === "hasBirthDate" &&
          a.subjectName.toLowerCase() === person.toLowerCase(),
      )!;
      existing.objectName = dateNode;
      existing.text = `${person === "__user__" ? "User" : person}'s birthday is ${label}.`;
      return;
    }
    assertions.push({
      subjectName: person,
      predicate: "hasBirthDate",
      objectName: dateNode,
      text: `${person === "__user__" ? "User" : person}'s birthday is ${label}.`,
    });
  };

  const tryDate = (raw: string | undefined): { iso: string; label: string } | null => {
    if (!raw) return null;
    return parseSpokenDate(raw);
  };

  // "my birthday is March 15th" / "my birthday is March 15, 1985"
  const myBday = t.match(
    /\bmy\s+birthday\s+is\s+(.+?)(?:[.!?;]|$)/i,
  );
  if (myBday?.[1]) {
    const parsed = tryDate(myBday[1]);
    if (parsed) pushLink("__user__", parsed.iso, parsed.label);
  }

  // "I was born on March 15, 1985" / "I was born March 15th"
  const born = t.match(
    /\bi\s+was\s+born\s+(?:on\s+)?(.+?)(?:[.!?;]|$)/i,
  );
  if (born?.[1]) {
    const parsed = tryDate(born[1]);
    if (parsed) pushLink("__user__", parsed.iso, parsed.label);
  }

  // "Amy James's birthday is June 3rd" / "Amy's birthday is June 3"
  const namedPossessive = t.match(
    /\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s*(?:'s|s')\s+birthday\s+is\s+(.+?)(?:[.!?;]|$)/i,
  );
  if (namedPossessive?.[1] && namedPossessive[2]) {
    if (!/^(my|his|her|their|our|your)$/i.test(namedPossessive[1])) {
      const person = addPerson(namedPossessive[1], undefined);
      const parsed = tryDate(namedPossessive[2]);
      if (person && parsed) pushLink(person, parsed.iso, parsed.label);
    }
  }

  // "Amy James birthday is June 3"
  const namedBare = t.match(
    /\b([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)\s+birthday\s+is\s+(.+?)(?:[.!?;]|$)/i,
  );
  if (namedBare?.[1] && namedBare[2]) {
    if (!/^(my|his|her|their|our|your)$/i.test(namedBare[1])) {
      const person = addPerson(namedBare[1], undefined);
      const parsed = tryDate(namedBare[2]);
      if (person && parsed) pushLink(person, parsed.iso, parsed.label);
    }
  }

  // "her birthday is June 3" — attach to same-turn person when unique
  const pronounBday = t.match(
    /\b(?:his|her|their)\s+birthday\s+is\s+(.+?)(?:[.!?;]|$)/i,
  );
  if (pronounBday?.[1]) {
    const parsed = tryDate(pronounBday[1]);
    const people = entities.filter(
      (e) =>
        e.name !== "__user__" &&
        !e.name.startsWith("__role:") &&
        (e.entityClass ?? "Person") === "Person",
    );
    if (parsed && people.length === 1) {
      pushLink(people[0]!.name, parsed.iso, parsed.label);
    }
  }
}

/**
 * If the user works at an org and has workplace colleagues (this write and/or already
 * in the graph — supervisors, coworkers), ensure each also has worksAt that org.
 */
async function ensureCoworkersShareEmployer(
  provider: OipLocalMemoryProvider,
  userDid: string,
  userName: string,
  write: ConversationalMemoryWrite,
  entityIds: Record<string, string>,
  now: string,
  createAssertion: (
    subjectNameRaw: string,
    predicate: string,
    objectNameRaw: string,
    text: string | undefined,
    subjectClass: string,
    objectClass: string,
  ) => Promise<boolean>,
): Promise<number> {
  const orgNames = new Set<string>();
  const colleagueNames = new Set<string>();

  const addColleague = (name: string | null | undefined, schemaType?: string | null) => {
    if (!name || name === userName) return;
    if (name.startsWith("[superseded]")) return;
    if (schemaType && !schemaType.includes("Person") && schemaType.includes("Organization")) {
      return;
    }
    // Ignore document/tweet titles mistaken for people
    if (name.length > 80 || /https?:|\.com\b/i.test(name)) return;
    colleagueNames.add(name);
  };

  for (const a of write.assertions ?? []) {
    if (a.predicate === "worksAt" && a.subjectName === "__user__") orgNames.add(a.objectName);
    if (a.predicate === "reportsTo" && a.subjectName === "__user__") addColleague(a.objectName);
    if (a.predicate === "supervisorOf" && a.objectName === "__user__") addColleague(a.subjectName);
    if (a.predicate === "worksWith" && a.subjectName === "__user__") addColleague(a.objectName);
    if (a.predicate === "worksWith" && a.objectName === "__user__") addColleague(a.subjectName);
    if (a.predicate === "colleagueOf" && a.subjectName === "__user__") addColleague(a.objectName);
    if (a.predicate === "colleagueOf" && a.objectName === "__user__") addColleague(a.subjectName);
    if (a.predicate === "workplaceRole" && a.objectName === "__user__") addColleague(a.subjectName);
  }

  // Prefer graph edges: Assertion --subject/object--> User, then read predicate.
  for (const e of provider.sqlite.edgesTo(userDid)) {
    if (e.predicate !== "subject" && e.predicate !== "object") continue;
    const logicalId = e.source_id.replace(/^did:memory:/, "").split("#")[0]!;
    const rev = await provider.packages.readCurrent(logicalId);
    if (!rev?.predicate) continue;
    if (
      e.predicate === "subject" &&
      rev.predicate === "worksAt" &&
      rev.object != null
    ) {
      const org = provider.sqlite.getRecord(String(rev.object));
      if (org?.name && !org.name.startsWith("[superseded]")) orgNames.add(org.name);
    }
    if (e.predicate === "subject" && rev.object != null) {
      if (rev.predicate === "reportsTo" || rev.predicate === "worksWith") {
        const person = provider.sqlite.getRecord(String(rev.object));
        addColleague(person?.name, person?.schema_type);
      }
    }
    if (e.predicate === "object" && rev.subject) {
      if (
        rev.predicate === "supervisorOf" ||
        rev.predicate === "colleagueOf" ||
        rev.predicate === "worksWith" ||
        rev.predicate === "workplaceRole"
      ) {
        const person = provider.sqlite.getRecord(String(rev.subject));
        addColleague(person?.name, person?.schema_type);
      }
    }
  }

  // Fallback when edges are stale/missing: scan assertion packages by name.
  const absorbAssertion = async (row: { logical_id: string; name: string | null }) => {
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev?.predicate) return;
    if (rev.predicate === "worksAt" && rev.subject === userDid && rev.object != null) {
      const org = provider.sqlite.getRecord(String(rev.object));
      if (org?.name && !org.name.startsWith("[superseded]")) orgNames.add(org.name);
    }
    if (
      (rev.predicate === "reportsTo" || rev.predicate === "worksWith") &&
      rev.subject === userDid &&
      rev.object != null
    ) {
      const person = provider.sqlite.getRecord(String(rev.object));
      addColleague(person?.name, person?.schema_type);
    }
    if (
      (rev.predicate === "supervisorOf" ||
        rev.predicate === "colleagueOf" ||
        rev.predicate === "worksWith" ||
        rev.predicate === "workplaceRole") &&
      rev.object === userDid &&
      rev.subject
    ) {
      const person = provider.sqlite.getRecord(String(rev.subject));
      addColleague(person?.name, person?.schema_type);
    }
  };

  for (const row of provider.sqlite.findByName(`${userName} worksAt`, "Assertion")) {
    await absorbAssertion(row);
  }
  for (const row of provider.sqlite.findByName("User worksAt", "Assertion")) {
    await absorbAssertion(row);
  }
  for (const row of provider.sqlite.findByName(`${userName} reportsTo`, "Assertion")) {
    await absorbAssertion(row);
  }
  for (const row of provider.sqlite.findByName(`${userName} worksWith`, "Assertion")) {
    await absorbAssertion(row);
  }
  for (const row of provider.sqlite.findByName("User worksWith", "Assertion")) {
    await absorbAssertion(row);
  }
  for (const row of provider.sqlite.listByType("Assertion", 160)) {
    const n = row.name ?? "";
    if (
      !n.includes("supervisorOf") &&
      !n.includes("colleagueOf") &&
      !n.includes("worksWith")
    ) {
      continue;
    }
    await absorbAssertion(row);
  }

  let created = 0;
  for (const org of orgNames) {
    if (!entityIds[org]) {
      entityIds[org] = await upsertNamedEntity(
        provider,
        org,
        "User's employer",
        now,
        "Organization",
      );
    }
    for (const person of colleagueNames) {
      if (!person || person === userName) continue;
      const ok = await createAssertion(
        person,
        "worksAt",
        org,
        `${person} works at ${org}.`,
        "Person",
        "Organization",
      );
      if (ok) created += 1;
    }
  }
  return created;
}

export async function writeConversationalMemory(
  provider: OipLocalMemoryProvider,
  write: ConversationalMemoryWrite,
  opts: { userDisplayName?: string; sessionId?: string } = {},
): Promise<ConversationalMemoryWriteResult> {
  await provider.packages.ensureRoot();
  provider.sqlite.open();

  const now = new Date().toISOString();
  const entityIds: Record<string, string> = {};
  let entitiesUpserted = 0;
  let assertionsCreated = 0;
  let notesCreated = 0;

  const preferredName =
    opts.userDisplayName?.trim() || process.env.BRIEFING_USER_NAME?.trim() || "";
  const self = await resolveSelfEntity(provider);
  // When a Person is marked isSelf, that identity wins over env/"User".
  const userName = self?.name || preferredName || "User";
  const userDid =
    self?.id ??
    (await upsertNamedEntity(provider, userName, "The user Alfred serves", now));
  entityIds["__user__"] = userDid;
  entityIds[userName] = userDid;

  for (const ent of write.entities ?? []) {
    let name = ent.name;
    if (name === "__user__") {
      // Always patch the resolved self person — never invent a second "User".
      await upsertNamedEntity(
        provider,
        userName,
        ent.summary ?? "The user Alfred serves",
        now,
        "Person",
        {
          email: ent.email,
          telephone: ent.telephone,
          birthDate: ent.birthDate,
        },
      );
      entityIds["__user__"] = userDid;
      entityIds[userName] = userDid;
      entitiesUpserted += 1;
      continue;
    }
    if (name.startsWith("__role:") && name.endsWith("__")) {
      const role = name.slice("__role:".length, -2);
      const resolved = await resolveRolePerson(provider, role, userDid);
      if (resolved) {
        name = resolved.name;
        entityIds[ent.name] = resolved.id;
      } else {
        // No known person for that role yet — skip contact-only write
        continue;
      }
    }
    const did = await upsertNamedEntity(
      provider,
      name,
      ent.summary,
      now,
      ent.entityClass ?? "Person",
      { email: ent.email, telephone: ent.telephone, birthDate: ent.birthDate },
    );
    entityIds[ent.name] = did;
    entityIds[name] = did;
    entitiesUpserted += 1;
  }

  const createAssertion = async (
    subjectNameRaw: string,
    predicate: string,
    objectNameRaw: string,
    text: string | undefined,
    subjectClass: string,
    objectClass: string,
  ): Promise<boolean> => {
    const subjectName = subjectNameRaw === "__user__" ? userName : subjectNameRaw;
    const objectName = objectNameRaw === "__user__" ? userName : objectNameRaw;
    const subjectDid =
      entityIds[subjectNameRaw] ??
      entityIds[subjectName] ??
      (await upsertNamedEntity(provider, subjectName, undefined, now, subjectClass));
    const objectDid =
      entityIds[objectNameRaw] ??
      entityIds[objectName] ??
      (await upsertNamedEntity(provider, objectName, undefined, now, objectClass));
    entityIds[subjectName] = subjectDid;
    entityIds[objectName] = objectDid;

    const assertionName = `${subjectName} ${predicate}`;
    const existingRows = provider.sqlite
      .findByName(assertionName, "Assertion")
      .filter(
        (row) =>
          row.name === assertionName ||
          row.name === `${subjectName} ${predicate} ${objectName}`,
      );

    for (const row of existingRows) {
      const rev = await provider.packages.readCurrent(row.logical_id);
      if (!rev) continue;
      const currentObject = rev.object != null ? String(rev.object) : null;
      if (currentObject === objectDid) return false;
      // Retarget worksAt when the named assertion pointed at the wrong entity
      // (e.g. Place matched via search_text instead of Organization).
      if (
        (predicate === "worksAt" || predicate === "hasBirthDate") &&
        (rev.subject === subjectDid || !rev.subject)
      ) {
        await provider.updateRecord(
          row.logical_id,
          {
            subject: subjectDid,
            object: objectDid,
            text: text ?? `${subjectName} ${predicate} ${objectName}`,
            drefs: { subject: subjectDid, object: objectDid },
            schema: {
              ...(rev.schema ?? {}),
              "@type": "Statement",
              name: assertionName,
              text: text ?? `${subjectName} ${predicate} ${objectName}`,
            },
          },
          { reindex: false },
        );
        return true;
      }
      // Non-worksAt: same subject+predicate name already claimed — skip create
      if (predicate !== "worksAt") return false;
    }

    await provider.createRecord(
      "Assertion",
      {
        name: assertionName,
        text: text ?? `${subjectName} ${predicate} ${objectName}`,
        subject: subjectDid,
        predicate,
        object: objectDid,
        schema: {
          "@type": "Statement",
          name: assertionName,
          text: text ?? `${subjectName} ${predicate} ${objectName}`,
        },
        drefs: { subject: subjectDid, object: objectDid },
        alfred: {
          assertionType: "explicit",
          confidence: 0.9,
          visibility: "private",
        },
        learnedAt: now,
        provenance: {
          sourceType: "conversation_extraction",
          learnedAt: now,
          extractionMethod: "conversational_memory",
          speaker: "user",
        },
      },
      undefined,
      { reindex: false },
    );
    return true;
  };

  for (const a of write.assertions ?? []) {
    const orgPredicates = new Set(["worksAt", "partOf", "runs", "hiredBy", "memberOf"]);
    const thingPredicates = new Set([
      "hasBirthDate",
      "inventorOf",
      "founderOf",
      "cofounderOf",
    ]);
    const subjectClass =
      write.entities?.find((e) => e.name === a.subjectName)?.entityClass ??
      (a.predicate === "partOf" || a.predicate === "runs" ? "Organization" : "Person");
    const objectClass =
      write.entities?.find((e) => e.name === a.objectName)?.entityClass ??
      (orgPredicates.has(a.predicate)
        ? "Organization"
        : thingPredicates.has(a.predicate)
          ? "Thing"
          : "Person");
    if (
      await createAssertion(
        a.subjectName,
        a.predicate,
        a.objectName,
        a.text,
        subjectClass,
        objectClass,
      )
    ) {
      assertionsCreated += 1;
    }
  }

  // Cross-turn: workplace colleagues (bosses + coworkers) also worksAt user's employer.
  assertionsCreated += await ensureCoworkersShareEmployer(
    provider,
    userDid,
    userName,
    write,
    entityIds,
    now,
    createAssertion,
  );

  for (const note of write.notes ?? []) {
    const trimmed = note.trim();
    if (!trimmed) continue;
    await provider.createRecord(
      "Observation",
      {
        name: trimmed.slice(0, 80),
        text: trimmed,
        observedAt: now,
        schemaType: SCHEMA_ORG.CreativeWork,
        schema: { "@type": "CreativeWork", name: trimmed.slice(0, 80), text: trimmed },
        alfred: { visibility: "private", confidence: 0.85, assertionType: "explicit" },
        learnedAt: now,
        provenance: {
          sourceType: "conversation_extraction",
          learnedAt: now,
          extractionMethod: "conversational_memory",
          speaker: "user",
        },
        drefs: opts.sessionId ? { session: opts.sessionId } : {},
      },
      undefined,
      { reindex: false },
    );
    notesCreated += 1;
  }

  if (entitiesUpserted || assertionsCreated || notesCreated) {
    await provider.rebuildIndexes();
  }

  return { entitiesUpserted, assertionsCreated, notesCreated, entityIds };
}

async function resolveRolePerson(
  provider: OipLocalMemoryProvider,
  role: string,
  userDid: string,
): Promise<{ id: string; name: string } | null> {
  const predicate =
    role === "boss" || role === "supervisor" || role === "manager"
      ? "reportsTo"
      : role === "wife" || role === "husband" || role === "spouse" || role === "partner"
        ? "spouseOf"
        : role === "son" || role === "daughter" || role === "kid" || role === "child"
          ? "parentOf"
          : null;
  if (predicate) {
    const edges = provider.sqlite.edgesFrom(userDid).filter((e) => e.predicate === predicate);
    for (const e of edges) {
      const row = provider.sqlite.getRecord(e.target_id);
      if (row?.name) return { id: row.id, name: row.name };
    }
  }
  // Fallback: Person whose summary mentions the role
  for (const row of provider.sqlite.listByType("Entity", 80)) {
    const rev = await provider.packages.readCurrent(row.logical_id);
    const desc = String(rev?.schema?.description ?? rev?.text ?? "");
    if (desc.toLowerCase().includes(`user's ${role}`)) {
      return { id: row.id, name: row.name ?? row.logical_id };
    }
  }
  return null;
}

async function upsertNamedEntity(
  provider: OipLocalMemoryProvider,
  name: string,
  summary: string | undefined,
  now: string,
  entityClass = "Person",
  contact: { email?: string; telephone?: string; birthDate?: string } = {},
): Promise<string> {
  const findExisting = (): string | null => {
    const hits = provider.sqlite.findByName(name, "Entity");
    const needle = name.toLowerCase();
    // findByName also matches search_text substrings — only accept exact labels here.
    const exact = hits.filter((r) => (r.name ?? "").toLowerCase() === needle);
    if (exact.length) {
      const typed = exact.find((r) => {
        const st = r.schema_type ?? "";
        if (entityClass === "Organization") return st.includes("Organization");
        if (entityClass === "Place") return st.includes("Place");
        if (
          entityClass === "Thing" ||
          entityClass === "CreativeWork" ||
          entityClass === "Project" ||
          entityClass === "Product"
        ) {
          // Prefer non-person/org exact matches (Project, CreativeWork, Thing, …)
          return (
            !st.includes("Person") &&
            !st.includes("Organization") &&
            !st.includes("Place")
          );
        }
        if (entityClass === "Person") {
          return st.includes("Person") || (!st.includes("Organization") && !st.includes("Place"));
        }
        return true;
      });
      // Prefer typed match; never fall back to Collection when asking for Organization
      if (typed) return typed.id;
      if (entityClass === "Organization") return null;
      // Thing/Project: any exact-name entity (OIP may already be typed Project)
      if (
        entityClass === "Thing" ||
        entityClass === "CreativeWork" ||
        entityClass === "Project" ||
        entityClass === "Product"
      ) {
        return exact[0]!.id;
      }
      return exact[0]!.id;
    }
    // Person only: allow "James" → "James Nosal"
    if (entityClass !== "Person") return null;
    const first = name.split(/\s+/)[0]!;
    if (first.length < 3) return null;
    const prefixHits = provider.sqlite
      .findByName(first, "Entity")
      .filter((r) => {
        const n = (r.name ?? "").toLowerCase();
        return n === needle || n.startsWith(needle + " ") || needle.startsWith(n + " ");
      })
      .filter((r) => {
        const st = r.schema_type ?? "";
        return st.includes("Person") || (!st.includes("Organization") && !st.includes("Place"));
      });
    return prefixHits[0]?.id ?? null;
  };

  const schemaType =
    entityClass === "Organization"
      ? SCHEMA_ORG.Organization
      : entityClass === "Place"
        ? SCHEMA_ORG.Place
        : entityClass === "Thing" ||
            entityClass === "CreativeWork" ||
            entityClass === "Project" ||
            entityClass === "Product"
          ? SCHEMA_ORG.CreativeWork
          : SCHEMA_ORG.Person;

  const baseSchema =
    entityClass === "Organization"
      ? { "@type": "Organization", name }
      : entityClass === "Place"
        ? { "@type": "Place", name }
        : entityClass === "Thing" ||
            entityClass === "CreativeWork" ||
            entityClass === "Project" ||
            entityClass === "Product"
          ? { "@type": "CreativeWork", name }
          : schemaOrgPerson(name);

  const existingId = findExisting();
  if (existingId) {
    if (summary || contact.email || contact.telephone || contact.birthDate) {
      const logicalId = existingId.replace(/^did:memory:/, "").split("#")[0]!;
      const current = await provider.packages.readCurrent(logicalId);
      if (current) {
        const schema = { ...(current.schema ?? {}) } as Record<string, unknown>;
        if (summary && !schema.description) schema.description = summary;
        if (contact.email) schema.email = contact.email;
        if (contact.telephone) schema.telephone = contact.telephone;
        if (contact.birthDate) schema.birthDate = contact.birthDate;
        const patch: Record<string, unknown> = {
          schema,
          updatedAt: now,
          provenance: {
            ...(current.provenance ?? {}),
            sourceType: "conversation_extraction",
            learnedAt: now,
            extractionMethod: "conversational_memory",
          },
        };
        // Keep a short searchable note in text when contact/personal details change
        if (contact.email || contact.telephone || contact.birthDate) {
          const bits = [
            typeof schema.description === "string" ? schema.description : null,
            contact.email ? `email ${contact.email}` : null,
            contact.telephone ? `phone ${contact.telephone}` : null,
            contact.birthDate
              ? `birthday ${contact.birthDate}`
              : null,
          ].filter(Boolean);
          patch.text = bits.join("; ");
        }
        await provider.updateRecord(logicalId, patch, { reindex: false });
      }
    }
    return existingId;
  }

  const record = await provider.createRecord(
    "Entity",
    {
      name,
      schemaType,
      schema: {
        ...baseSchema,
        ...(summary ? { description: summary } : {}),
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.telephone ? { telephone: contact.telephone } : {}),
        ...(contact.birthDate ? { birthDate: contact.birthDate } : {}),
      },
      text:
        [
          summary,
          contact.email ? `email ${contact.email}` : null,
          contact.telephone ? `phone ${contact.telephone}` : null,
          contact.birthDate ? `birthday ${contact.birthDate}` : null,
        ]
          .filter(Boolean)
          .join("; ") || undefined,
      alfred: {
        entityClass,
        confidence: 0.9,
        confidenceLabel: "confirmed",
        visibility: "private",
      },
      learnedAt: now,
      provenance: {
        sourceType: "conversation_extraction",
        learnedAt: now,
        extractionMethod: "conversational_memory",
      },
    },
    undefined,
    { reindex: false },
  );
  return record.id;
}

function cleanPhrase(s: string): string {
  return s
    .trim()
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseName(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

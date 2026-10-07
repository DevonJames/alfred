export type ReminderAccess = "none" | "read" | "write";

export interface DiscoveredList {
  id: string;
  title: string;
  color: string | null;
  writable: boolean;
  sourceIdentifier: string;
  sourceTitle: string;
  sourceType: string;
}

export interface ReminderGrant {
  access: ReminderAccess;
  title: string;
  sourceIdentifier: string;
  sourceTitle: string;
}

export interface ReminderPolicy {
  version: 1;
  lists: Record<string, ReminderGrant>;
}

export interface ReminderListRow extends DiscoveredList {
  access: ReminderAccess;
  writeEnabled: boolean;
}

export interface ReminderSourceGroup {
  sourceIdentifier: string;
  sourceTitle: string;
  sourceType: string;
  lists: ReminderListRow[];
}

export function emptyPolicy(): ReminderPolicy {
  return { version: 1, lists: {} };
}

export function isReminderAccess(value: unknown): value is ReminderAccess {
  return value === "none" || value === "read" || value === "write";
}

function grantKey(sourceIdentifier: string, title: string): string {
  return `${sourceIdentifier}\0${title}`;
}

/** A list that has never been chosen stays at No Access. Write drops to Read when EventKit forbids edits. */
export function mergeReminderAccess(
  discovered: DiscoveredList[],
  policy: ReminderPolicy | null | undefined,
): { sources: ReminderSourceGroup[]; grants: Record<string, ReminderGrant> } {
  const stored = policy?.lists ?? {};
  const byFallback = new Map<string, ReminderGrant>();
  for (const grant of Object.values(stored)) {
    if (!grant || !isReminderAccess(grant.access)) continue;
    byFallback.set(grantKey(grant.sourceIdentifier, grant.title), grant);
  }

  const groups = new Map<string, ReminderSourceGroup>();
  const grants: Record<string, ReminderGrant> = { ...stored };

  for (const list of discovered) {
    const direct = stored[list.id];
    const fallback = byFallback.get(grantKey(list.sourceIdentifier, list.title));
    const matched = direct && isReminderAccess(direct.access) ? direct : fallback;
    let access: ReminderAccess = matched && isReminderAccess(matched.access) ? matched.access : "none";
    if (access === "write" && !list.writable) access = "read";

    const row: ReminderListRow = {
      ...list,
      color: list.color ?? null,
      access,
      writeEnabled: list.writable,
    };
    const group = groups.get(list.sourceIdentifier) ?? {
      sourceIdentifier: list.sourceIdentifier,
      sourceTitle: list.sourceTitle,
      sourceType: list.sourceType,
      lists: [],
    };
    group.lists.push(row);
    groups.set(list.sourceIdentifier, group);
    grants[list.id] = {
      access,
      title: list.title,
      sourceIdentifier: list.sourceIdentifier,
      sourceTitle: list.sourceTitle,
    };
  }

  return {
    sources: [...groups.values()].sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle)),
    grants,
  };
}

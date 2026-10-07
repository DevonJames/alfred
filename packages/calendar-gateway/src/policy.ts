export type CalendarAccess = "none" | "read" | "write";

export interface DiscoveredCalendar {
  id: string;
  title: string;
  color: string | null;
  writable: boolean;
  sourceIdentifier: string;
  sourceTitle: string;
  sourceType: string;
}

export interface CalendarGrant {
  access: CalendarAccess;
  title: string;
  sourceIdentifier: string;
  sourceTitle: string;
  /** Events stay on the agenda and do not count as conflicts when placing a reminder. */
  ignoreOverlaps?: boolean;
}

export interface CalendarPolicy {
  version: 1;
  calendars: Record<string, CalendarGrant>;
}

export interface CalendarRow extends DiscoveredCalendar {
  access: CalendarAccess;
  writeEnabled: boolean;
  ignoreOverlaps: boolean;
}

export interface CalendarSourceGroup {
  sourceIdentifier: string;
  sourceTitle: string;
  sourceType: string;
  calendars: CalendarRow[];
}

export function emptyPolicy(): CalendarPolicy {
  return { version: 1, calendars: {} };
}

export function isCalendarAccess(value: unknown): value is CalendarAccess {
  return value === "none" || value === "read" || value === "write";
}

function grantKey(sourceIdentifier: string, title: string): string {
  return `${sourceIdentifier}\0${title}`;
}

/**
 * Match a saved grant by EventKit id, then by account id plus title.
 * A calendar that has never been chosen stays at No Access.
 * Write is coerced to Read when EventKit says the calendar cannot be modified.
 */
export function mergeCalendarAccess(
  discovered: DiscoveredCalendar[],
  policy: CalendarPolicy | null | undefined,
): { sources: CalendarSourceGroup[]; grants: Record<string, CalendarGrant> } {
  const stored = policy?.calendars ?? {};
  const byFallback = new Map<string, CalendarGrant>();
  for (const grant of Object.values(stored)) {
    if (!grant || !isCalendarAccess(grant.access)) continue;
    byFallback.set(grantKey(grant.sourceIdentifier, grant.title), grant);
  }

  const groups = new Map<string, CalendarSourceGroup>();
  const grants: Record<string, CalendarGrant> = { ...stored };

  for (const calendar of discovered) {
    const direct = stored[calendar.id];
    const fallback = byFallback.get(grantKey(calendar.sourceIdentifier, calendar.title));
    const matched = direct && isCalendarAccess(direct.access) ? direct : fallback;
    let access: CalendarAccess = matched && isCalendarAccess(matched.access) ? matched.access : "none";
    if (access === "write" && !calendar.writable) access = "read";

    const ignoreOverlaps = matched?.ignoreOverlaps === true;
    const row: CalendarRow = {
      ...calendar,
      color: calendar.color ?? null,
      access,
      writeEnabled: calendar.writable,
      ignoreOverlaps,
    };
    const existing = groups.get(calendar.sourceIdentifier);
    if (existing) {
      existing.calendars.push(row);
    } else {
      groups.set(calendar.sourceIdentifier, {
        sourceIdentifier: calendar.sourceIdentifier,
        sourceTitle: calendar.sourceTitle,
        sourceType: calendar.sourceType,
        calendars: [row],
      });
    }
    grants[calendar.id] = {
      access,
      title: calendar.title,
      sourceIdentifier: calendar.sourceIdentifier,
      sourceTitle: calendar.sourceTitle,
      ignoreOverlaps,
    };
  }

  return { sources: [...groups.values()], grants };
}

export function readableCalendars(sources: CalendarSourceGroup[]): CalendarRow[] {
  return sources.flatMap((source) =>
    source.calendars.filter((calendar) => calendar.access === "read" || calendar.access === "write"),
  );
}

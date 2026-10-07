import { loadBriefingPrefs, type BriefingAgendaSlice } from "@alfred/briefing";
import { calendarPolicyPath, loadBriefingAgendaEvents } from "@alfred/calendar-gateway";

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

function agendaTimeZone(): string {
  return process.env.BRIEFING_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Today's events from the calendars checked under Settings → Briefing → Agenda. */
export async function agendaBriefingEvents(now: Date): Promise<BriefingAgendaSlice> {
  const prefs = await loadBriefingPrefs(profileId());
  if (!prefs.agendaCalendarIds.length) return { enabled: false, events: [] };
  const events = await loadBriefingAgendaEvents({
    policyPath: calendarPolicyPath(profileId()),
    calendarIds: prefs.agendaCalendarIds,
    now,
    timeZone: agendaTimeZone(),
  });
  return { enabled: true, events };
}

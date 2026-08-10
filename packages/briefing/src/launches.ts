import { speakClockTime, speakWeekday } from "./speech.js";

export interface LaunchInfo {
  name: string;
  mission: string;
  provider: string;
  rocket: string;
  location: string;
  net: string;
  status: string;
}

export async function fetchLaunches(locationIds = "11"): Promise<LaunchInfo[]> {
  try {
    const res = await fetch(
      `https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5&location__ids=${encodeURIComponent(locationIds)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        name?: string;
        net?: string;
        mission?: { name?: string };
        launch_service_provider?: { name?: string };
        rocket?: { configuration?: { name?: string } };
        pad?: { location?: { name?: string } };
        status?: { name?: string };
      }>;
    };
    return (data.results ?? []).map((l) => ({
      name: l.name ?? "Launch",
      mission: l.mission?.name ?? l.name ?? "Mission",
      provider: l.launch_service_provider?.name ?? "Unknown",
      rocket: l.rocket?.configuration?.name ?? "Rocket",
      location: l.pad?.location?.name ?? "Unknown",
      net: l.net ?? "",
      status: l.status?.name ?? "Status unknown",
    }));
  } catch {
    return [];
  }
}

export function formatLaunchesSpeech(launches: LaunchInfo[]): string {
  if (!launches.length) return "";
  // Keep speech brief: first upcoming launch with natural time phrasing.
  const l = launches[0]!;
  const provider = l.provider && l.provider !== "Unknown" ? l.provider : "";
  const name = l.mission || l.name;
  if (l.net) {
    const when = new Date(l.net);
    if (!Number.isNaN(when.getTime())) {
      const day = speakWeekday(when);
      const time = speakClockTime(when);
      const who = provider ? `a ${provider} launch` : "a launch";
      return `There's ${who}, ${name}, scheduled for ${day} at ${time}.`;
    }
  }
  const who = provider ? `a ${provider} launch` : "a launch";
  return `There's ${who} coming up: ${name}.`;
}

export function formatLaunchesMarkdown(launches: LaunchInfo[]): string {
  if (!launches.length) return "**Launches**\n\nNo upcoming launches found.";
  const body = launches
    .slice(0, 3)
    .map((l) => {
      const when = l.net
        ? new Date(l.net).toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "TBA";
      return `- **${l.mission}** (${l.provider}) — ${l.rocket} from ${l.location}, ${when} — ${l.status}`;
    })
    .join("\n");
  return `**Launches**\n\n${body}`;
}

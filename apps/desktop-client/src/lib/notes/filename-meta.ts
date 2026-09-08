/**
 * Turn a Voice Memos / Maps filename into location, people, and a subject title.
 * Filenames are not titles: Home 14 / Sunset Plaza / Sarah Chen are metadata.
 */

export type FilenameKind = "address" | "place" | "people" | "mixed" | "unknown";

export interface FilenameNoteMeta {
  kind: FilenameKind;
  location?: string;
  participants: string[];
}

export function stemFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function heuristicFilenameMeta(filename: string): FilenameNoteMeta {
  const stem = stemFromFilename(filename);
  if (!stem) return { kind: "unknown", participants: [] };

  const homeWork = stem.match(/^(home|work)\s*[-–]?\s*\d+$/i);
  if (homeWork) {
    const place = homeWork[1]![0]!.toUpperCase() + homeWork[1]!.slice(1).toLowerCase();
    return { kind: "place", location: place, participants: [] };
  }

  if (/^\d+\s+\S/.test(stem)) {
    return { kind: "address", location: stem.replace(/\s+\d+$/, "").trim() || stem, participants: [] };
  }

  if (
    /\b(plaza|place|park|center|centre|mall|market|airport|station|hospital|school|church|cafe|café|store|hotel|library|museum|beach|trail|garden|building|tower|square|commons|campus|office)\b/i.test(
      stem,
    )
  ) {
    return { kind: "place", location: stem.replace(/\s+\d+$/, "").trim(), participants: [] };
  }

  const peopleBits = stem
    .split(/\s*(?:,|&| and )\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    peopleBits.length >= 1 &&
    peopleBits.every((part) => /^[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)+$/.test(part))
  ) {
    return { kind: "people", participants: peopleBits };
  }

  return { kind: "unknown", participants: [] };
}

export function titleFromSummary(summary: string, fallback: string): string {
  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  const clipped = sentence.length > 80 ? `${sentence.slice(0, 77).trim()}…` : sentence;
  return clipped.replace(/[.]+$/, "").trim() || fallback;
}

export function uniqueNoteTitle(base: string, existing: string[], location?: string): string {
  const used = new Set(existing.map((name) => name.trim().toLowerCase()));
  const primary = base.trim() || "Audio note";
  if (!used.has(primary.toLowerCase())) return primary;
  if (location) {
    const withPlace = `${primary} (${location})`;
    if (!used.has(withPlace.toLowerCase())) return withPlace;
  }
  for (let n = 2; n < 50; n += 1) {
    const next = `${primary} (${n})`;
    if (!used.has(next.toLowerCase())) return next;
  }
  return `${primary} (${Date.now()})`;
}

function grokKey(): string | undefined {
  return process.env.GROK_API_KEY?.trim() || process.env.XAI_API_KEY?.trim() || undefined;
}

function openaiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

async function completeJson(prompt: string): Promise<Record<string, unknown> | null> {
  const grok = grokKey();
  const openai = openaiKey();
  const attempts = [
    grok
      ? {
          url: "https://api.x.ai/v1/chat/completions",
          apiKey: grok,
          model: process.env.ALFRED_NOTES_GROK_MODEL?.trim() || "grok-4-fast-reasoning",
        }
      : null,
    openai
      ? {
          url: "https://api.openai.com/v1/chat/completions",
          apiKey: openai,
          model: process.env.ALFRED_NOTES_OPENAI_MODEL?.trim() || "gpt-4o",
        }
      : null,
  ].filter(Boolean) as Array<{ url: string; apiKey: string; model: string }>;

  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attempt.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: attempt.model,
          temperature: 0,
          messages: [
            { role: "system", content: "Return only valid JSON. No markdown." },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = payload.choices?.[0]?.message?.content?.trim() ?? "";
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) continue;
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch (err) {
      console.warn("[notes] filename classify failed:", err);
    }
  }
  return null;
}

export async function resolveFolderNoteNames(opts: {
  filename: string;
  summary: string;
  existingTitles?: string[];
  sidecar?: { title?: string; attendees?: string[]; location?: string };
}): Promise<{ title: string; location?: string; participants: string[] }> {
  const stem = stemFromFilename(opts.filename);
  const guessed = heuristicFilenameMeta(opts.filename);
  const fallbackTitle = titleFromSummary(opts.summary, stem || "Audio note");

  if (opts.sidecar?.title?.trim()) {
    return {
      title: uniqueNoteTitle(opts.sidecar.title.trim(), opts.existingTitles ?? [], opts.sidecar.location ?? guessed.location),
      location: opts.sidecar.location?.trim() || guessed.location,
      participants: [
        ...new Set([...(opts.sidecar.attendees ?? []), ...guessed.participants].map((n) => n.trim()).filter(Boolean)),
      ],
    };
  }

  const parsed = await completeJson(`Classify this voice-memo filename and name the note from the summary.

Filename: ${stem}
Summary: ${opts.summary || "(none)"}

Rules:
- Filenames are NOT titles. They are usually a place or the people in the meeting.
- Addresses look like a number then a street ("123 Oak St").
- Home/Work plus a number ("Home 14", "Work 3") is the place Home or Work. Drop the sequence number.
- Apple Maps / POI labels ("Sunset Plaza", "Whole Foods", "LAX") are PLACES, not people. Prefer place over person.
- People's names become participants, never the title.
- Title = short unique name for the primary subject of the summary (not the filename).
- If mixed ("Sunset Plaza - Sarah"), keep both location and participants.

Return JSON:
{
  "kind": "address" | "place" | "people" | "mixed" | "unknown",
  "location": "place or address or empty",
  "participants": ["Name"],
  "title": "subject title from the summary"
}`);

  const location =
    (typeof parsed?.location === "string" && parsed.location.trim() && parsed.location.trim().toLowerCase() !== "empty"
      ? parsed.location.trim()
      : guessed.location) || undefined;
  const fromLlm = Array.isArray(parsed?.participants)
    ? parsed!.participants.map((n) => String(n).trim()).filter(Boolean)
    : [];
  const participants = [...new Set([...fromLlm, ...guessed.participants])];
  const titleRaw =
    (typeof parsed?.title === "string" && parsed.title.trim()) || fallbackTitle;
  return {
    title: uniqueNoteTitle(titleRaw, opts.existingTitles ?? [], location),
    location,
    participants,
  };
}

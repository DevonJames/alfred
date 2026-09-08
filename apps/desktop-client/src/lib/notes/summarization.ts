import {
  AUDIO_NOTE_TEMPLATES,
  emptyAudioNoteMetadata,
  type AudioNoteMetadata,
  type AudioNoteTemplate,
} from "@alfred/memory";

const GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

function grokKey(): string | undefined {
  return process.env.GROK_API_KEY?.trim() || process.env.XAI_API_KEY?.trim() || undefined;
}

function openaiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function splitTranscriptForSummary(text: string, maxChars = 24_000): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];
  const parts: string[] = [];
  let remaining = cleaned;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf(" "));
    const cut = breakAt > maxChars * 0.6 ? breakAt + 1 : maxChars;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function buildPrompt(
  text: string,
  noteType: string,
  participants: string[] = [],
): string {
  const participantsList = participants.length > 0 ? participants.join(", ") : "unknown";
  let typeSpecificInstructions = "";
  switch (noteType) {
    case "meeting":
      typeSpecificInstructions = `This is a meeting transcript with participants: ${participantsList}.
Focus on key discussion points, decisions, action items, and open questions.`;
      break;
    case "brainstorm":
      typeSpecificInstructions = `This is a brainstorming session with: ${participantsList}.
Focus on ideas, themes, viable next steps, and questions to explore.`;
      break;
    case "checkin":
      typeSpecificInstructions = `This is a check-in conversation with: ${participantsList}.
Focus on status updates, blockers, help needed, and follow-up items.`;
      break;
    default:
      typeSpecificInstructions = `This is a personal ${noteType} note.
Focus on core ideas, insights, questions, and potential next steps.`;
  }

  return `Please analyze the following transcript and provide a structured summary.

${typeSpecificInstructions}

FORMAT YOUR RESPONSE AS A JSON OBJECT WITH THIS EXACT STRUCTURE:
{
  "summary": "A 2-3 sentence executive summary of the conversation",
  "takeaways": ["key point 1", "key point 2", "key point 3"],
  "nextSteps": [
    {"text": "action item description", "assignee": "person name or null", "dueDate": "due date or null"}
  ],
  "openQuestions": ["unresolved question 1"],
  "attendees": ["attendee 1"],
  "template": "meeting" | "brainstorm" | "checkin" | "freeform"
}

IMPORTANT:
- Return ONLY valid JSON, no other text
- summary should be 2-3 sentences max
- takeaways should be 3-5 key points (more if appropriate)
- nextSteps are action items with optional assignee and dueDate (YYYY-MM-DD or null)
- attendees should list people mentioned or present (can be empty)
- template should match the type of conversation

TRANSCRIPT:
${text}

JSON RESPONSE:`;
}

export function parseNoteSummary(summaryText: string, fallbackTemplate: AudioNoteTemplate = "freeform"): AudioNoteMetadata {
  try {
    const jsonMatch = summaryText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return emptyAudioNoteMetadata(fallbackTemplate);
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    let template: AudioNoteTemplate = fallbackTemplate;
    if (typeof parsed.template === "string") {
      const t = parsed.template.toLowerCase();
      if ((AUDIO_NOTE_TEMPLATES as readonly string[]).includes(t)) {
        template = t as AudioNoteTemplate;
      }
    }

    const nextSteps = Array.isArray(parsed.nextSteps)
      ? parsed.nextSteps
          .map((step: unknown) => {
            if (typeof step === "string") return { text: step };
            if (step && typeof step === "object") {
              const s = step as Record<string, unknown>;
              return {
                text: String(s.text || s.action || s.description || s.task || ""),
                assignee: s.assignee ? String(s.assignee) : undefined,
                dueDate: s.dueDate ? String(s.dueDate) : undefined,
              };
            }
            return { text: "" };
          })
          .filter((s) => s.text.trim())
      : [];

    return {
      summary: String(parsed.summary || ""),
      takeaways: Array.isArray(parsed.takeaways) ? parsed.takeaways.map((t) => String(t)) : [],
      nextSteps,
      openQuestions: Array.isArray(parsed.openQuestions)
        ? parsed.openQuestions.map((q) => String(q))
        : [],
      attendees: Array.isArray(parsed.attendees) ? parsed.attendees.map((a) => String(a)) : [],
      template,
    };
  } catch {
    return emptyAudioNoteMetadata(fallbackTemplate);
  }
}

async function completeChat(opts: {
  url: string;
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that summarizes meeting notes. Return only valid JSON.",
        },
        { role: "user", content: opts.prompt },
      ],
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!res.ok) {
    throw new Error(payload.error?.message || `Summarization failed: ${res.status}`);
  }
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Summarization returned an empty response");
  return text;
}

export async function summarizeAudioNote(opts: {
  text: string;
  noteType: string;
  participants?: string[];
}): Promise<AudioNoteMetadata> {
  const fallback = (AUDIO_NOTE_TEMPLATES as readonly string[]).includes(opts.noteType)
    ? (opts.noteType as AudioNoteTemplate)
    : "freeform";
  if (!opts.text.trim()) return emptyAudioNoteMetadata(fallback);

  const sections = splitTranscriptForSummary(opts.text);
  if (sections.length > 1) {
    const partials: AudioNoteMetadata[] = [];
    for (const [index, section] of sections.entries()) {
      const part = await summarizeOnce({
        text: `Part ${index + 1} of ${sections.length}:\n\n${section}`,
        noteType: opts.noteType,
        participants: opts.participants,
        fallback,
      });
      if (part.summary || part.takeaways.length) partials.push(part);
    }
    if (partials.length === 1) return partials[0]!;
    if (partials.length > 1) {
      const merged = [
        ...partials.map((part, index) => `Part ${index + 1} summary: ${part.summary}`),
        `Takeaways: ${partials.flatMap((part) => part.takeaways).join(" | ")}`,
        `Actions: ${partials.flatMap((part) => part.nextSteps.map((s) => s.text)).join(" | ")}`,
        `Questions: ${partials.flatMap((part) => part.openQuestions).join(" | ")}`,
        `Attendees: ${[...new Set(partials.flatMap((part) => part.attendees))].join(", ")}`,
      ].join("\n");
      return summarizeOnce({
        text: merged,
        noteType: opts.noteType,
        participants: opts.participants,
        fallback,
      });
    }
  }

  return summarizeOnce({
    text: opts.text,
    noteType: opts.noteType,
    participants: opts.participants,
    fallback,
  });
}

async function summarizeOnce(opts: {
  text: string;
  noteType: string;
  participants?: string[];
  fallback: AudioNoteTemplate;
}): Promise<AudioNoteMetadata> {
  const prompt = buildPrompt(opts.text, opts.noteType, opts.participants ?? []);
  const grok = grokKey();
  const openai = openaiKey();
  const grokModel = process.env.ALFRED_NOTES_GROK_MODEL?.trim() || "grok-4-fast-reasoning";
  const openaiModel = process.env.ALFRED_NOTES_OPENAI_MODEL?.trim() || "gpt-4o";

  try {
    if (grok) {
      const raw = await completeChat({
        url: GROK_API_URL,
        apiKey: grok,
        model: grokModel,
        prompt,
      });
      return parseNoteSummary(raw, opts.fallback);
    }
    if (openai) {
      const raw = await completeChat({
        url: OPENAI_API_URL,
        apiKey: openai,
        model: openaiModel,
        prompt,
      });
      return parseNoteSummary(raw, opts.fallback);
    }
  } catch (err) {
    console.error("[notes] summarization failed:", err);
    if (grok && openai) {
      try {
        const raw = await completeChat({
          url: OPENAI_API_URL,
          apiKey: openai,
          model: openaiModel,
          prompt,
        });
        return parseNoteSummary(raw, opts.fallback);
      } catch (err2) {
        console.error("[notes] summarization fallback failed:", err2);
      }
    }
  }

  return {
    ...emptyAudioNoteMetadata(opts.fallback),
    summary: opts.text.trim().slice(0, 280),
  };
}

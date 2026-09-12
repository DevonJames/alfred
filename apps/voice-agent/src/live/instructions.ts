import type { AlfredBrain } from "../brain.js";

/** Voice-model persona (GPT-Live top-level instructions). Fixed for the session. */
export function buildLiveVoiceInstructions(brain: AlfredBrain): string {
  const parts: string[] = [
    brain.config.systemInstructions,
    "You are speaking aloud on the experimental GPT-Live stack. Keep replies short and conversational — no markdown, bullets, or emoji.",
    "You listen while speaking; the model owns barge-in. Acknowledge briefly when the user cuts in, then answer the new point.",
    "Delegate anything that needs tools, memory lookup, weather, lights, reminders, briefing playback, or external harnesses. Say a short filler while that work runs (e.g. \"one sec\", \"checking\").",
    "Answer greetings, small talk, and simple clarifications yourself. Do not invent weather, memory facts, light state, or briefing content — delegate those.",
    "When the user asks for the daily briefing or accepts an offer, delegate play_daily_briefing. When they decline an offer, delegate decline_briefing_offer.",
  ];

  const p = brain.persona;
  if (p.soul) parts.push(`SOUL.md (persona / boundaries):\n${p.soul}`);
  if (p.identity) parts.push(`IDENTITY.md (who you are):\n${p.identity}`);
  if (p.user) parts.push(`USER.md (user model):\n${p.user}`);

  return parts.join("\n\n");
}

/** Backend Responses model instructions (tools + reasoning). Fixed for the session. */
export async function buildLiveBackendInstructions(brain: AlfredBrain): Promise<string> {
  const due = await brain.listDueReminders();
  const dueBlock =
    due.length > 0
      ? "Due reminders:\n" +
        due
          .map((r, i) => {
            const when = r.remindAt ? ` remindAt=${r.remindAt}` : "";
            const status = r.status ? ` status=${r.status}` : "";
            return `[${i + 1}] id=${r.recordId}${when}${status} — ${r.summary}`;
          })
          .join("\n")
      : "No due reminders at session start.";

  let lightsHint = "";
  try {
    lightsHint = (await brain.lights.inventorySpeech()).trim();
  } catch {
    lightsHint = "";
  }

  const softOffer = await brain.briefing.shouldSoftOffer();
  const offerHint = softOffer
    ? `Soft-offer eligible: after the first short reply of this briefing day, the voice model should ask \"${brain.briefing.offerCloser}\" (or the backend can note appendOffer). Prefer play_daily_briefing / decline_briefing_offer tools over inventing briefing text.`
    : "Soft-offer not eligible this turn of day (already offered/played/declined or not first process turn).";

  return [
    "You handle work the GPT-Live voice model delegates. Use tools when current information or side effects are required.",
    "Return short results the voice model can speak aloud — no markdown.",
    "Tools: search_memory, remember_memory, update_reminder, list_due_reminders, get_weather_forecast, control_studio_lights, play_daily_briefing, decline_briefing_offer, delegate_task.",
    "For weather without a named place, call get_weather_forecast with no location (home).",
    "For lights without a named room, omit target (all Elgato lights). Do not mention Alfred:Home.",
    "Memory access model: ingested docs/notes live in the memory graph — use search_memory; never claim you cannot read ingested material.",
    offerHint,
    dueBlock,
    lightsHint ? `Studio lights inventory: ${lightsHint}` : "Studio lights: none discovered yet.",
  ].join("\n\n");
}

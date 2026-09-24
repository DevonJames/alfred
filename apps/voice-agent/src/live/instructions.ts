import type { AlfredBrain } from "../brain.js";

/** Voice-model persona (GPT-Live top-level instructions). Fixed for the session. */
export function buildLiveVoiceInstructions(brain: AlfredBrain): string {
  const parts: string[] = [
    brain.config.systemInstructions,
    "You are speaking aloud on the experimental GPT-Live stack. Keep replies short and conversational — no markdown, bullets, or emoji.",
    "You listen while speaking; the model owns barge-in. Acknowledge briefly when the user cuts in, then answer the new point.",
    "Delegate anything that needs tools, memory lookup, weather, lights, reminders, briefing playback, robot expressions, or external harnesses. Say a short filler while that work runs (e.g. \"one sec\", \"checking\").",
    "When speaking from the robot, use show_expression for a smile, frown, wink, nod, tilt, or wave that matches the turn. Do not emote on every sentence. Never perform angry as aggressive motion.",
    "Answer greetings, small talk, and simple clarifications yourself. Do not invent the time, weather, weather alerts, earthquakes, space weather, wildfires, exchange rates, Hacker News stories, news headlines, crypto or metals prices, memory facts, light state, or briefing content — delegate those.",
    "When the user asks you to remember something lasting (people, nicknames, handles, facts), delegate remember_memory. Do not only say you will remember — the tool write is required.",
    "When the user asks for the daily briefing or accepts an offer, delegate play_daily_briefing. When they decline an offer, delegate decline_briefing_offer.",
    "When the user asks what's in the news or for headlines, delegate get_news_headlines. When they ask to dig into one of those headlines, delegate summarize_news_article.",
    "When the user asks what time it is or for today's date, delegate get_current_time. Omit place for home.",
    "When the user asks about earthquakes, delegate get_earthquakes. For severe weather warnings or advisories, delegate get_weather_alerts, not the forecast. For geomagnetic storms or aurora, delegate get_space_weather. For wildfires or volcanoes, delegate get_natural_events. For currency conversion, delegate get_exchange_rate. For Hacker News or what developers are talking about, delegate get_hacker_news.",
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
    "Tools: search_memory, remember_memory, update_reminder, list_due_reminders, get_current_time, get_weather_forecast, get_weather_alerts, get_earthquakes, get_space_weather, get_natural_events, get_exchange_rate, get_hacker_news, get_news_headlines, summarize_news_article, get_crypto_price, get_metals_price, control_studio_lights, play_daily_briefing, decline_briefing_offer, show_expression, delegate_task.",
    "show_expression drives AlfredBot's face (smile, frown, wink, curious, …) and optional body cues (nod, tilt, wave). The robot times out to calm. Skip it when the user is on phone or desktop only if you are unsure a robot is in the room — calling it is harmless.",
    "For the current time or today's date, call get_current_time. Omit place for home.",
    "For weather without a named place, call get_weather_forecast with no location (home).",
    "For news headlines, call get_news_headlines. For follow-ups like 'the second one' or 'tell me more about that story' after headlines or the daily briefing, call summarize_news_article with index or match.",
    "For Bitcoin/crypto prices, call get_crypto_price. For gold or silver, call get_metals_price.",
    "For earthquakes, call get_earthquakes. For severe weather alerts, call get_weather_alerts with no location for home. For geomagnetic storms or aurora, call get_space_weather. For wildfires or volcanoes, call get_natural_events. For euros, yen, or other currency conversion, call get_exchange_rate. For Hacker News, call get_hacker_news.",
    "For lights without a named room, omit target (all Elgato lights). Do not mention Alfred:Home.",
    "Memory access model: ingested docs/notes live in the memory graph — use search_memory; never claim you cannot read ingested material.",
    "When the user asks you to remember a person, nickname, handle, meeting plan, or lasting fact, you MUST call remember_memory before confirming. Verbal acknowledgment alone does not store anything. Prefer Person entities, nicknames/aliases in summary, and clear assertions (e.g. describedAs, alsoKnownAs, friendOf, worksAt).",
    "Never invent memory. If search_memory returns nothing, say you do not have it stored — then offer to remember it now via remember_memory.",
    offerHint,
    dueBlock,
    lightsHint ? `Studio lights inventory: ${lightsHint}` : "Studio lights: none discovered yet.",
  ].join("\n\n");
}

import type { StudioLightCommand } from "./ports.js";

const LIGHT_NOUN =
  /\b(lights?|lighting|key\s+lights?|elgato|lamp|lamps)\b/i;
const ROOM_OR_NAME =
  /\b(bedroom|living\s+room(?:\s*[12])?|studio|desk|mini|key\s+light(?:\s+mini)?)\b/i;
const TALKING_ABOUT_TOOL = /\bcontrol[_\s-]*studio[_\s-]*lights\b/i;

export function looksLikeStudioLightsTask(text: string): boolean {
  return parseStudioLightIntent(text) != null;
}

/**
 * Deterministic light control from casual speech.
 * Returns null when the utterance is not a lighting command.
 */
export function parseStudioLightIntent(text: string): StudioLightCommand | null {
  const raw = text.trim();
  if (!raw || TALKING_ABOUT_TOOL.test(raw)) return null;

  if (isDefaultLightsScene(raw)) {
    return { action: "set", brightness: 100, temperature: "white" };
  }

  const brightness = extractBrightness(raw);
  const temperature = extractTemperature(raw);
  const hasLightNoun = LIGHT_NOUN.test(raw);
  const hasRoom = ROOM_OR_NAME.test(raw);
  const hasDeixis = /\b(all(\s+of\s+them)?|everything|them|those|these)\b/i.test(raw);
  const hasPowerVerb =
    /\b(turn|switch|shut|cut|kill|power|dim|brighten|warmer|cooler|brighter|dimmer|set|make|put)\b/i.test(
      raw,
    );
  const looksLikeLevel = brightness != null && (temperature != null || hasDeixis || hasLightNoun);
  if (!hasLightNoun && !hasRoom && !(hasDeixis && (hasPowerVerb || brightness != null)) && !looksLikeLevel) {
    return null;
  }

  const target = extractTarget(raw);
  const action = extractAction(raw, brightness, temperature);
  if (!action) return null;

  return { action, target, brightness, temperature };
}

function extractTarget(text: string): string | undefined {
  if (/\b(all(\s+of\s+them)?|everything|every\s+light)\b/i.test(text)) return undefined;
  const room = text.match(ROOM_OR_NAME)?.[0];
  return room?.replace(/\s+/g, " ").trim();
}

const ONES: Record<string, number> = {
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

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function parseSpokenNumber(words: string): number | undefined {
  const parts = words.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return undefined;
  if (parts.length === 1 && parts[0] === "hundred") return 100;
  if (parts[0] === "a" && parts[1] === "hundred") return 100;
  if (parts[0] && parts[0] in ONES && parts.length === 1) return ONES[parts[0]];
  if (parts[0] && parts[0] in TENS) {
    const tens = TENS[parts[0]]!;
    if (parts.length === 1) return tens;
    if (parts[1] && parts[1] in ONES) return tens + ONES[parts[1]]!;
  }
  return undefined;
}

function extractBrightness(text: string): number | undefined {
  const digit = text.match(/\b(\d{1,3})\s*(?:percent|%|brightness)\b/i) ?? text.match(/\b(\d{1,3})\s*%/);
  if (digit) {
    const value = Number(digit[1]);
    if (Number.isFinite(value)) return Math.min(100, Math.max(0, value));
  }
  const spoken = text.match(
    /\b((?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+(?:one|two|three|four|five|six|seven|eight|nine))?|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|ten|hundred|a hundred|zero|one|two|three|four|five|six|seven|eight|nine)\s*(?:percent|%|brightness)\b/i,
  );
  if (spoken) {
    const value = parseSpokenNumber(spoken[1]!);
    if (value != null) return Math.min(100, Math.max(0, value));
  }
  return undefined;
}

function extractTemperature(text: string): string | undefined {
  if (/\b(warmer|warm(?:th)?)\b/i.test(text)) return "warm";
  if (/\b(white|cooler|cool(?:er)?|cold)\b/i.test(text)) return "cool";
  if (/\b(neutral|daylight)\b/i.test(text)) return "neutral";
  return undefined;
}

/** Bare "Lights" (plus wake-word / please) → full brightness, cool white. */
function isDefaultLightsScene(text: string): boolean {
  const stripped = text
    .toLowerCase()
    .replace(/[.!?,;:'"]+/g, " ")
    .replace(/\b(hey|hi|ok|okay|please|thanks|thank you|alfred)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(the\s+|all\s+)?lights?$/.test(stripped);
}

function extractAction(
  text: string,
  brightness: number | undefined,
  temperature: string | undefined,
): StudioLightCommand["action"] | null {
  if (/\b(turn|switch|shut|cut|kill|power)\b[\s\S]{0,24}\boff\b/i.test(text) || /\blights?\s+off\b/i.test(text)) {
    return "off";
  }
  // "down to thirty percent" is an absolute level, not a relative dim.
  if (brightness != null) return "set";
  if (/\b(dimmer|dim(?:\s+them|\s+it|\s+the\s+lights?)?|lights?\s+down|turn(?:\s+\w+){0,3}\s+down)\b/i.test(text)) {
    return brightness != null || temperature != null ? "set" : "dimmer";
  }
  if (/\b(brighter|lights?\s+up|turn(?:\s+\w+){0,3}\s+up|brighten)\b/i.test(text)) {
    return brightness != null || temperature != null ? "set" : "brighter";
  }
  if (/\bwarmer\b/i.test(text) && !/\bturn\b[\s\S]{0,16}\bon\b/i.test(text)) {
    return "warmer";
  }
  if (/\bcooler\b/i.test(text) && !/\bturn\b[\s\S]{0,16}\bon\b/i.test(text)) {
    return "cooler";
  }
  if (/\b(turn|switch|power)\b[\s\S]{0,24}\bon\b/i.test(text) || /\blights?\s+on\b/i.test(text)) {
    return brightness != null || temperature != null ? "set" : "on";
  }
  if (brightness != null || (temperature != null && hasSetCue(text))) {
    return "set";
  }
  return null;
}

function hasSetCue(text: string): boolean {
  return /\b(set|make|put)\b/i.test(text) || /\bat\s+\d/.test(text);
}

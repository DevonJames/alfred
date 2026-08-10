/**
 * Code-driven spoken-language helpers for Daily Briefing TTS.
 * Screen/markdown formatters stay separate; speech must never rely on "$", "%", day abbrs, etc.
 */

const DAY_FULL: Record<string, string> = {
  Sun: "Sunday",
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sunday: "Sunday",
  Monday: "Monday",
  Tuesday: "Tuesday",
  Wednesday: "Wednesday",
  Thursday: "Thursday",
  Friday: "Friday",
  Saturday: "Saturday",
};

function localHourMinuteAmPm(
  date: Date,
  timezone?: string,
): { hour: number; minute: number; ampm: string } {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  if (timezone) opts.timeZone = timezone;
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const dayPeriod = (parts.find((p) => p.type === "dayPeriod")?.value ?? "AM").toUpperCase();
  return { hour, minute, ampm: dayPeriod.toLowerCase() };
}

/** Speak a clock time: noon, midnight, "3 PM", "3 thirty PM", "3 15 PM". */
export function speakClockTime(date: Date, timezone?: string): string {
  const { hour, minute, ampm } = localHourMinuteAmPm(date, timezone);
  if (hour === 12 && minute === 0 && ampm === "pm") return "noon";
  if (hour === 12 && minute === 0 && ampm === "am") return "midnight";
  if (minute === 0) return `${hour} ${ampm}`;
  if (minute === 30) return `${hour} thirty ${ampm}`;
  return `${hour} ${minute} ${ampm}`;
}

/** Wall-clock for the briefing datetime line: "10:17 pm". */
export function speakWallClock(date: Date, timezone?: string): string {
  const { hour, minute, ampm } = localHourMinuteAmPm(date, timezone);
  return `${hour}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export function speakWeekday(date: Date, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long" };
  if (timezone) opts.timeZone = timezone;
  return new Intl.DateTimeFormat("en-US", opts).format(date);
}

export function speakMonthDay(date: Date, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
  if (timezone) opts.timeZone = timezone;
  return new Intl.DateTimeFormat("en-US", opts).format(date);
}

/** Expand short weekday tokens that may appear in strings. */
export function expandDayAbbr(text: string): string {
  return text.replace(
    /\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/g,
    (m) => DAY_FULL[m] ?? m,
  );
}

/** Speak a USD amount without "$" or dense digit strings. */
export function speakUsdAmount(price: number): string {
  const rounded = Math.round(price);
  if (rounded >= 1000) {
    const thousands = Math.floor(rounded / 1000);
    const remainder = rounded % 1000;
    if (remainder === 0) return `${thousands} thousand dollars`;
    return `${thousands} thousand ${remainder} dollars`;
  }
  return `${rounded} dollars`;
}

export function speakPercentChange(change24h: number): { direction: string; amount: string } {
  return {
    direction: change24h >= 0 ? "up" : "down",
    amount: Math.abs(change24h).toFixed(1),
  };
}

/**
 * Final TTS cleanup: expand abbreviations, strip markdown/icons/emoji, normalize symbols.
 */
export function sanitizeForSpeech(text: string): string {
  let s = text;
  s = s.replace(/\[icon:[^\]]+\]/g, "");
  s = s.replace(/[*_#`~\[\]]/g, "");
  s = s.replace(/https?:\/\/\S+/gi, "");
  // Common spoken expansions
  s = s.replace(/\bS&P\s*500\b/gi, "S and P 500");
  s = s.replace(/\bS&P\b/gi, "S and P");
  s = s.replace(/\bvs\.?\b/gi, "versus");
  s = s.replace(/\b&\b/g, "and");
  s = s.replace(/\bCA\b/g, "California");
  s = s.replace(/\bNY\b/g, "New York");
  s = s.replace(/\bTX\b/g, "Texas");
  s = s.replace(/\bUSA\b/g, "U S A");
  s = s.replace(/\bUS\b/g, "U S");
  s = s.replace(/\bUK\b/g, "U K");
  s = s.replace(/\bNASA\b/g, "NASA");
  s = s.replace(/\bUTC\b/g, "U T C");
  s = s.replace(/\bEST\b/g, "Eastern");
  s = s.replace(/\bPST\b/g, "Pacific");
  s = s.replace(/\bPDT\b/g, "Pacific");
  s = s.replace(/\bTBA\b/gi, "to be announced");
  s = s.replace(/\bN\/A\b/gi, "not available");
  s = expandDayAbbr(s);
  // Currency / percent left as symbols → words when still present
  s = s.replace(/\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(million|billion|trillion)?/gi, (_m, num, scale) => {
    const n = parseFloat(String(num).replace(/,/g, ""));
    if (Number.isNaN(n)) return _m;
    if (scale) return `${n} ${scale} dollars`;
    return speakUsdAmount(n);
  });
  s = s.replace(/([+-]?)(\d+(?:\.\d+)?)\s*%/g, (_m, sign, num) => {
    const direction = sign === "-" ? "down " : sign === "+" ? "up " : "";
    return `${direction}${num} percent`.replace(/^up /i, "up ").trim();
  });
  // Degrees symbols
  s = s.replace(/°\s*F\b/gi, " degrees Fahrenheit");
  s = s.replace(/°\s*C\b/gi, " degrees Celsius");
  s = s.replace(/°/g, " degrees");
  // Strip leftover emoji / odd punctuation clusters
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu, "");
  s = s.replace(/\s+/g, " ").trim();
  // Avoid double periods
  s = s.replace(/\.\s*\./g, ".");
  return s;
}

export function closingLine(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
  if (hour < 12) return "Have a productive day, sir.";
  if (hour < 17) return "Have a good afternoon, sir.";
  return "Have a pleasant evening, sir.";
}

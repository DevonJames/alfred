import { fetchJson } from "./feed-http.js";
import { speakMonthDay } from "./speech.js";

export interface ExchangeRateQuery {
  amount?: number;
  from: string;
  to: string;
  /** Compare the rate with about a week ago. */
  change?: boolean;
}

const NAMES: Record<string, { one: string; many: string }> = {
  USD: { one: "dollar", many: "dollars" },
  EUR: { one: "euro", many: "euros" },
  GBP: { one: "pound", many: "pounds" },
  JPY: { one: "yen", many: "yen" },
  AUD: { one: "Australian dollar", many: "Australian dollars" },
  CAD: { one: "Canadian dollar", many: "Canadian dollars" },
  CHF: { one: "franc", many: "francs" },
  CNY: { one: "yuan", many: "yuan" },
  INR: { one: "rupee", many: "rupees" },
  MXN: { one: "peso", many: "pesos" },
  KRW: { one: "won", many: "won" },
};

const BASE = "https://api.frankfurter.dev/v1";

function currencyName(code: string, amount: number): string {
  const names = NAMES[code] ?? { one: code, many: code };
  return Math.abs(amount - 1) < 0.001 ? names.one : names.many;
}

export function speakFxAmount(amount: number): string {
  const rounded = amount >= 100 ? Math.round(amount) : Math.round(amount * 100) / 100;
  if (rounded >= 1000) {
    const thousands = Math.floor(rounded / 1000);
    const remainder = Math.round(rounded % 1000);
    if (remainder === 0) return `${thousands} thousand`;
    return `${thousands} thousand ${remainder}`;
  }
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatExchangeSpeech(opts: {
  amount: number;
  from: string;
  to: string;
  converted: number;
  date?: string;
}): string {
  const fromName = currencyName(opts.from, opts.amount);
  const toName = currencyName(opts.to, opts.converted);
  let when = "";
  if (opts.date) {
    const parsed = new Date(`${opts.date}T12:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) when = `, as of ${speakMonthDay(parsed)}`;
  }
  return `${speakFxAmount(opts.amount)} ${fromName} is about ${speakFxAmount(opts.converted)} ${toName}${when}.`;
}

export function formatExchangeChangeSpeech(opts: {
  from: string;
  to: string;
  latest: number;
  previous: number;
}): string {
  const toName = currencyName(opts.to, opts.latest);
  const fromName = currencyName(opts.from, 1);
  const pct = opts.previous === 0 ? 0 : ((opts.latest - opts.previous) / opts.previous) * 100;
  const direction = pct >= 0 ? "more" : "less";
  return `One ${fromName} buys about ${speakFxAmount(opts.latest)} ${toName}, versus ${speakFxAmount(opts.previous)} a week ago, about ${Math.abs(pct).toFixed(1)} percent ${direction}.`;
}

async function latestRate(
  amount: number,
  from: string,
  to: string,
): Promise<{ converted: number; date?: string } | null> {
  const payload = (await fetchJson(
    `${BASE}/latest?amount=${encodeURIComponent(String(amount))}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  )) as { rates?: Record<string, number>; date?: string } | null;
  const converted = payload?.rates?.[to];
  if (typeof converted !== "number" || !Number.isFinite(converted)) return null;
  return { converted, date: payload?.date };
}

async function weekChange(
  from: string,
  to: string,
): Promise<{ latest: number; previous: number } | null> {
  const end = new Date();
  const start = new Date(end.getTime() - 8 * 24 * 60 * 60 * 1000);
  const startKey = start.toISOString().slice(0, 10);
  const endKey = end.toISOString().slice(0, 10);
  const payload = (await fetchJson(
    `${BASE}/${startKey}..${endKey}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  )) as { rates?: Record<string, Record<string, number>> } | null;
  const rates = payload?.rates;
  if (!rates) return null;
  const days = Object.keys(rates).sort();
  if (days.length < 2) return null;
  const previous = rates[days[0]!]?.[to];
  const latest = rates[days[days.length - 1]!]?.[to];
  if (typeof previous !== "number" || typeof latest !== "number") return null;
  return { latest, previous };
}

export async function lookupExchangeRate(query: ExchangeRateQuery): Promise<string> {
  const from = query.from.trim().toUpperCase();
  const to = query.to.trim().toUpperCase();
  if (!from || !to || from === to) {
    return "Tell me two different currencies, such as dollars into euros.";
  }
  if (query.change) {
    const change = await weekChange(from, to);
    if (!change) return "I couldn't compare that exchange rate just now.";
    return formatExchangeChangeSpeech({ from, to, ...change });
  }
  const amount = query.amount != null && query.amount > 0 ? query.amount : 1;
  const latest = await latestRate(amount, from, to);
  if (!latest) return "I couldn't get that exchange rate just now.";
  return formatExchangeSpeech({ amount, from, to, converted: latest.converted, date: latest.date });
}

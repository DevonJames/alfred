import type { DueReminder } from "@alfred/memory";
import type { LaunchInfo } from "./launches.js";
import type { MarketQuote } from "./markets.js";
import type { WeatherData } from "./weather.js";

export interface BriefingData {
  greeting: string;
  date: string;
  dayKey: string;
  weather: WeatherData | null;
  weatherText: string | null;
  launches: LaunchInfo[];
  launchesText: string | null;
  markets: {
    crypto: MarketQuote | null;
    cryptoId: string;
    index: MarketQuote | null;
    indexSymbol: string | null;
    metals: MarketQuote | null;
    metalSymbol: string | null;
    lines: string[];
  };
  marketsText: string | null;
  news: string[];
  newsText: string | null;
  reminders: DueReminder[];
  remindersText: string | null;
  generated: string;
}

export interface BriefingPayload {
  briefing: BriefingData;
  speech: string;
  markdown: string;
  generated: string;
}

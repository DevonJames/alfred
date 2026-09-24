import { lookupEarthquakes, type EarthquakeQuery } from "./earthquakes.js";
import { lookupExchangeRate, type ExchangeRateQuery } from "./exchange-rate.js";
import { lookupHackerNews, type HackerNewsQuery } from "./hacker-news.js";
import { lookupNaturalEvents, type NaturalEventQuery } from "./natural-events.js";
import { lookupSpaceWeather } from "./space-weather.js";
import { lookupWeatherAlerts, type WeatherAlertQuery } from "./weather-alerts.js";

/** Phrase-parser result. Kept structural so core and briefing stay decoupled. */
export type SituationalRequest =
  | ({ tool: "earthquakes" } & EarthquakeQuery)
  | ({ tool: "weather_alerts" } & WeatherAlertQuery)
  | { tool: "space_weather" }
  | ({ tool: "natural_events" } & NaturalEventQuery)
  | ({ tool: "exchange_rate" } & ExchangeRateQuery)
  | ({ tool: "hacker_news" } & HackerNewsQuery);

export async function speakSituationalRequest(request: SituationalRequest): Promise<string> {
  switch (request.tool) {
    case "earthquakes":
      return lookupEarthquakes(request);
    case "weather_alerts":
      return lookupWeatherAlerts(request);
    case "space_weather":
      return lookupSpaceWeather();
    case "natural_events":
      return lookupNaturalEvents(request);
    case "exchange_rate":
      return lookupExchangeRate(request);
    case "hacker_news":
      return lookupHackerNews(request);
    default:
      return "I couldn't look that up just now.";
  }
}

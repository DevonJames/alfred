export interface CurrentWeather {
  temperature: number;
  feelsLike?: number;
  humidity?: number;
  windSpeed: number;
  windDirection: number;
  condition: string;
  conditionCode: number;
  isDay: boolean;
}

export interface DayForecast {
  date: string;
  tempMax: number;
  tempMin: number;
  condition: string;
  conditionCode: number;
  precipProbability: number;
  precipAmount?: number;
}

export interface WeatherData {
  location: string;
  latitude: number;
  longitude: number;
  timezone: string;
  current: CurrentWeather;
  daily: DayForecast[];
  unit: "fahrenheit" | "celsius";
}

const WMO_CODES: Record<number, { condition: string }> = {
  0: { condition: "Clear sky" },
  1: { condition: "Mainly clear" },
  2: { condition: "Partly cloudy" },
  3: { condition: "Overcast" },
  45: { condition: "Foggy" },
  48: { condition: "Rime fog" },
  51: { condition: "Light drizzle" },
  53: { condition: "Moderate drizzle" },
  55: { condition: "Dense drizzle" },
  61: { condition: "Slight rain" },
  63: { condition: "Moderate rain" },
  65: { condition: "Heavy rain" },
  71: { condition: "Slight snow" },
  73: { condition: "Moderate snow" },
  75: { condition: "Heavy snow" },
  80: { condition: "Slight showers" },
  81: { condition: "Moderate showers" },
  82: { condition: "Violent showers" },
  95: { condition: "Thunderstorm" },
};

function getConditionFromCode(code: number): string {
  return WMO_CODES[code]?.condition ?? `Unknown (${code})`;
}

async function geocodeLocation(
  query: string,
): Promise<{ name: string; lat: number; lon: number; timezone: string } | null> {
  try {
    const encoded = encodeURIComponent(query);
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encoded}&count=1&language=en&format=json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      results?: Array<{
        name: string;
        latitude: number;
        longitude: number;
        timezone: string;
        admin1?: string;
        country?: string;
      }>;
    };
    const result = data.results?.[0];
    if (!result) return null;
    const parts = [result.name];
    if (result.admin1) parts.push(result.admin1);
    if (result.country && result.country !== "United States") parts.push(result.country);
    return {
      name: parts.join(", "),
      lat: result.latitude,
      lon: result.longitude,
      timezone: result.timezone || "auto",
    };
  } catch {
    return null;
  }
}

export async function fetchWeather(
  location: string,
  useCelsius = false,
  coords?: { lat: number; lon: number; timezone?: string; name?: string } | null,
): Promise<WeatherData | null> {
  try {
    let geo: { name: string; lat: number; lon: number; timezone: string } | null = null;
    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
      geo = {
        name: coords.name?.trim() || location,
        lat: coords.lat,
        lon: coords.lon,
        timezone: coords.timezone?.trim() || "auto",
      };
    } else {
      geo = await geocodeLocation(location);
    }
    if (!geo) return null;

    const tempUnit = useCelsius ? "celsius" : "fahrenheit";
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(geo.lat));
    url.searchParams.set("longitude", String(geo.lon));
    url.searchParams.set(
      "current",
      "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,is_day",
    );
    url.searchParams.set(
      "daily",
      "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum",
    );
    url.searchParams.set("temperature_unit", tempUnit);
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("precipitation_unit", "inch");
    url.searchParams.set("timezone", geo.timezone);
    url.searchParams.set("forecast_days", "7");

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      latitude: number;
      longitude: number;
      timezone: string;
      current: {
        temperature_2m: number;
        relative_humidity_2m: number;
        apparent_temperature: number;
        weather_code: number;
        wind_speed_10m: number;
        wind_direction_10m: number;
        is_day: number;
      };
      daily: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        weather_code: number[];
        precipitation_probability_max: number[];
        precipitation_sum: number[];
      };
    };

    return {
      location: geo.name,
      latitude: geo.lat,
      longitude: geo.lon,
      timezone: data.timezone,
      current: {
        temperature: Math.round(data.current.temperature_2m),
        feelsLike: Math.round(data.current.apparent_temperature),
        humidity: data.current.relative_humidity_2m,
        windSpeed: Math.round(data.current.wind_speed_10m),
        windDirection: data.current.wind_direction_10m,
        condition: getConditionFromCode(data.current.weather_code),
        conditionCode: data.current.weather_code,
        isDay: data.current.is_day === 1,
      },
      daily: data.daily.time.map((date, i) => ({
        date,
        tempMax: Math.round(data.daily.temperature_2m_max[i]!),
        tempMin: Math.round(data.daily.temperature_2m_min[i]!),
        condition: getConditionFromCode(data.daily.weather_code[i]!),
        conditionCode: data.daily.weather_code[i]!,
        precipProbability: data.daily.precipitation_probability_max[i] ?? 0,
        precipAmount: data.daily.precipitation_sum[i],
      })),
      unit: useCelsius ? "celsius" : "fahrenheit",
    };
  } catch {
    return null;
  }
}

function dayConditionSpoken(day: DayForecast): string {
  return day.condition.replace(/[^\w\s-]/g, "").trim().toLowerCase() || "clear";
}

function precipSpoken(day: DayForecast): string {
  const chance = day.precipProbability ?? 0;
  if (chance >= 70) return ` with a high chance of precipitation`;
  if (chance >= 40) return ` with a ${chance} percent chance of precipitation`;
  return "";
}

export function formatWeatherSpeech(weather: WeatherData): string {
  const condition = weather.current.condition.replace(/[^\w\s-]/g, "").trim().toLowerCase();
  const temp = Math.round(weather.current.temperature);
  const feels = weather.current.feelsLike != null ? Math.round(weather.current.feelsLike) : temp;
  const parts: string[] = [];

  if (feels !== temp) {
    parts.push(`Currently ${temp} degrees and ${condition}, feeling like ${feels}.`);
  } else {
    parts.push(`Currently ${temp} degrees and ${condition}.`);
  }

  const humidity = weather.current.humidity ?? 0;
  const windSpeed = weather.current.windSpeed ?? 0;
  if (humidity > 60 || windSpeed > 10) {
    const humidPart =
      humidity > 80 ? "It's very humid" : humidity > 60 ? "It's a bit humid" : "";
    const windPart =
      windSpeed > 20 ? "quite windy" : windSpeed > 10 ? "some wind" : "";
    if (humidPart && windPart) parts.push(`${humidPart} and ${windPart} too.`);
    else if (humidPart) parts.push(`${humidPart}.`);
    else if (windPart) parts.push(`There's ${windPart} today.`);
  }

  // alfred-home style: today + tomorrow + day-after forecast highs/lows
  const today = weather.daily[0];
  if (today) {
    parts.push(
      `Today, ${dayConditionSpoken(today)}, high ${Math.round(today.tempMax)}, low ${Math.round(today.tempMin)}${precipSpoken(today)}.`,
    );
  }
  const tomorrow = weather.daily[1];
  if (tomorrow) {
    parts.push(
      `Tomorrow, ${dayConditionSpoken(tomorrow)}, ranging from ${Math.round(tomorrow.tempMin)} to ${Math.round(tomorrow.tempMax)} degrees${precipSpoken(tomorrow)}.`,
    );
  }
  const dayAfter = weather.daily[2];
  if (dayAfter) {
    parts.push(`The day after tomorrow, ${dayConditionSpoken(dayAfter)}.`);
  }

  return parts.join(" ");
}

export function formatWeatherMarkdown(weather: WeatherData): string {
  const unit = weather.unit === "celsius" ? "°C" : "°F";
  const feels =
    weather.current.feelsLike != null && weather.current.feelsLike !== weather.current.temperature
      ? ` (feels like ${weather.current.feelsLike}${unit})`
      : "";
  const lines = [
    `**Weather — ${weather.location}**`,
    `Currently ${weather.current.condition}, ${weather.current.temperature}${unit}${feels}. Humidity ${weather.current.humidity ?? 0}%, wind ${weather.current.windSpeed} mph.`,
    "",
    "**Forecast:**",
  ];
  for (const [i, day] of weather.daily.slice(0, 3).entries()) {
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : day.date;
    const precip =
      day.precipProbability >= 40 ? ` · ${day.precipProbability}% precip` : "";
    lines.push(
      `- ${label}: ${day.condition}, high ${day.tempMax}${unit}, low ${day.tempMin}${unit}${precip}`,
    );
  }
  return lines.join("\n");
}

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// WMO weather interpretation codes (used by Open-Meteo).
const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export interface GeocodeResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
}

/**
 * Shared geocoding helper — used by weather, points-of-interest, and hotel
 * tools so every tool that needs city coordinates hits the same free,
 * keyless Open-Meteo geocoder instead of duplicating the lookup.
 */
export async function geocodeCity(city: string): Promise<GeocodeResult> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    city
  )}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Geocoding request failed with status ${res.status}`);
  }
  const data = (await res.json()) as {
    results?: Array<{
      name: string;
      country: string;
      latitude: number;
      longitude: number;
    }>;
  };
  const first = data.results?.[0];
  if (!first) {
    throw new Error(`Could not find a location matching "${city}"`);
  }
  return {
    name: first.name,
    country: first.country,
    latitude: first.latitude,
    longitude: first.longitude,
  };
}

async function fetchCurrentConditions(lat: number, lon: number) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Forecast request failed with status ${res.status}`);
  }
  return (await res.json()) as {
    current: {
      temperature_2m: number;
      precipitation: number;
      weather_code: number;
    };
    timezone: string;
    utc_offset_seconds: number;
  };
}

export const getWeatherForecastTool = createTool({
  id: "getWeatherForecast",
  description:
    "Get the current weather (temperature, precipitation, conditions) for a city. " +
    "Geocodes the city with the Open-Meteo geocoding API, then fetches current " +
    "conditions from the Open-Meteo forecast API. Real API, no key required.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. 'Tokyo' or 'Paris, France'"),
  }),
  outputSchema: z.object({
    city: z.string(),
    country: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    temperatureC: z.number(),
    precipitationMm: z.number(),
    weatherCode: z.number(),
    weatherDescription: z.string(),
    timezone: z.string(),
  }),
  execute: async ({ city }) => {
    const location = await geocodeCity(city);
    const conditions = await fetchCurrentConditions(
      location.latitude,
      location.longitude
    );
    return {
      city: location.name,
      country: location.country,
      latitude: location.latitude,
      longitude: location.longitude,
      temperatureC: conditions.current.temperature_2m,
      precipitationMm: conditions.current.precipitation,
      weatherCode: conditions.current.weather_code,
      weatherDescription:
        WEATHER_CODE_DESCRIPTIONS[conditions.current.weather_code] ??
        "Unknown",
      timezone: conditions.timezone,
    };
  },
});

export const getTimezoneInfoTool = createTool({
  id: "getTimezoneInfo",
  description:
    "Get timezone info (IANA timezone name, UTC offset, current local time) for a city. " +
    "Reuses the timezone and utc_offset_seconds fields already returned by the Open-Meteo " +
    "forecast API (the same one getWeatherForecast calls) rather than a second provider.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. 'Tokyo' or 'Paris, France'"),
  }),
  outputSchema: z.object({
    city: z.string(),
    timezone: z.string(),
    utcOffsetSeconds: z.number(),
    currentLocalTime: z.string(),
  }),
  execute: async ({ city }) => {
    const location = await geocodeCity(city);
    const conditions = await fetchCurrentConditions(
      location.latitude,
      location.longitude
    );
    const localTime = new Date(
      Date.now() + conditions.utc_offset_seconds * 1000
    );
    return {
      city: location.name,
      timezone: conditions.timezone,
      utcOffsetSeconds: conditions.utc_offset_seconds,
      currentLocalTime: localTime.toISOString().replace("Z", ""),
    };
  },
});

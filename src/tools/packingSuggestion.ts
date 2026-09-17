import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Pure local logic — no API call. Maps a weather summary (plus optional
 * structured readings, typically taken straight from getWeatherForecast's
 * output) to packing advice.
 */
function suggestPacking(
  weatherSummary: string,
  temperatureC?: number
): string[] {
  const summary = weatherSummary.toLowerCase();
  const items = new Set<string>();

  const isCold =
    (temperatureC !== undefined && temperatureC <= 10) ||
    /snow|freezing|frost/.test(summary);
  const isCool =
    (temperatureC !== undefined && temperatureC > 10 && temperatureC <= 18) ||
    /cool|chilly/.test(summary);
  const isHot =
    (temperatureC !== undefined && temperatureC >= 28) || /hot|heat/.test(summary);
  const isRainy = /rain|drizzle|shower|thunderstorm/.test(summary);
  const isSnowy = /snow/.test(summary);
  const isFoggy = /fog/.test(summary);
  const isClear = /clear|sunny/.test(summary) && !isRainy && !isSnowy;

  if (isCold) {
    items.add("Heavy winter coat");
    items.add("Thermal base layers");
    items.add("Gloves and warm hat");
    items.add("Insulated waterproof boots");
  } else if (isCool) {
    items.add("Light jacket or fleece");
    items.add("Long-sleeve layers");
  } else if (isHot) {
    items.add("Lightweight, breathable clothing");
    items.add("Sunscreen and sunglasses");
    items.add("Hat for sun protection");
    items.add("Reusable water bottle");
  } else {
    items.add("Light layers (sweater or light jacket)");
  }

  if (isSnowy) {
    items.add("Waterproof snow boots");
    items.add("Snow-appropriate outerwear");
  } else if (isRainy) {
    items.add("Umbrella or rain jacket");
    items.add("Waterproof shoes");
  }

  if (isFoggy) {
    items.add("Layered clothing for variable visibility conditions");
  }

  if (isClear && !isHot && !isCold) {
    items.add("Sunglasses");
  }

  if (items.size === 0) {
    items.add("General all-weather layers");
    items.add("Comfortable walking shoes");
  }

  return Array.from(items);
}

export const getPackingSuggestionTool = createTool({
  id: "getPackingSuggestion",
  description:
    "Given a natural-language weather summary (e.g. 'light rain, 14C, overcast'), " +
    "suggest what to pack. This is local logic that maps weather conditions to packing " +
    "advice — it does not call any external API. Best used after getWeatherForecast.",
  inputSchema: z.object({
    weatherSummary: z
      .string()
      .describe(
        "Free-text weather description, e.g. weatherDescription from getWeatherForecast, " +
          "such as 'Slight rain' or 'Clear sky'"
      ),
    temperatureC: z
      .number()
      .optional()
      .describe("Temperature in Celsius, if known, for more precise suggestions"),
  }),
  outputSchema: z.object({
    packingList: z.array(z.string()),
  }),
  execute: async ({ weatherSummary, temperatureC }) => {
    return {
      packingList: suggestPacking(weatherSummary, temperatureC),
    };
  },
});

import { Agent } from "@mastra/core/agent";
import { getWeatherForecastTool, getTimezoneInfoTool } from "./tools/weather.js";
import { getExchangeRateTool } from "./tools/exchangeRate.js";
import { getPackingSuggestionTool } from "./tools/packingSuggestion.js";
import { getPointsOfInterestTool } from "./tools/pointsOfInterest.js";
import { getHotelsTool } from "./tools/hotels.js";
import { searchFlightsTool } from "./tools/flights.js";
import { buildItineraryTool } from "./tools/itinerary.js";

export const travelAgent = new Agent({
  id: "travel-agent",
  name: "Travel Planning Agent",
  instructions: `You are a travel-planning assistant. You have tools for real-time
weather, timezones, currency exchange rates, points of interest, hotels (location only,
no pricing), flight search (RapidAPI Sky Scrapper — a live but unofficial flight-data
aggregator, not an airline/GDS booking system), and local packing and itinerary-building
logic.

Decide for yourself which tools are needed for a given request and in what order — do
not follow a fixed sequence. For example, a request to plan a multi-day trip typically
benefits from checking weather and points of interest before building an itinerary or
suggesting what to pack, and flight search only makes sense if the user gave an origin.
Skip tools that aren't relevant to what was asked.

Always be explicit that searchFlights returns Sky Scrapper's live but unofficial
aggregator data, not guaranteed bookable fares, and that getHotels returns location
only, no prices or availability. If searchFlights, getPointsOfInterest, or getHotels
reports available: false, relay that honestly (their "message" field says why) rather
than presenting it as if there's simply nothing there.
When you call buildItinerary, pass it points of interest you already retrieved via
getPointsOfInterest — it only organizes data, it does not fetch anything new.

When presenting points of interest or hotels, never print raw latitude/longitude
numbers to the user — they're for your own internal use (e.g. passing to
buildItinerary). Instead, present each place as its name and category, and if you
want to give the user a way to locate it, use the "mapsUrl" field as a link (e.g.
"[Museo di Roma](mapsUrl)"), not the coordinates themselves.`,
  // Mastra's built-in model router: the "openrouter/<model-id>" string is resolved
  // internally using the OPENROUTER_API_KEY environment variable — no separate
  // provider package needed. See https://mastra.ai/models/providers/openrouter
  model: "openrouter/openai/gpt-oss-20b",
  tools: {
    getWeatherForecast: getWeatherForecastTool,
    getTimezoneInfo: getTimezoneInfoTool,
    getExchangeRate: getExchangeRateTool,
    getPackingSuggestion: getPackingSuggestionTool,
    getPointsOfInterest: getPointsOfInterestTool,
    getHotels: getHotelsTool,
    searchFlights: searchFlightsTool,
    buildItinerary: buildItineraryTool,
  },
});

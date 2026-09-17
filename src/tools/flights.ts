import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const RAPIDAPI_HOST_DEFAULT = "sky-scrapper.p.rapidapi.com";

function rapidApiHeaders(): Record<string, string> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    throw new Error("RAPIDAPI_KEY must be set in the environment");
  }
  return {
    "X-RapidAPI-Key": key,
    "X-RapidAPI-Host": process.env.RAPIDAPI_HOST ?? RAPIDAPI_HOST_DEFAULT,
  };
}

interface FlightParams {
  skyId: string;
  entityId: string;
}

/**
 * A 429 from RapidAPI is not the same as any other failure: retrying makes it worse,
 * and the honest thing to tell the user is that flight search is rate-limited right
 * now — not that no flights exist. Kept as its own error type so execute() can give
 * it a distinct, non-generic message instead of folding it into the catch-all case.
 */
class RapidApiRateLimitedError extends Error {}

/**
 * Turns a failed RapidAPI response into a thrown error. RapidAPI returns 429 both for
 * a per-second rate limit (transient, retry soon) and for an exhausted monthly quota
 * on the Basic plan (not transient — needs a plan upgrade or the next billing cycle)
 * — the response body's "quota" wording is the only way to tell them apart.
 */
async function throwForRapidApiFailure(res: Response, step: string): Promise<never> {
  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    if (/quota/i.test(body)) {
      throw new RapidApiRateLimitedError(
        "flight search has hit the RapidAPI Sky Scrapper Basic plan's monthly request quota — it needs a plan upgrade or the next billing cycle, not a retry"
      );
    }
    throw new RapidApiRateLimitedError("flight search has hit its rate limit for now — retrying immediately won't help");
  }
  throw new Error(`${step} failed with status ${res.status}`);
}

/**
 * Step 1: resolve a city/airport name to the skyId + entityId Sky Scrapper's
 * flight-search endpoint requires. Picks the best (first) match.
 */
async function resolveAirport(query: string): Promise<FlightParams> {
  const url = new URL("https://sky-scrapper.p.rapidapi.com/api/v1/flights/searchAirport");
  url.searchParams.set("query", query);
  const res = await fetch(url, { headers: rapidApiHeaders() });
  if (!res.ok) {
    await throwForRapidApiFailure(res, "searchAirport");
  }
  const data = (await res.json()) as {
    data?: Array<{
      navigation?: {
        relevantFlightParams?: { skyId?: string; entityId?: string };
      };
    }>;
  };
  const params = data.data?.[0]?.navigation?.relevantFlightParams;
  if (!params?.skyId || !params?.entityId) {
    throw new Error(`No airport/city match found for "${query}"`);
  }
  return { skyId: params.skyId, entityId: params.entityId };
}

/** Step 2: search flights between two resolved locations on a given date. */
async function searchFlightOffers(
  origin: FlightParams,
  destination: FlightParams,
  date: string
) {
  const url = new URL("https://sky-scrapper.p.rapidapi.com/api/v2/flights/searchFlights");
  url.searchParams.set("originSkyId", origin.skyId);
  url.searchParams.set("destinationSkyId", destination.skyId);
  url.searchParams.set("originEntityId", origin.entityId);
  url.searchParams.set("destinationEntityId", destination.entityId);
  url.searchParams.set("date", date);
  url.searchParams.set("cabinClass", "economy");
  url.searchParams.set("adults", "1");
  url.searchParams.set("currency", "USD");
  url.searchParams.set("market", "en-US");
  url.searchParams.set("countryCode", "US");

  const res = await fetch(url, { headers: rapidApiHeaders() });
  if (!res.ok) {
    await throwForRapidApiFailure(res, "searchFlights");
  }
  const data = (await res.json()) as {
    data?: {
      itineraries?: Array<{
        price?: { raw?: number };
        legs?: Array<{
          durationInMinutes?: number;
          stopCount?: number;
          departure?: string;
          arrival?: string;
          carriers?: { marketing?: Array<{ name?: string }> };
        }>;
      }>;
    };
  };
  return data.data?.itineraries ?? [];
}

/**
 * Builds the user-facing message for a failed flight search. A rate limit gets its
 * own honest wording (so the agent doesn't imply "no flights exist" when the real
 * reason is "couldn't check"); anything else gets a generic unavailable message.
 */
function describeFlightFailure(err: unknown, action: string): string {
  if (err instanceof RapidApiRateLimitedError) {
    return `Couldn't ${action} this trip: ${err.message}.`;
  }
  return `Flight search is temporarily unavailable (could not ${action} this trip: ${
    err instanceof Error ? err.message : String(err)
  }).`;
}

export const searchFlightsTool = createTool({
  id: "searchFlights",
  description:
    "Search real flight offers between two cities/airports on a given date, using " +
    "RapidAPI's Sky Scrapper flight-search API (a live flight-data aggregator scraped " +
    "from search engines, not an airline or GDS booking system). Internally does two " +
    "real API calls: it resolves each city/airport name to Sky Scrapper's internal IDs, " +
    "then searches flights with those IDs — the model only needs to pass city or airport " +
    "names, not IATA codes. Prices and availability come from a live but unofficial " +
    "source and are not guaranteed bookable. If the search fails or is rate-limited, " +
    "this tool reports that flight search is temporarily unavailable rather than erroring.",
  inputSchema: z.object({
    origin: z.string().describe("Origin city or airport name, e.g. 'Delhi'"),
    destination: z.string().describe("Destination city or airport name, e.g. 'Tokyo'"),
    date: z.string().describe("Departure date in YYYY-MM-DD format"),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    message: z.string(),
    origin: z.string().optional(),
    destination: z.string().optional(),
    date: z.string().optional(),
    offers: z
      .array(
        z.object({
          airline: z.string(),
          priceUSD: z.number(),
          durationMinutes: z.number(),
          stops: z.number(),
          departureTime: z.string(),
          arrivalTime: z.string(),
        })
      )
      .optional(),
  }),
  execute: async ({ origin, destination, date }) => {
    let originParams: FlightParams;
    let destinationParams: FlightParams;
    try {
      [originParams, destinationParams] = await Promise.all([
        resolveAirport(origin),
        resolveAirport(destination),
      ]);
    } catch (err) {
      return { available: false, message: describeFlightFailure(err, "resolve airports for") };
    }

    try {
      const itineraries = await searchFlightOffers(originParams, destinationParams, date);
      const offers = itineraries.slice(0, 5).map((it) => {
        const leg = it.legs?.[0];
        return {
          airline: leg?.carriers?.marketing?.[0]?.name ?? "Unknown",
          priceUSD: it.price?.raw ?? 0,
          durationMinutes: leg?.durationInMinutes ?? 0,
          stops: leg?.stopCount ?? 0,
          departureTime: leg?.departure ?? "unknown",
          arrivalTime: leg?.arrival ?? "unknown",
        };
      });
      return {
        available: true,
        message: `Found ${offers.length} flight option(s).`,
        origin,
        destination,
        date,
        offers,
      };
    } catch (err) {
      return { available: false, message: describeFlightFailure(err, "search flights for") };
    }
  },
});

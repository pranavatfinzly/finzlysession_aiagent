import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { geocodeCity } from "./weather.js";

const DEFAULT_RADIUS_METERS = 5000;

// category keyword -> OSM [key, value] tag pairs to search for.
const CATEGORY_TAGS: Record<string, Array<[string, string]>> = {
  attraction: [["tourism", "attraction"]],
  museum: [["tourism", "museum"]],
  gallery: [["tourism", "gallery"]],
  viewpoint: [["tourism", "viewpoint"]],
  restaurant: [["amenity", "restaurant"]],
  cafe: [["amenity", "cafe"]],
  park: [["leisure", "park"]],
  monument: [["historic", "monument"]],
  landmark: [
    ["tourism", "attraction"],
    ["historic", "monument"],
  ],
};

const DEFAULT_TAGS: Array<[string, string]> = [
  ["tourism", "attraction"],
  ["tourism", "museum"],
  ["tourism", "gallery"],
  ["tourism", "viewpoint"],
  ["amenity", "restaurant"],
];

export interface OverpassPlace {
  name: string;
  category: string;
  latitude: number;
  longitude: number;
}

/** A clickable Google Maps link for a coordinate — nicer for a user-facing answer than raw lat/lon. */
export function mapsUrlFor(latitude: number, longitude: number): string {
  return `https://www.google.com/maps?q=${latitude},${longitude}`;
}

/**
 * Thrown when both the primary Overpass endpoint and its mirror fail — lets callers
 * (getPointsOfInterest, getHotels) tell "OSM data genuinely unavailable right now"
 * apart from other errors (e.g. geocoding failures) and return a clear structured
 * result instead of an unhandled tool error.
 */
export class OverpassUnavailableError extends Error {}

// overpass-api.de is the canonical public instance; the French OSM mirror runs on
// independent infrastructure, so a 5xx/timeout on one is very unlikely to also
// affect the other at the same moment. (An earlier choice, kumi.systems, was
// dropped after live testing showed it hanging indefinitely from this network —
// verify a candidate mirror actually responds before trusting it as a fallback.)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];
const OVERPASS_TIMEOUT_MS = 20000;

interface OverpassResponse {
  elements: Array<{
    type: string;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }>;
}

/**
 * GET with an explicit Accept/User-Agent, since some network paths (proxies,
 * mod_security rules on the Overpass server) reject POST requests or requests
 * without these headers with a 406. Uses an explicit client-side timeout since a
 * struggling Overpass instance can hang well past its own server-side query timeout
 * instead of ever sending a response.
 */
async function fetchOverpassFrom(baseUrl: string, query: string): Promise<OverpassResponse> {
  const url = `${baseUrl}?data=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "travel-agent-mastra/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${baseUrl} responded with status ${res.status}`);
    }
    return (await res.json()) as OverpassResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Shared Overpass (OpenStreetMap) query helper — used by both
 * getPointsOfInterest and getHotels since they only differ in which
 * tags they search for around the same geocoded bounding area.
 */
export async function queryOverpassNodes(
  lat: number,
  lon: number,
  radiusMeters: number,
  tagPairs: Array<[string, string]>,
  limit: number
): Promise<OverpassPlace[]> {
  const clauses = tagPairs
    .map(
      ([key, value]) =>
        `  node["${key}"="${value}"](around:${radiusMeters},${lat},${lon});\n` +
        `  way["${key}"="${value}"](around:${radiusMeters},${lat},${lon});`
    )
    .join("\n");
  const query = `[out:json][timeout:25];\n(\n${clauses}\n);\nout center ${limit * 3};`;

  let data: OverpassResponse;
  try {
    data = await fetchOverpassFrom(OVERPASS_ENDPOINTS[0], query);
  } catch (primaryErr) {
    try {
      data = await fetchOverpassFrom(OVERPASS_ENDPOINTS[1], query);
    } catch (mirrorErr) {
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const mirrorMsg = mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr);
      throw new OverpassUnavailableError(
        `both the primary Overpass endpoint (${primaryMsg}) and its mirror (${mirrorMsg}) failed`
      );
    }
  }

  const places: OverpassPlace[] = [];
  for (const el of data.elements) {
    const name = el.tags?.name;
    if (!name) continue; // skip unnamed nodes, not useful to show the model
    const latitude = el.lat ?? el.center?.lat;
    const longitude = el.lon ?? el.center?.lon;
    if (latitude === undefined || longitude === undefined) continue;
    const category =
      el.tags?.tourism ?? el.tags?.amenity ?? el.tags?.leisure ?? el.tags?.historic ?? "unknown";
    places.push({ name, category, latitude, longitude });
  }

  // De-duplicate by name (nodes and ways can both match the same place).
  const seen = new Set<string>();
  const deduped = places.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });

  return deduped.slice(0, limit);
}

export const getPointsOfInterestTool = createTool({
  id: "getPointsOfInterest",
  description:
    "Find real attractions, museums, landmarks, and restaurants near a city using the " +
    "Overpass API (OpenStreetMap data). Geocodes the city, then searches within a 5km " +
    "radius for tagged points of interest. Real data, no key required, but coverage " +
    "depends on how well-mapped the area is in OpenStreetMap. Optional category filter: " +
    "attraction, museum, gallery, viewpoint, restaurant, cafe, park, monument, landmark.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. 'Tokyo'"),
    category: z
      .string()
      .optional()
      .describe(
        "Optional filter, e.g. 'museum' or 'restaurant'. Omit to search a broad default mix."
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("Max number of results to return (default 20)"),
  }),
  outputSchema: z.object({
    city: z.string(),
    available: z.boolean(),
    message: z.string().optional(),
    results: z.array(
      z.object({
        name: z.string(),
        category: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        mapsUrl: z.string(),
      })
    ),
  }),
  execute: async ({ city, category, limit }) => {
    const location = await geocodeCity(city);
    const tags = category
      ? CATEGORY_TAGS[category.toLowerCase()] ?? DEFAULT_TAGS
      : DEFAULT_TAGS;
    try {
      const results = await queryOverpassNodes(
        location.latitude,
        location.longitude,
        DEFAULT_RADIUS_METERS,
        tags,
        limit ?? 20
      );
      return {
        city: location.name,
        available: true,
        results: results.map((r) => ({ ...r, mapsUrl: mapsUrlFor(r.latitude, r.longitude) })),
      };
    } catch (err) {
      if (err instanceof OverpassUnavailableError) {
        return {
          city: location.name,
          available: false,
          message: "Points of interest data is temporarily unavailable for this location right now — please try again shortly.",
          results: [],
        };
      }
      throw err;
    }
  },
});

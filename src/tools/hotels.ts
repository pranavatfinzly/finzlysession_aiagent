import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { geocodeCity } from "./weather.js";
import { queryOverpassNodes, mapsUrlFor, OverpassUnavailableError } from "./pointsOfInterest.js";

const DEFAULT_RADIUS_METERS = 5000;

export const getHotelsTool = createTool({
  id: "getHotels",
  description:
    "Find real hotels near a city using the Overpass API (OpenStreetMap data), searching " +
    "for tourism=hotel within a 5km radius of the city center. Returns only hotel name and " +
    "location (latitude/longitude) — OpenStreetMap does not carry pricing or availability, " +
    "so this tool cannot and does not provide rates, room availability, or booking info.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. 'Tokyo'"),
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
        latitude: z.number(),
        longitude: z.number(),
        mapsUrl: z.string(),
      })
    ),
  }),
  execute: async ({ city, limit }) => {
    const location = await geocodeCity(city);
    try {
      const places = await queryOverpassNodes(
        location.latitude,
        location.longitude,
        DEFAULT_RADIUS_METERS,
        [["tourism", "hotel"]],
        limit ?? 20
      );
      return {
        city: location.name,
        available: true,
        results: places.map((p) => ({
          name: p.name,
          latitude: p.latitude,
          longitude: p.longitude,
          mapsUrl: mapsUrlFor(p.latitude, p.longitude),
        })),
      };
    } catch (err) {
      if (err instanceof OverpassUnavailableError) {
        return {
          city: location.name,
          available: false,
          message: "Hotel data is temporarily unavailable for this location right now — please try again shortly.",
          results: [],
        };
      }
      throw err;
    }
  },
});

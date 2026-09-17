import { createTool } from "@mastra/core/tools";
import { z } from "zod";

interface Poi {
  name: string;
  category?: string;
  latitude?: number;
  longitude?: number;
}

function haversineKm(a: Poi, b: Poi): number {
  const R = 6371;
  const dLat = ((b.latitude! - a.latitude!) * Math.PI) / 180;
  const dLon = ((b.longitude! - a.longitude!) * Math.PI) / 180;
  const lat1 = (a.latitude! * Math.PI) / 180;
  const lat2 = (b.latitude! * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Greedy nearest-neighbor ordering so spatially close POIs end up adjacent. */
function orderByProximity(pois: Poi[]): Poi[] {
  const remaining = [...pois];
  const ordered: Poi[] = [remaining.shift()!];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(last, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

/** Splits an ordered list into `days` contiguous chunks, sized as evenly as possible. */
function chunkIntoDays<T>(items: T[], days: number): T[][] {
  const chunks: T[][] = [];
  const base = Math.floor(items.length / days);
  const remainder = items.length % days;
  let idx = 0;
  for (let d = 0; d < days; d++) {
    const size = base + (d < remainder ? 1 : 0);
    chunks.push(items.slice(idx, idx + size));
    idx += size;
  }
  return chunks;
}

export const buildItineraryTool = createTool({
  id: "buildItinerary",
  description:
    "Organize an already-retrieved list of points of interest into a simple day-by-day " +
    "itinerary. This is local synthesis logic — it does NOT fetch any new data, it only " +
    "structures points of interest you already retrieved (e.g. via getPointsOfInterest) " +
    "into a plan across the given number of days. If coordinates are available, POIs are " +
    "grouped by proximity so each day's plan stays geographically clustered.",
  inputSchema: z.object({
    city: z.string().describe("City the itinerary is for"),
    days: z.number().int().positive().describe("Number of days to plan for"),
    pointsOfInterest: z
      .array(
        z.object({
          name: z.string(),
          category: z.string().optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
        })
      )
      .describe("Points of interest to distribute across the itinerary"),
  }),
  outputSchema: z.object({
    city: z.string(),
    itinerary: z.array(
      z.object({
        day: z.number(),
        items: z.array(
          z.object({
            name: z.string(),
            category: z.string().optional(),
          })
        ),
      })
    ),
  }),
  execute: async ({ city, days, pointsOfInterest }) => {
    const allHaveCoords = pointsOfInterest.every(
      (p) => p.latitude !== undefined && p.longitude !== undefined
    );
    const ordered = allHaveCoords
      ? orderByProximity(pointsOfInterest)
      : pointsOfInterest;
    const chunks = chunkIntoDays(ordered, days);

    return {
      city,
      itinerary: chunks.map((items, i) => ({
        day: i + 1,
        items: items.map((p) => ({ name: p.name, category: p.category })),
      })),
    };
  },
});

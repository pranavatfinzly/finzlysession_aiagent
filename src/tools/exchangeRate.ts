import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const getExchangeRateTool = createTool({
  id: "getExchangeRate",
  description:
    "Get the current exchange rate between two currencies using the Frankfurter API " +
    "(https://www.frankfurter.app), which sources rates from the European Central Bank. " +
    "Real API, no key required. Use ISO currency codes, e.g. base='USD', target='JPY'.",
  inputSchema: z.object({
    base: z.string().length(3).describe("3-letter ISO currency code to convert from, e.g. 'USD'"),
    target: z.string().length(3).describe("3-letter ISO currency code to convert to, e.g. 'JPY'"),
  }),
  outputSchema: z.object({
    base: z.string(),
    target: z.string(),
    rate: z.number(),
    date: z.string(),
  }),
  execute: async ({ base: rawBase, target: rawTarget }) => {
    const base = rawBase.toUpperCase();
    const target = rawTarget.toUpperCase();
    const url = `https://api.frankfurter.app/latest?from=${base}&to=${target}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Exchange rate request failed with status ${res.status}`);
    }
    const data = (await res.json()) as {
      date: string;
      rates: Record<string, number>;
    };
    const rate = data.rates[target];
    if (rate === undefined) {
      throw new Error(`Frankfurter API did not return a rate for ${target}`);
    }
    return { base, target, rate, date: data.date };
  },
});

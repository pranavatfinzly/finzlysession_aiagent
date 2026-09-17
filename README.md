# Travel Planning Agent — a Mastra + OpenRouter worked example

This repo is a small, complete AI agent built with [Mastra](https://mastra.ai) (a
TypeScript-native agent framework) and [OpenRouter](https://openrouter.ai) (a
model-routing API that gives one key access to many providers' models). It plans trips: weather, currency, points of interest, hotels,
packing advice, and day-by-day itineraries — by giving a language model a set of tools
and letting it decide, on its own, which ones to call and in what order.

It exists as a **teaching example**, not a product. The goal is to make the core
concepts behind "AI agents" concrete: what a tool actually is, how a model decides to
use one, what "reasoning" looks like at the API level, and what actually breaks when you
wire real (not mocked) APIs into an agent.

---

## 1. The concepts this project demonstrates

If you're new to agent frameworks, here's the vocabulary you need before the code makes
sense.

**LLM (the model).** A language model like the ones served through OpenRouter. On its own, an LLM
can only generate text — it can't check today's weather or look up a hotel. It knows
this, and if you tell it "you may ask for help," it will.

**Tool (a.k.a. function).** A regular TypeScript function, described to the model with a
name, a plain-English description, and a schema of its inputs/outputs. The model never
executes the function itself — it outputs a structured request ("call `getWeatherForecast`
with `{city: "Tokyo"}`"), your code runs the real function, and the result is fed back
into the conversation as if a very fast, very reliable colleague had just answered.

**Tool calling / function calling.** The protocol that makes the above possible. It's a
capability of the model itself (not every model supports it — see §5), where instead of
just replying with text, the model can reply with "please call this function with these
arguments." This project's whole design rests on this capability.

**Agent.** An LLM + a system prompt (instructions) + a set of tools, wired together so
the model can call tools, see their results, and decide whether it needs to call more
tools before giving a final answer. This is the "agentic loop": *think → maybe act → see
result → think again → ... → answer*. This project has exactly one agent
(`src/agent.ts`), registered with 7 tools.

**Multi-step tool chaining.** The interesting part. Nobody tells the agent "first call
weather, then call hotels, then build the itinerary." Its instructions just describe
what each tool is for; the model reads the user's question, decides which tools are
relevant, and calls them — sometimes several in the same turn, sometimes none at all if
the question doesn't need them. §7 shows a real captured example of this happening.

**Reasoning trace.** Every tool call, its inputs, its real result, and the model's own
"thinking out loud" text are all captured as structured data, not just the final answer.
This is what makes agents debuggable: you can see *why* the model called a particular
tool and *what it actually got back*, not just the polished response at the end.

**Playground (`mastra dev`).** Mastra ships a local web UI that renders exactly this
trace — you type a message, and you see the model's reasoning, each tool call, and each
tool's real result appear inline as the agent works, before the final answer. This is
the main way you'll interact with this project.

---

## 2. Architecture

```
                    ┌─────────────────────────────┐
   user message ──▶ │   Travel Planning Agent      │
                    │   (src/agent.ts)             │
                    │                              │
                    │   model: OpenRouter (gpt-4o-mini) │
                    │   instructions: <prose>      │◀── the model reads this and
                    │   tools: { 7 tools }         │    decides what to call
                    └───────────┬──────────────────┘
                                │ model requests a tool call
                                ▼
                    ┌─────────────────────────────┐
                    │   src/tools/*.ts              │
                    │   (plain TypeScript functions)│
                    └───────────┬──────────────────┘
                                │ real HTTP request
                                ▼
                    Open-Meteo · Frankfurter · Overpass (OSM)
```

The agent doesn't know anything about HTTP, JSON parsing, or API keys — that's all
inside the tools. The agent only sees: a tool's name, its description, and its
input/output shape. This separation is deliberate and is how every serious agent
framework is structured: **the model plans, your code executes.**

```
travel-agent/
├── src/
│   ├── tools/
│   │   ├── weather.ts           # getWeatherForecast + getTimezoneInfo (real API: Open-Meteo)
│   │   ├── exchangeRate.ts      # getExchangeRate (real API: Frankfurter)
│   │   ├── packingSuggestion.ts # getPackingSuggestion — local logic, NO api call
│   │   ├── pointsOfInterest.ts  # getPointsOfInterest (real API: Overpass / OpenStreetMap)
│   │   ├── hotels.ts            # getHotels (real API: Overpass / OpenStreetMap)
│   │   └── itinerary.ts         # buildItinerary — local logic, NO api call
│   ├── agent.ts                 # the agent: model + instructions + all 7 tools registered
│   └── mastra/
│       └── index.ts             # tells `mastra dev` where to find the agent
├── .env.example                 # copy to .env and fill in
├── package.json
└── README.md                    # you are here
```

---

## 3. The agent (`src/agent.ts`)

```ts
export const travelAgent = new Agent({
  id: "travel-agent",
  name: "Travel Planning Agent",
  instructions: `...`,          // <- the ONLY place tool order is "suggested", in prose
  model: "openrouter/openai/gpt-4o-mini",
  defaultOptions: { maxSteps: 15 },
  tools: { getWeatherForecast, getTimezoneInfo, getExchangeRate,
           getPackingSuggestion, getPointsOfInterest, getHotels,
           buildItinerary },
});
```

Four things worth noticing:

- **`instructions` is plain English, not a control-flow diagram.** It tells the model
  what each tool is for and what caveats to mention (e.g. "hotels have no pricing"), but
  it never says "call X before Y." The model figures out the right order itself from the
  user's question and what it's already learned.
- **`model: "openrouter/openai/gpt-4o-mini"` is a string, not an SDK object.** This is
  Mastra's *model router* — a single string of the form `"<provider>/<model-id>"` that
  Mastra resolves internally, reading the provider's API key from the environment
  (`OPENROUTER_API_KEY` here) automatically. No provider SDK package needs to be
  installed or imported. See §5 for why this specific model was chosen.
- **`tools` is just an object mapping names to tool definitions.** Nothing here says
  which tools work together — that connective reasoning happens entirely inside the
  model at request time.
- **`defaultOptions: { maxSteps: 15 }` raises Mastra's default step cap of 5.** Each
  tool call (and its result) consumes one step, and the final text answer consumes one
  more. A full trip-planning request chains 6+ tool calls before the model can write its
  answer, so the default of 5 cuts the agent off mid-chain — it returns with
  `finishReason: "tool-calls"` and an **empty final answer**, having done all the real
  work but never gotten to say so. This was the main reason the agent looked "broken."

---

## 4. The 7 tools

Two are pure local logic — the tool description tells the model this explicitly, so it
doesn't mistake structured output for a live data source. The other five call real,
non-mocked APIs.

| Tool | Type | Real API | What it needs |
|---|---|---|---|
| `getWeatherForecast` | Real API | [Open-Meteo](https://open-meteo.com) | nothing (keyless) |
| `getTimezoneInfo` | Real API | Open-Meteo (reuses the weather call's response) | nothing (keyless) |
| `getExchangeRate` | Real API | [Frankfurter](https://frankfurter.app) (ECB rates) | nothing (keyless) |
| `getPointsOfInterest` | Real API | [Overpass API](https://overpass-api.de) (OpenStreetMap) | nothing (keyless) |
| `getHotels` | Real API | Overpass API (OpenStreetMap) | nothing (keyless) |
| `getPackingSuggestion` | Local logic | — | — |
| `buildItinerary` | Local logic | — | — |

### `getWeatherForecast(city)` / `getTimezoneInfo(city)` — `src/tools/weather.ts`

Both geocode the city name via Open-Meteo's geocoding endpoint (city name → lat/lon),
then call Open-Meteo's forecast endpoint. **`getTimezoneInfo` doesn't call a second API**
— the forecast response already includes `timezone` and `utc_offset_seconds`, so reusing
it avoids depending on a second, less reliable provider for something the first call
already gave us. This is a small but real API-design lesson: *don't add a dependency for
data you already have.*

### `getExchangeRate(base, target)` — `src/tools/exchangeRate.ts`

One call to Frankfurter, which publishes official European Central Bank rates daily.
Fully keyless, no rate limit concerns.

### `getPointsOfInterest(city, category?)` / `getHotels(city)` — `src/tools/pointsOfInterest.ts`, `src/tools/hotels.ts`

Both geocode the city, then query the **Overpass API** — a query interface over
OpenStreetMap's crowd-sourced map data. The query asks: "give me every node/way within
5km of this point tagged `tourism=attraction`, `tourism=museum`, `amenity=restaurant`
(or `tourism=hotel` for the hotels tool)." This is real, live, community-maintained data
— there's no vendor here to have an outage or deprecate an endpoint, but coverage
genuinely varies by how well-mapped a place is (a huge global city like Tokyo or Paris
is richly mapped; a small town might return almost nothing).

`getHotels` explicitly returns **only name and location** — OpenStreetMap doesn't carry
pricing or availability data, and the tool's description says so plainly, so the model
never implies to a user that it has prices it doesn't have.

### `getPackingSuggestion(weatherSummary, temperatureC?)` — `src/tools/packingSuggestion.ts`

**No API call at all.** This is plain TypeScript logic: it pattern-matches on words like
"rain," "snow," "hot" in a weather description (plus an optional temperature) and maps
them to a packing list. It exists to show that not every tool needs to be a network
call — sometimes the right "tool" is just a deterministic function that turns data the
model already has into something more useful, and it's typically used right after
`getWeatherForecast` in a chain.

### `buildItinerary(city, days, pointsOfInterest)` — `src/tools/itinerary.ts`

Also **no API call**. It takes a list of points of interest (normally whatever
`getPointsOfInterest` just returned) and a number of days, and organizes them into a
day-by-day plan. If every POI has coordinates, it runs a simple nearest-neighbor
ordering first (so you're not zig-zagging across a city) and then splits that ordered
list evenly across days. This tool's description is explicit that it's **synthesis, not
a data source** — it never invents attractions, it only organizes ones the model already
retrieved.

---

## 5. The model: OpenRouter, and why `gpt-4o-mini`

Mastra's model router (`model: "openrouter/<id>"`) resolves models using
`OPENROUTER_API_KEY` from the environment — no SDK package to install, no client object
to construct. That's the whole integration, and it works with any model OpenRouter
serves, from any underlying provider, just by changing the string.

Picking *which* model to use turned into a real lesson in why you always verify against
the live provider instead of trusting a plan written in advance. This project was
originally built against Groq, then moved to OpenRouter; on OpenRouter, two real,
observed failures shaped the final choice:

| Model tried | What happened |
|---|---|
| `openai/gpt-oss-20b` | Tool calling itself worked, but on multi-step chains (6+ tool calls) the model's **final** turn sometimes came back with only "reasoning" content and no visible text — `finishReason: "stop"` but an empty answer, after every tool call had already run correctly. This is a known quirk of the gpt-oss family's "harmony" response format: reasoning and final-answer text share a channel that OpenRouter/the AI SDK don't always split cleanly, and the split failure got worse as the conversation grew. |
| **`openai/gpt-4o-mini`** | **Works** — confirmed with real, live multi-tool chains ending in a full text answer (see §6). Solid, well-tested tool-calling support, ~$0.15/$0.60 per million input/output tokens on OpenRouter. |

**The second, separate bug (not model-specific):** even with a model that answers
reliably, Mastra's agent-level default for `maxSteps` is **5**. A full trip-planning
request needs 6+ steps (one per tool call, plus one for the final answer), so without
raising it the agent got cut off *every time* on anything beyond a single-tool question
— it did all the right tool calls and then simply never got a turn to write the answer.
Fixed in `src/agent.ts` with `defaultOptions: { maxSteps: 15 }`.

**The takeaway for anyone extending this project:** not every model that a provider
serves supports function calling equally well, even among ones that claim to — and a
model that calls tools correctly can still fail to hand back a final answer for reasons
that have nothing to do with the tools. Always run the actual multi-step conversation you
intend to demo, not just a single tool call, before trusting a model+framework
combination.

---

## 6. What was actually verified (not assumed)

Everything below was run for real against live APIs — no mocked responses anywhere in
this project.

**Overpass (OpenStreetMap), two cities:**
- Tokyo: 28 named attractions/museums/restaurants, 30 named hotels — all real place
  names and coordinates.
- Paris: 30 named attractions/museums/restaurants (a hotels query hit one transient
  `504` from Overpass's free public server under load — a known characteristic of that
  shared instance, not a bug).

One real fix was needed here: Overpass's server returns `406 Not Acceptable` for POST
requests that don't send explicit `Accept`/`User-Agent` headers. The tools use `GET`
with those headers instead, which is reliable.

**Genuine multi-tool chaining, captured live:**

Asked the agent: *"Plan me a 3-day trip to Tokyo starting next Tuesday. Include weather,
points of interest, hotels, packing suggestions, and a day-by-day itinerary."* With zero
hardcoded sequencing, it decided on its own, in one turn, to call:

```
getWeatherForecast → getPointsOfInterest → getHotels → getPackingSuggestion → buildItinerary
```

Real data came back for weather, points of interest, and hotels, and the model wrote a
full day-by-day plan from it — with `finishReason: "stop"` and a real, non-empty final
answer (the failure mode described in §5 no longer reproduces with `gpt-4o-mini` +
`maxSteps: 15`).

**The reasoning trace itself:** every one of the tool calls above showed up as a
structured sequence — the model's own reasoning text, then a `tool-call` entry with the
exact arguments, then a `tool-result` entry with the real API response — which is
precisely the data Mastra's playground renders inline as you chat. That's what you
should expect to see live in `mastra dev`.

---

## 7. Try it yourself

```bash
npm install
cp .env.example .env     # fill in OPENROUTER_API_KEY (see below)
npm run dev
```

Open **http://localhost:4111**, pick **Travel Planning Agent**, and try:

- `"What's the weather in Tokyo right now?"` — a good first test; one tool call, cheap
  and fast.
- `"What should I pack for a trip to Paris in November?"` — should chain weather →
  packing suggestion.
- `"Find me some museums and restaurants in Rome."` — one call to
  `getPointsOfInterest`, category filter in action.
- `"Plan me a 3-day trip to Tokyo starting next Tuesday."` — the full demo: watch the
  playground show each tool call and its real result appear inline, in whatever order
  the model decides, before it writes the final answer.

Watch the **reasoning trace** in the playground as each response streams in — that's the
whole point of using the playground instead of a plain chat UI: you see the model's
intermediate thinking and every tool call's real input/output, not just the final
polished text.

### Environment variables

| Variable | Used for | Required? |
|---|---|---|
| `OPENROUTER_API_KEY` | The model itself (via OpenRouter) | Yes |

Everything else (`getWeatherForecast`, `getTimezoneInfo`, `getExchangeRate`,
`getPointsOfInterest`, `getHotels`) is fully keyless.

---

## 8. Design decisions worth calling out

**Why the agent looked "broken" before, and what actually fixed it.** Two independent
bugs compounded: the agent's `maxSteps` was left at Mastra's default of 5 (too low for
the 6+ step chains a real trip-planning request needs), and the model in use,
`gpt-oss-20b`, could drop its own final answer on longer conversations (see §5). Fixed
by raising `maxSteps` to 15 and switching to `gpt-4o-mini`, both in `src/agent.ts`,
verified end-to-end against the live APIs (§6).

**Why no flight- or train-search tool.** Flight search was tried against RapidAPI's Sky
Scrapper API, but it wasn't reliable enough (rate limits, quota exhaustion) to keep as
part of an end-to-end demo, so it was removed. There's also no viable free/keyless API
for Indian rail data. Building either against a fake or scraped-without-permission
source would have violated this project's "no mock/fabricated data" ground rule, so both
were left out entirely rather than faked. When a real capability genuinely isn't
available or isn't reliable, saying so beats simulating it.

**A network quirk you might hit locally.** If your machine sits behind a corporate HTTPS
inspection proxy (e.g. Zscaler), Node.js won't trust that proxy's root certificate by
default, even though your browser does — every `fetch()` call in every tool will fail
with `unable to get local issuer certificate`. Fix: export your proxy's root CA to a
`.pem` file and run with `NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem npm run dev`. This is
a local network setup detail, not something a project can bake in generically (the CA is
different on every corporate network).

---

## 9. Where to go from here

If you're using this repo as a starting point for your own agent:

- Add a tool by copying the shape of any file in `src/tools/`: a `createTool({...})`
  call with an `id`, a `description` the model will actually read, a Zod
  `inputSchema`/`outputSchema`, and an `execute` function. Register it in the `tools: {}`
  object in `src/agent.ts` — that's the entire integration surface.
- Try swapping the model string in `src/agent.ts` to a different model on OpenRouter
  (`"openrouter/anthropic/claude-..."`, `"openrouter/google/gemini-..."`, etc.), or to a
  different provider entirely — Mastra's model router supports the same
  `"provider/model"` string pattern across many providers, reading each one's own API
  key from the environment. If you do, re-run the full multi-tool trip-planning request
  from §7, not just a single-tool question — that's the one that exposed both bugs
  in §5/§8.
- Watch what changes in the playground's reasoning trace when you rewrite the
  `instructions` prose in `src/agent.ts` — that's the fastest way to build intuition for
  how much of an agent's behavior lives in plain English rather than in code.

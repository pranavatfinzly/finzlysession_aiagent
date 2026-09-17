import { Mastra } from "@mastra/core";
import { travelAgent } from "../agent.js";

// Thin entry point so `mastra dev` (which auto-discovers src/mastra/index.ts)
// can find the agent. The agent and all tool definitions live in
// src/agent.ts and src/tools/, per the project's requested layout.
export const mastra = new Mastra({
  agents: { travelAgent },
});

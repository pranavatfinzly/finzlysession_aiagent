// Must be the very first import: patches Node's global HTTPS trust store with
// the Windows OS certificate store (Trusted Root Certification Authorities),
// so requests through a corporate TLS-inspecting proxy (e.g. Zscaler) are
// trusted. Node otherwise ships its own static CA bundle and ignores the OS
// store, which is what causes UNABLE_TO_GET_ISSUER_CERT_LOCALLY on networks
// like this one. Equivalent to what the `truststore` library does for Python.
//
// The bare import only patches `https.globalAgent` (legacy `https`/`http`
// module traffic). The AI SDK / Mastra model router — and most modern
// fetch-based libraries — use Node's built-in `fetch` (undici), which never
// goes through `https.globalAgent`, so it stays untrusted without also
// switching win-ca's injection mode to `'+'`: that patches
// `tls.createSecureContext` itself, which every secure connection (including
// undici/fetch) goes through.
//
// Imported as the package root ("win-ca"), not the "win-ca/fallback" subpath:
// win-ca ships no `exports` map, and Mastra's bundler mis-serializes that
// subpath's resolved filesystem path (backslashes on Windows) into an
// ESM import specifier, which Node then rejects as invalid.
import ca from "win-ca";
ca.inject("+");

import { Mastra } from "@mastra/core";
import { travelAgent } from "../agent.js";

// Thin entry point so `mastra dev` (which auto-discovers src/mastra/index.ts)
// can find the agent. The agent and all tool definitions live in
// src/agent.ts and src/tools/, per the project's requested layout.
export const mastra = new Mastra({
  agents: { travelAgent },
});

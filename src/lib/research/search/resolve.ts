import "server-only";

// Search-plan negotiation. Lives in the engine, never in a provider:
// providers never read search API keys, they just receive a resolved plan.

import type { ResearchProvider } from "../types";
import type { SearchBackend, SearchDirective, SearchPlan } from "./types";
import { createTavilyBackend } from "./backends/tavily";

function getBackend(): SearchBackend | null {
  const id = (process.env.SEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (id === "tavily") return createTavilyBackend();
  // brave/serper are typed in ./types but intentionally unimplemented —
  // an unwritten backend costs nothing, an unused one costs maintenance.
  return null;
}

export function resolveSearchPlan(
  provider: ResearchProvider,
  directive: SearchDirective
): SearchPlan {
  const backend = getBackend();

  // An explicitly configured backend wins: it is the only path that gives us
  // an exact retrieved-URL set, and on providers whose native search is
  // unavailable (Gemini free tier) it is the only path at all.
  if (backend?.isConfigured()) {
    return { mode: "host_tool", directive, backend };
  }

  if (provider.capabilities.search === "native") {
    return { mode: "provider_native", directive };
  }

  return { mode: "none" };
}

/** Human-readable reason the engine has no way to search, for the UI. */
export function describeSearchGap(provider: ResearchProvider): string | null {
  const backend = getBackend();
  if (backend?.isConfigured()) return null;
  if (provider.capabilities.search === "native") return null;
  if (backend) {
    return `Search backend ${backend.id} is missing ${backend
      .missingConfig()
      .join(", ")}.`;
  }
  return "No web search configured — set SEARCH_PROVIDER and its API key, or use a provider with native search.";
}

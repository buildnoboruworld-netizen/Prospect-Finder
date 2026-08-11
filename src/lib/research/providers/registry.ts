import "server-only";

// id → provider instance. Construction is pure (no env reads, no network, no
// throwing), so resolving a provider is safe from a boolean predicate like
// isResearchConfigured(); only generate() ever talks to a vendor.
//
// An id with no adapter fails loudly rather than falling back to another
// provider: a misconfigured run must never quietly produce fiction.

import { getProviderId } from "../config";
import type { ResearchProvider, ResearchProviderId } from "../types";
import { ProviderError } from "../types";
import { createAnthropicProvider } from "./anthropic";
import { createDemoProvider } from "./demo";
import { createGeminiProvider } from "./gemini";

type ProviderFactory = () => ResearchProvider;

// Every id in ResearchProviderId must appear here — a full Record, not a
// Partial, so adding an id without an adapter is a compile error rather than
// a runtime "no provider implemented" that only shows up on a live run.
const FACTORIES: Record<ResearchProviderId, ProviderFactory> = {
  anthropic: createAnthropicProvider,
  gemini: createGeminiProvider,
  demo: createDemoProvider,
};

const instances = new Map<ResearchProviderId, ResearchProvider>();

export function getProvider(): ResearchProvider {
  return getProviderById(getProviderId());
}

export function getProviderById(id: ResearchProviderId): ResearchProvider {
  const cached = instances.get(id);
  if (cached) return cached;

  const factory = FACTORIES[id];
  if (!factory) {
    throw new ProviderError(
      "unsupported",
      `No research provider is implemented for "${id}". Set RESEARCH_PROVIDER to ` +
        `one of: ${Object.keys(FACTORIES).join(", ")}.`
    );
  }

  const provider = factory();
  instances.set(id, provider);
  return provider;
}

import "server-only";

// The research engine's public surface. Everything the app is allowed to know
// about research goes through here: one predicate that never throws, one
// description of what is wired up, and one unit of work.

import { getProviderId } from "./config";
import { advanceRun, searchModeFor, type AdvanceResult } from "./engine";
import { getProviderById } from "./providers/registry";
import type { SearchMode } from "./search/types";
import type { ResearchProviderId, SourceFidelity } from "./types";

export { advanceRun };
export type { AdvanceResult };

export interface ResearchProviderInfo {
  id: ResearchProviderId;
  modelId: string;
  /** True for the fixture provider: every lead it produces is invented. */
  sample: boolean;
  searchMode: SearchMode;
  sourceFidelity: SourceFidelity;
  safeForContactData: boolean;
  /** PriceBook.note — belongs next to any cost figure, which is an estimate. */
  priceNote: string;
  configured: boolean;
  /** Env var names to set, for the "not configured yet" message. */
  missingConfig: string[];
}

/**
 * Mirrors isSheetsConfigured(): a boolean that never throws, so a page can
 * render a disabled CTA without a try/catch. RESEARCH_PROVIDER may name a
 * provider with no adapter behind it, which is a configuration answer, not a
 * crash.
 */
export function isResearchConfigured(): boolean {
  try {
    const provider = getProviderById(getProviderId());
    if (!provider.isConfigured()) return false;
    // A provider that can search but has no way to do so would retrieve
    // nothing and drop every lead for having no sources — a confusing way to
    // fail, so it counts as unconfigured.
    return (
      provider.capabilities.search === "none" || searchModeFor(provider) !== "none"
    );
  } catch {
    return false;
  }
}

/** Null when RESEARCH_PROVIDER names a provider this build has no adapter for. */
export function getResearchProviderInfo(): ResearchProviderInfo | null {
  try {
    const provider = getProviderById(getProviderId());
    return {
      id: provider.id,
      modelId: provider.modelId,
      sample: provider.id === "demo",
      searchMode: searchModeFor(provider),
      sourceFidelity: provider.capabilities.sourceFidelity,
      safeForContactData: provider.capabilities.safeForContactData,
      priceNote: provider.priceBook.note,
      configured: isResearchConfigured(),
      missingConfig: provider.missingConfig(),
    };
  } catch {
    return null;
  }
}

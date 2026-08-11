// Stage 2 — breadth.
//
// Two filters run on the way out, both deterministic, because both decide how
// the expensive stage spends its money: a candidate the model should have
// excluded costs a qualify slot, and a candidate whose only "source" was never
// retrieved would be dropped at score time anyway (PRD §6.1) — after we had
// paid to deep-dive it.

import { normalizeDomain, normalizeIgHandle, normalizeName } from "@/lib/normalize";
import type { CompanySource } from "@/lib/types";
import { urlKey } from "../citations";
import type { Candidate, DiscoverOutput, SeedPlan, StageIO } from "../contracts";
import { buildDiscoverPrompt } from "../prompts/discover";
import type { PromptOptions } from "../prompts/system";
import { discoverOutputSchema, type DiscoverOutputRaw } from "../schemas";
import type { ProviderCall } from "../types";

type StageContext = Omit<
  ProviderCall,
  "stage" | "system" | "messages" | "outputSchema" | "outputSchemaName"
>;

export function buildDiscoverCall(
  input: StageIO["discover"]["input"],
  ctx: StageContext,
  opts: PromptOptions
): ProviderCall {
  const prompt = buildDiscoverPrompt(input, opts);
  return {
    ...ctx,
    stage: "discover",
    system: prompt.system ?? "",
    messages: prompt.messages,
    outputSchema: discoverOutputSchema,
    outputSchemaName: "DiscoverOutput",
  };
}

export function toDiscoverOutput(
  raw: DiscoverOutputRaw,
  plan: SeedPlan,
  retrievedUrls: Set<string>
): DiscoverOutput {
  const excludedNames = normalizedSet(plan.exclusionBrands, normalizeName);
  const excludedDomains = normalizedSet(plan.exclusionDomains, normalizeDomain);
  const excludedHandles = normalizedSet(plan.exclusionHandles, normalizeIgHandle);

  const candidates: Candidate[] = [];
  const excluded = [...raw.excluded];
  const claimed = new Set<string>();

  for (const candidate of raw.candidates) {
    const id = identity(candidate);

    // Never trust the model to have honoured the list it was given.
    if (
      (id.name !== null && excludedNames.has(id.name)) ||
      (id.domain !== null && excludedDomains.has(id.domain)) ||
      (id.handle !== null && excludedHandles.has(id.handle))
    ) {
      excluded.push({ name: candidate.name, reason: "duplicate" });
      continue;
    }

    const keys = identityKeys(id);
    if (keys.some((key) => claimed.has(key))) {
      excluded.push({ name: candidate.name, reason: "duplicate" });
      continue;
    }

    const sources = keepRetrievedSources(candidate.sources, retrievedUrls);
    if (sources.length === 0) {
      excluded.push({ name: candidate.name, reason: "no_source" });
      continue;
    }

    for (const key of keys) claimed.add(key);
    candidates.push({ ...candidate, sources });
  }

  return { candidates, excluded };
}

/**
 * Keeps the sources that name a page this run actually opened, deduped by
 * canonical URL. Lives here because discovery is where a URL first has to earn
 * its place; qualify reuses it so both stages mean the same thing by "source".
 */
export function keepRetrievedSources(
  sources: CompanySource[],
  retrievedUrls: Set<string>
): CompanySource[] {
  const kept: CompanySource[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    const key = urlKey(source.url);
    if (key === null || seen.has(key) || !retrievedUrls.has(key)) continue;
    seen.add(key);
    kept.push(source);
  }
  return kept;
}

interface Identity {
  name: string | null;
  domain: string | null;
  handle: string | null;
}

function identity(candidate: {
  name: string;
  domain: string | null;
  instagramHandle: string | null;
}): Identity {
  return {
    name: normalizeName(candidate.name),
    domain: normalizeDomain(candidate.domain),
    handle: normalizeIgHandle(candidate.instagramHandle),
  };
}

// Prefixed so a brand called "example.com" cannot collide with a domain.
function identityKeys(id: Identity): string[] {
  const keys: string[] = [];
  if (id.name !== null) keys.push(`n:${id.name}`);
  if (id.domain !== null) keys.push(`d:${id.domain}`);
  if (id.handle !== null) keys.push(`i:${id.handle}`);
  return keys;
}

function normalizedSet(
  values: string[],
  normalize: (raw: string | null | undefined) => string | null
): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized !== null) out.add(normalized);
  }
  return out;
}

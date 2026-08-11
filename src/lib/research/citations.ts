// Citation hygiene, provider-independent.
//
// The `via` tag is the honesty mechanism of the whole engine: a URL the model
// asserted but that no search ever returned must not be allowed to back a
// factual claim (PRD §6.1). guardrails.ts checks every source against the set
// built here, so this file decides what "we actually saw this page" means.

import type { Citation } from "./types";

// Campaign junk only — never touch params that select content (?p=, ?id=).
const TRACKING_PARAMS = /^(utm_[a-z0-9_]*|fbclid)$/i;

// A URL both retrieved and merely claimed is retrieved: keep the stronger tag.
const VIA_STRENGTH: Record<Citation["via"], number> = {
  provider_native: 2,
  search_api: 1,
  model_claim: 0,
};

/**
 * Canonical identity key for a URL, or null if it is not a parseable http(s)
 * URL. That null is a guardrail signal, not merely a parse failure — anything
 * unkeyable can never appear in the retrieved set and so can never ground a
 * claim.
 *
 * Two URLs differing only in trailing slash, campaign params, fragment, query
 * order, or a `www.` prefix name the same page. Collapsing those is what stops
 * a model citing `https://www.brand.com/about/?utm_source=x` from losing a
 * source the search returned as `https://brand.com/about`. `www.` is stripped
 * for the same reason normalizeDomain() strips it: in this codebase a host and
 * its www alias are one host.
 */
export function urlKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  if (host === "") return null;

  const path = parsed.pathname.replace(/\/+$/, "");
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  const query = params.length > 0 ? `?${params.join("&")}` : "";

  return `${parsed.protocol}//${host}${path}${query}`;
}

/** Gemini grounding wraps every citation in a Vertex AI Search redirect. */
export function isGroundingRedirect(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  return /(^|\.)vertexaisearch\.cloud\.google\.com$/i.test(parsed.hostname);
}

/**
 * Returns the URL unchanged — including for grounding redirects, deliberately.
 *
 * LIMITATION, stated rather than hidden: we cannot turn a vertexaisearch
 * redirect into its publisher URL server-side without an extra HTTP fetch per
 * citation, which we have neither the latency budget for (50s stage deadline)
 * nor the appetite to do — following model-supplied redirects from a
 * user-triggered run is a request-forgery surface. So the stored source is the
 * redirect, and those links expire: a source that was real at research time can
 * 404 weeks later. Providers whose citations arrive this way must report
 * sourceFidelity 'medium' so the run view says so out loud.
 *
 * It exists as a named seam: every citation path funnels through here, so the
 * day resolution becomes worth its cost it lands everywhere at once.
 */
export function resolveGroundingRedirect(url: string): string {
  return url;
}

/**
 * Dedupe by canonical URL, dropping anything unparseable. The surviving record
 * keeps the earliest retrievedAt (that is the timestamp we can defend) and the
 * strongest provenance. Insertion order is preserved so a run's citation list
 * is stable across replays.
 */
export function normalizeCitations(raw: Citation[]): Citation[] {
  const byKey = new Map<string, Citation>();

  for (const citation of raw) {
    const url = resolveGroundingRedirect(citation.url);
    const key = urlKey(url);
    if (key === null) continue;

    const next: Citation = { ...citation, url };
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? next : merge(existing, next));
  }

  return [...byKey.values()];
}

/**
 * The URLs a search genuinely returned this stage, as canonical keys.
 * `model_claim` citations are excluded by definition — the model asserted them,
 * we never observed them, and guardrail 4 exists to strip exactly those.
 */
export function buildRetrievedUrlSet(citations: Citation[]): Set<string> {
  const keys = new Set<string>();
  for (const citation of citations) {
    if (citation.via === "model_claim") continue;
    const key = urlKey(resolveGroundingRedirect(citation.url));
    if (key !== null) keys.add(key);
  }
  return keys;
}

function merge(first: Citation, later: Citation): Citation {
  const earliest = retrievedMs(later) < retrievedMs(first) ? later : first;
  return {
    url: first.url, // first-seen spelling, for stable output
    title: first.title ?? later.title,
    quotedText: first.quotedText ?? later.quotedText,
    retrievedAt: earliest.retrievedAt,
    via: VIA_STRENGTH[later.via] > VIA_STRENGTH[first.via] ? later.via : first.via,
  };
}

// An unparseable timestamp must never win "earliest" over a real one.
function retrievedMs(citation: Citation): number {
  const ms = Date.parse(citation.retrievedAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

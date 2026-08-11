import "server-only";

import type {
  SearchBackend,
  SearchQuery,
  SearchResponse,
} from "../types";

// Tavily search backend — host-executed web search.
//
// Why this exists: Gemini's free tier grants ZERO google_search grounding
// quota (verified 11 Aug 2026 — a plain call returns 200 while the same call
// with `tools:[{google_search:{}}]` returns 429), and gemini-2.5-flash, the
// one model with free grounding, is closed to new accounts. So on the free
// path we run the searches ourselves and feed the hits to the model as
// context.
//
// The upside beyond cost: because *we* execute every query, the set of URLs
// actually retrieved is known exactly, which is what lets guardrail 4 strip
// any source URL the model invented.

const ENDPOINT = "https://api.tavily.com/search";

// Free plan is ~1000 credits/month; a basic search costs 1 credit.
const COST_PER_THOUSAND_USD = 0;

/**
 * Short-lived response cache, keyed by query.
 *
 * A stage that times out is retried, and the retry re-plans the same queries
 * (the planner runs at temperature 0 for exactly this reason). Without a
 * cache each retry re-ran every search — burning credits and, worse, eating
 * the same seconds again so the retry had even LESS time to finish than the
 * attempt that just failed. That death spiral is what turned one slow call
 * into a dead run.
 *
 * In-process only: it is a within-run optimisation, not a durable store, and
 * a cold serverless instance simply searches again.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; res: SearchResponse }>();

function cacheGet(key: string): SearchResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // A cached hit costs no credit and no wall-clock, and must not be counted
  // as a search the run paid for.
  return { ...hit.res, searchesUsed: 0 };
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

export function createTavilyBackend(): SearchBackend {
  return {
    id: "tavily",

    isConfigured() {
      return Boolean(process.env.TAVILY_API_KEY);
    },

    missingConfig() {
      return process.env.TAVILY_API_KEY ? [] : ["TAVILY_API_KEY"];
    },

    costPerThousandUsd: COST_PER_THOUSAND_USD,

    async search(q: SearchQuery): Promise<SearchResponse> {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) {
        throw new Error("TAVILY_API_KEY missing — set it in .env.local.");
      }

      // Deliberately minimal payload. Passing a `country` field made Tavily
      // mis-parse the query and return dictionary definitions of a single
      // word instead of search results — India targeting belongs in the
      // query text, not in a parameter.
      const body = {
        query: q.site ? `${q.q} site:${q.site}` : q.q,
        max_results: Math.min(Math.max(q.count, 1), 20),
        search_depth: "basic" as const,
      };

      const key = `${body.query}::${body.max_results}`;
      const cached = cacheGet(key);
      if (cached) return cached;

      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Tavily search failed (${res.status}): ${detail.slice(0, 300)}`
        );
      }

      const json = (await res.json()) as { results?: TavilyResult[] };
      const hits = (json.results ?? [])
        .filter((r): r is TavilyResult & { url: string } => Boolean(r.url))
        .map((r) => ({
          url: r.url,
          title: r.title ?? r.url,
          snippet: r.content ?? "",
          publishedAt: r.published_date ?? null,
        }));

      const out: SearchResponse = { hits, searchesUsed: 1, costUsd: 0 };
      cache.set(key, { at: Date.now(), res: out });
      return out;
    },
  };
}

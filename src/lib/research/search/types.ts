// Search abstraction.
//
// Three shapes must fit one contract:
//   provider_native — the model runs its own search tool (Gemini grounding,
//                     Claude web_search). Best citations, one bill.
//   host_tool       — we execute searches ourselves against a search API and
//                     feed hits back. Full query control, weaker claim→URL
//                     binding. Not built yet; the type exists so the engine
//                     never has to change shape to gain it.
//   none            — no search (fixture/demo provider).
//
// Providers never read search API keys — config.ts resolves a SearchPlan and
// hands it over.

export interface SearchDirective {
  maxSearches: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  /** All ICP research is India-focused. */
  region: "IN";
  freshnessDays?: number;
}

export interface SearchQuery {
  q: string;
  count: number;
  site?: string;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
}

export interface SearchResponse {
  hits: SearchHit[];
  searchesUsed: number;
  costUsd: number;
}

export interface SearchBackend {
  readonly id: "brave" | "serper" | "tavily" | "demo";
  isConfigured(): boolean;
  missingConfig(): string[];
  search(q: SearchQuery): Promise<SearchResponse>;
  readonly costPerThousandUsd: number;
}

export type SearchMode = "provider_native" | "host_tool" | "none";

export type SearchPlan =
  | { mode: "provider_native"; directive: SearchDirective }
  | { mode: "host_tool"; directive: SearchDirective; backend: SearchBackend }
  | { mode: "none" };

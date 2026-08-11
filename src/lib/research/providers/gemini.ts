import "server-only";

import type { z } from "zod";
import {
  ProviderError,
  type Citation,
  type PriceBook,
  type ProviderCall,
  type ProviderCapabilities,
  type ProviderResponse,
  type ProviderUsage,
  type ResearchProvider,
  type StopReason,
} from "../types";
import type { SearchDirective, SearchHit } from "../search/types";

// ─────────────────────────────────────────────────────────────────────────────
// Gemini provider — free tier, no card. Raw REST via fetch; no SDK dependency.
//
// Two things about this file are load-bearing and easy to break by "improving"
// them: the pinned model id (see MODEL_ID) and the two-call shape of
// generate() (see the structuredOutputWithSearch comment). Both are commented
// where they live.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Model selection — verified against the live API on 11 Aug 2026.
 *
 * Gemini's free tier grants ZERO google_search grounding quota: a plain call
 * returns 200 while the identical call carrying `tools:[{google_search:{}}]`
 * returns 429, on every model this account can reach. The one model that does
 * have free grounding, `gemini-2.5-flash`, is closed to new accounts ("no
 * longer available to new users").
 *
 * So this provider does NOT ground itself. Web search is host-executed by the
 * engine (see search/backends/tavily.ts) and the hits are handed to the model
 * as context. That is also why capabilities.search is "host_tool" — leaving it
 * "native" would produce runs that succeed while finding nothing, because the
 * source guardrails correctly drop every unsourced lead.
 */
const DEFAULT_MODEL_ID = "gemini-3.6-flash";

/** Lazy: never read env at module scope — the build runs unconfigured. */
function resolveModelId(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL_ID;
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_OUTPUT_TOKENS = 8192;

/** How many search hits to feed the model per query. */
const HITS_PER_QUERY = 6;

const capabilities: ProviderCapabilities = {
  /**
   * Host-executed search, NOT native — the free tier has no grounding quota
   * (see the model comment above). The engine runs the queries and passes the
   * hits in as context.
   */
  search: "host_tool",
  /**
   * Verified 11 Aug 2026: `responseMimeType`/`responseSchema` and tool use are
   * not usable in the same request. generate() therefore runs two calls —
   * reasoning over the supplied hits first, tool-free schema shaping second.
   */
  structuredOutputWithSearch: false,
  structuredOutput: "json_mode",
  /**
   * "low", not "medium": because the engine executes the searches, the set of
   * URLs genuinely retrieved is known exactly — but which *claim* came from
   * which URL is only the model's assertion. Guardrail 4 can therefore strip
   * invented URLs, yet cannot confirm attribution. Claude's native search
   * returns per-claim citations, which is why it rates "high".
   */
  sourceFidelity: "low",
  /**
   * FALSE BECAUSE OF THE FREE TIER'S TERMS: Google may use submitted prompts
   * and responses to improve their products, and human reviewers may read
   * them. Real people's names, emails and phone numbers must not be sent
   * through it. The engine reads this flag and strips contact data before
   * calling this provider — that is why the flag exists rather than a warning
   * in a prompt. It flips to true only on a paid tier with the corresponding
   * data-use terms.
   */
  safeForContactData: false,
  promptCaching: false,
  suggestedQualifyBatchSize: 6,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
};

const priceBook: PriceBook = {
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
  searchPerThousand: 0,
  note:
    "Free tier — $0 billed. The real cap is quota, not money, and Google may " +
    "train on submitted data (so no contact data is sent). Web search is billed " +
    "separately by the search backend.",
};

// ── Gemini wire shapes (only the fields we read/send) ────────────────────────

interface GeminiPart {
  text?: string;
  /** Thinking output; never part of the answer. */
  thought?: boolean;
}

interface GeminiContent {
  role?: "user" | "model";
  parts?: GeminiPart[];
}

interface GeminiGroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  groundingSupports?: Array<{
    segment?: { text?: string };
    groundingChunkIndices?: number[];
  }>;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
    groundingMetadata?: GeminiGroundingMetadata;
  }>;
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: Array<{ google_search: Record<string, never> }>;
  generationConfig: {
    maxOutputTokens: number;
    temperature?: number;
    responseMimeType?: string;
    responseSchema?: GeminiSchema;
    /**
     * Gemini 3.x takes `thinkingLevel`; the old `thinkingBudget: 0` is
     * rejected outright with a 400 (verified 11 Aug 2026). "low" is the
     * cheapest setting that still returns an answer, and it emits zero
     * thinking tokens — which matters because these two calls are extraction
     * and reformatting, and thinking here just eats the output budget.
     */
    thinkingConfig?: { thinkingLevel: "low" | "medium" | "high" };
  };
}

// ── zod → Gemini schema ─────────────────────────────────────────────────────
//
// Gemini's responseSchema is an OpenAPI 3.0 subset, not JSON Schema: it
// rejects most keywords (minLength, pattern, format, additionalProperties,
// $ref, oneOf …). So this converter deliberately emits only
// type/properties/items/required/enum/nullable and drops every zod refinement.
// That is not a loss — schemas.ts re-validates the response in the engine, and
// it is the authoritative contract either way (see schemas.ts header).

type GeminiType = "STRING" | "NUMBER" | "BOOLEAN" | "ARRAY" | "OBJECT";

interface GeminiSchema {
  type: GeminiType;
  nullable?: boolean;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
}

/**
 * The subset of zod v4's `.def` shapes that schemas.ts actually uses. Anything
 * outside this list throws at build-request time rather than silently
 * producing a schema that does not describe the contract.
 */
type ZodDefLike =
  | { type: "object"; shape: Record<string, z.ZodType> }
  | { type: "array"; element: z.ZodType }
  | { type: "enum"; entries: Record<string, string | number> }
  | {
      type: "nullable" | "optional" | "default" | "catch" | "readonly" | "nonoptional";
      innerType: z.ZodType;
    }
  | { type: "string" | "number" | "boolean" };

function defOf(schema: z.ZodType): ZodDefLike {
  return schema.def as unknown as ZodDefLike;
}

/**
 * `.optional()` means the key may be absent. `.default()` and `.catch()` do
 * not — we still want the model to emit those keys (notably `sources`), and
 * zod fills them in if it doesn't.
 */
function isOptionalKey(schema: z.ZodType): boolean {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
      return true;
    case "default":
    case "catch":
    case "readonly":
      return isOptionalKey(def.innerType);
    default:
      return false;
  }
}

function zodToGeminiSchema(schema: z.ZodType): GeminiSchema {
  const def = defOf(schema);

  switch (def.type) {
    case "nullable":
      return { ...zodToGeminiSchema(def.innerType), nullable: true };

    case "optional":
    case "default":
    case "catch":
    case "readonly":
    case "nonoptional":
      return zodToGeminiSchema(def.innerType);

    case "object": {
      const properties: Record<string, GeminiSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(def.shape)) {
        properties[key] = zodToGeminiSchema(value);
        if (!isOptionalKey(value)) required.push(key);
      }
      const out: GeminiSchema = { type: "OBJECT", properties };
      if (required.length > 0) out.required = required;
      return out;
    }

    case "array":
      return { type: "ARRAY", items: zodToGeminiSchema(def.element) };

    case "enum":
      return {
        type: "STRING",
        enum: Object.values(def.entries).map((v) => String(v)),
      };

    case "string":
      return { type: "STRING" };

    case "number":
      return { type: "NUMBER" };

    case "boolean":
      return { type: "BOOLEAN" };

    default:
      throw new ProviderError(
        "unsupported",
        `zodToGeminiSchema cannot express zod type "${String(
          (def as { type: string }).type
        )}". Add a case, or keep the stage schema inside the supported subset.`
      );
  }
}

// ── prompting ───────────────────────────────────────────────────────────────

function describeDirective(directive: SearchDirective): string {
  const lines = [
    `- Use at most ${directive.maxSearches} searches.`,
    `- Region focus: India (${directive.region}).`,
  ];
  if (directive.allowedDomains?.length) {
    lines.push(`- Prefer these domains: ${directive.allowedDomains.join(", ")}.`);
  }
  if (directive.blockedDomains?.length) {
    lines.push(`- Do not cite these domains: ${directive.blockedDomains.join(", ")}.`);
  }
  if (directive.freshnessDays) {
    lines.push(`- Prefer sources from the last ${directive.freshnessDays} days.`);
  }
  // Gemini's google_search tool takes no configuration object, so the
  // directive can only be expressed as prose. It is advisory, which is why the
  // engine re-filters exclusions and validates sources itself.
  return lines.join("\n");
}

/** Gemini's own schema dialect — the query planner's tiny output shape. */
const QUERY_PLAN_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    queries: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["queries"],
};

function parseQueryPlan(text: string): string[] {
  const parsed = parseJsonAnswer(text);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    return [];
  }
  const queries = (parsed.value as { queries?: unknown }).queries;
  if (!Array.isArray(queries)) return [];
  const seen = new Set<string>();
  return queries
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter((q) => {
      const key = q.toLowerCase();
      if (q.length < 3 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Step 1 of the host-search loop: ask the model what to look up. */
function queryPlanInstruction(call: ProviderCall, directive: SearchDirective): string {
  return [
    "This is step 1 of 2. Do NOT answer the task yet.",
    "",
    `Write the web search queries needed to answer it — at most ${directive.maxSearches}.`,
    "They will be run verbatim against a search engine and the results handed back to you.",
    "",
    "Rules:",
    "- Write queries a person would type, not sentences.",
    "- Every query must target India (add \"India\" unless it is already implied).",
    "- Cover different angles: press coverage, startup directories, Instagram, the brands' own sites.",
    "- Prefer specific queries over broad ones; you get no second round.",
    describeDirective(directive),
    "",
    'Return JSON: {"queries": ["...", "..."]}',
  ].join("\n");
}

/** The retrieved evidence, rendered for the model. */
function formatHits(results: Array<{ query: string; hits: SearchHit[] }>): string {
  const blocks = results.map(({ query, hits }) => {
    if (hits.length === 0) return `SEARCH: ${query}\n  (no results)`;
    const lines = hits.map(
      (h) =>
        `  - ${h.title}\n    URL: ${h.url}\n    ${h.snippet.replace(/\s+/g, " ").slice(0, 600)}`
    );
    return `SEARCH: ${query}\n${lines.join("\n")}`;
  });
  return blocks.join("\n\n");
}

function hostSearchInstruction(call: ProviderCall, evidence: string): string {
  return [
    "This is step 2 of 2. Below are real web search results retrieved for you.",
    "",
    "Rules — these decide whether your output is usable:",
    "- Use ONLY the results below. You have no other knowledge of these companies.",
    "- Every URL you output must be copied verbatim from a `URL:` line below.",
    "  A URL that is not in this list will be discarded and may cost the whole lead.",
    "- Anything the results do not state is null. Never guess, never infer from the brand name.",
    "- If the results do not support enough companies, return fewer. Do not pad.",
    "",
    "SEARCH RESULTS",
    "--------------",
    evidence,
  ].join("\n");
}

function toGeminiContents(call: ProviderCall): GeminiContent[] {
  return call.messages.map((m) => ({
    role: m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: m.content }],
  }));
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * Aborts on whichever comes first: the engine's signal or the slice of the
 * stage deadline this call was given. Returns a cleanup that must run in a
 * `finally`, otherwise the timer keeps the request alive past the response.
 */
function linkAbort(
  outer: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer.reason);

  if (outer.aborted) controller.abort(outer.reason);
  else outer.addEventListener("abort", onOuterAbort, { once: true });

  const timer = setTimeout(
    () => controller.abort(new Error("Gemini call exceeded its stage deadline.")),
    Math.max(0, timeoutMs)
  );

  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      outer.removeEventListener("abort", onOuterAbort);
    },
  };
}

function apiMessageFrom(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const message = (parsed as GeminiResponseBody).error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Non-JSON error body (proxy/HTML). Fall through to the truncated text.
  }
  return bodyText.slice(0, 400);
}

/** Gemini reports the wait in prose: "Please retry in 40.514918182s". */
function parseRetryAfterMs(bodyText: string): number | null {
  const m = /retry in ([\d.]+)s/i.exec(bodyText);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // +1s of slack, capped so a bad parse can never park a run for hours.
  return Math.min(Math.ceil(seconds * 1000) + 1_000, 120_000);
}

function mapHttpError(status: number, bodyText: string): ProviderError {
  const detail = apiMessageFrom(bodyText);
  if (status === 429) {
    // The free tier is ~20 requests/minute, and each stage costs two calls,
    // so a multi-batch run WILL hit this. The body carries the wait as
    // "Please retry in 40.5s" — honouring it is the difference between the
    // run pausing for a minute and the run dying.
    const retryAfterMs = parseRetryAfterMs(bodyText);
    return new ProviderError(
      "rate_limit",
      `Gemini rate limit hit (429). The free tier allows ~20 requests/minute. ` +
        `${retryAfterMs ? `Waiting ${Math.ceil(retryAfterMs / 1000)}s before the next attempt. ` : ""}${detail}`,
      true,
      retryAfterMs
    );
  }
  if (status === 401 || status === 403) {
    return new ProviderError(
      "auth",
      `Gemini rejected the API key (${status}). Check GEMINI_API_KEY. ${detail}`
    );
  }
  if (status === 400) {
    return new ProviderError("invalid_request", `Gemini rejected the request (400). ${detail}`);
  }
  if (status >= 500) {
    return new ProviderError("overloaded", `Gemini is unavailable (${status}). ${detail}`, true);
  }
  return new ProviderError("transport", `Gemini returned HTTP ${status}. ${detail}`);
}

async function callGemini(
  apiKey: string,
  modelId: string,
  body: GeminiRequestBody,
  outerSignal: AbortSignal,
  timeoutMs: number
): Promise<GeminiResponseBody> {
  const { signal, release } = linkAbort(outerSignal, timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/${modelId}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });

    const text = await res.text();
    if (!res.ok) throw mapHttpError(res.status, text);

    try {
      return JSON.parse(text) as GeminiResponseBody;
    } catch {
      throw new ProviderError("transport", "Gemini returned a non-JSON body.");
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderError("timeout", "Gemini call aborted (stage deadline or cancellation).");
    }
    throw new ProviderError(
      "transport",
      `Could not reach Gemini: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    release();
  }
}

// ── response reading ────────────────────────────────────────────────────────

function answerText(res: GeminiResponseBody): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.thought !== true && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

function mapFinishReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "STOP":
      return "complete";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "LANGUAGE":
      return "refusal";
    default:
      return "error";
  }
}

function count(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function mergeUsage(metas: GeminiUsageMetadata[], searches: number): ProviderUsage {
  let promptTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;

  for (const m of metas) {
    promptTokens += count(m.promptTokenCount);
    // Thinking tokens bill as output everywhere else, so count them here too —
    // the engine's ledger must not change meaning when the provider changes.
    outputTokens += count(m.candidatesTokenCount) + count(m.thoughtsTokenCount);
    cacheReadInputTokens += count(m.cachedContentTokenCount);
  }

  return {
    // promptTokenCount already includes cached tokens; the engine adds
    // cacheRead on top, so subtract here to avoid double counting.
    inputTokens: Math.max(0, promptTokens - cacheReadInputTokens),
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens: 0,
    searches,
    searchesCountedBy: "provider",
    providerReportedCostUsd: 0, // free tier
    simulated: false,
  };
}

function parseJsonAnswer(text: string): { ok: boolean; value: unknown } {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = (fenced ? fenced[1] : text).trim();

  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    // JSON mode occasionally prefixes a sentence. Salvage the outermost span.
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
      } catch {
        // fall through
      }
    }
  }
  return { ok: false, value: text };
}

// ── the provider ────────────────────────────────────────────────────────────

function isConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function missingConfig(): string[] {
  return process.env.GEMINI_API_KEY ? [] : ["GEMINI_API_KEY"];
}

async function generate(call: ProviderCall): Promise<ProviderResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ProviderError("auth", "Gemini is not configured — set GEMINI_API_KEY in .env.local.");
  }
  const modelId = resolveModelId();

  const deadlineAt = Date.now() + call.limits.deadlineMs;
  const remainingMs = () => deadlineAt - Date.now();

  const warnings: string[] = [];
  const usageMetas: GeminiUsageMetadata[] = [];
  const maxOutputTokens = Math.max(
    1,
    Math.min(call.limits.maxOutputTokens, MAX_OUTPUT_TOKENS)
  );
  const responseSchema = zodToGeminiSchema(call.outputSchema);
  const systemInstruction = { parts: [{ text: call.system }] };

  const citations: Citation[] = [];
  let searches = 0;
  let findings: string | null = null;

  // ── Step 1: plan queries, then run them ourselves ────────────────────────
  //
  // The free tier has no grounding quota, so the engine's search backend does
  // the retrieval. Upside beyond cost: we end up holding the exact set of URLs
  // that were really fetched, which is what lets the engine strip any source
  // the model invents. Skipped when the engine planned no search — that yields
  // a lead with no citations, which the source guardrail is supposed to drop.
  // That is the honest outcome, not a bug to route around.
  if (call.search.mode === "host_tool") {
    const { directive, backend } = call.search;

    const planRes = await callGemini(
      apiKey,
      modelId,
      {
        contents: [
          ...toGeminiContents(call),
          { role: "user", parts: [{ text: queryPlanInstruction(call, directive) }] },
        ],
        systemInstruction,
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: QUERY_PLAN_SCHEMA,
          thinkingConfig: { thinkingLevel: "low" },
        },
      },
      call.signal,
      Math.floor(call.limits.deadlineMs * 0.2)
    );
    usageMetas.push(planRes.usageMetadata ?? {});

    const queries = parseQueryPlan(answerText(planRes)).slice(0, directive.maxSearches);
    if (queries.length === 0) {
      throw new ProviderError("transport", "Gemini returned no search queries to run.");
    }

    // Sequential, not parallel: the free search tier is rate-limited and a
    // burst gets us 429s. Bail out early if the stage clock runs down — a
    // partial evidence set still produces a valid (shorter) run.
    const results: Array<{ query: string; hits: SearchHit[] }> = [];
    const searchDeadline = deadlineAt - Math.floor(call.limits.deadlineMs * 0.35);
    for (const q of queries) {
      if (Date.now() > searchDeadline) {
        warnings.push(
          `Stage clock ran out after ${results.length}/${queries.length} searches; findings are partial.`
        );
        break;
      }
      try {
        const res = await backend.search({ q, count: HITS_PER_QUERY });
        results.push({ query: q, hits: res.hits });
        searches += res.searchesUsed;
        for (const hit of res.hits) {
          citations.push({
            url: hit.url,
            title: hit.title,
            quotedText: hit.snippet.slice(0, 300) || null,
            retrievedAt: new Date().toISOString(),
            // We executed this search, so the URL is genuinely retrieved —
            // this is what buildRetrievedUrlSet() trusts.
            via: "search_api",
          });
        }
      } catch (e) {
        warnings.push(
          `Search failed for "${q}": ${e instanceof Error ? e.message : "unknown error"}`
        );
      }
    }

    if (citations.length === 0) {
      throw new ProviderError(
        "transport",
        `All ${queries.length} searches came back empty via ${backend.id} — cannot research without evidence.`
      );
    }

    findings = formatHits(results);
  }

  // ── Call 2: schema shaping, no tools ─────────────────────────────────────
  if (remainingMs() < 2_000) {
    throw new ProviderError(
      "timeout",
      "Stage deadline was consumed by the grounded call; no time left to shape the JSON."
    );
  }

  const shapingContents: GeminiContent[] = toGeminiContents(call);
  if (findings !== null) {
    shapingContents.push({
      role: "user",
      parts: [{ text: hostSearchInstruction(call, findings) }],
    });
  }

  const shapedRes = await callGemini(
    apiKey,
    modelId,
    {
      contents: shapingContents,
      systemInstruction,
      generationConfig: {
        maxOutputTokens,
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema,
        // Pure reformatting. Left on, 2.5-flash can spend the whole output
        // budget thinking and return an empty candidate.
        thinkingConfig: { thinkingLevel: "low" },
      },
    },
    call.signal,
    remainingMs()
  );

  usageMetas.push(shapedRes.usageMetadata ?? {});

  const shapedBlock = shapedRes.promptFeedback?.blockReason;
  if (shapedBlock) {
    throw new ProviderError("refusal", `Gemini blocked the formatting prompt: ${shapedBlock}.`);
  }

  const finishReason = shapedRes.candidates?.[0]?.finishReason;
  const text = answerText(shapedRes);
  const parsed = parseJsonAnswer(text);

  if (!parsed.ok) {
    warnings.push("Gemini did not return parseable JSON; handing the raw text to the engine.");
  }
  if (finishReason === "MAX_TOKENS") {
    warnings.push(
      "JSON output hit max_tokens and is probably truncated; expect a validation failure."
    );
  }

  return {
    raw: parsed.value,
    citations,
    usage: mergeUsage(usageMetas, searches),
    stopReason: mapFinishReason(finishReason),
    modelId,
    warnings,
  };
}

export const geminiProvider: ResearchProvider = {
  id: "gemini",
  // Getter, not a constant: reading GEMINI_MODEL at module scope would break
  // the unconfigured build.
  get modelId() {
    return resolveModelId();
  },
  capabilities,
  priceBook,
  isConfigured,
  missingConfig,
  generate,
};

/** Registry entry point — the provider holds no per-call state. */
export function createGeminiProvider(): ResearchProvider {
  return geminiProvider;
}

import "server-only";

// Claude Sonnet 5 + the native web_search server tool (PRD §12 model tier).
//
// This adapter is a transport and nothing more: wire format, the pause_turn
// resume loop, citation extraction, usage mapping, error classification. Every
// PRD §6.1 rule — guardrails, exclusions, cost caps, no-padding — lives in the
// engine, so a second vendor can never drift from them.
//
// @anthropic-ai/sdk is not a dependency of this project (checked package.json),
// so this talks to /v1/messages over fetch. Swapping the SDK in later touches
// only this file.

import { z } from "zod";
import type { ResearchStage } from "../contracts";
import type {
  Citation,
  PriceBook,
  ProviderCall,
  ProviderCapabilities,
  ProviderResponse,
  ProviderUsage,
  ResearchProvider,
  StopReason,
} from "../types";
import { ProviderError } from "../types";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** PRD §12 names Sonnet 5 for research. No date suffix — this id is complete. */
const MODEL_ID = "claude-sonnet-5";

const SEARCH_TOOL_TYPE = "web_search_20260209";

/** Server tools can end a turn with `pause_turn`; cap resumes so a stuck loop halts. */
const MAX_CONTINUATIONS = 5;

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Depth is bought where it changes lead quality. Seed only expands queries;
// score is the judgement call that decides what reaches a human.
const EFFORT_BY_STAGE: Record<ResearchStage, Effort> = {
  seed: "low",
  discover: "medium",
  qualify: "medium",
  score: "high",
};

const CAPABILITIES: ProviderCapabilities = {
  search: "native",
  structuredOutputWithSearch: true,
  structuredOutput: "schema_enforced",
  sourceFidelity: "high",
  // Anthropic does not train on API inputs/outputs, so public contact details
  // may pass through this provider (PRD §6.1 still forbids inventing them).
  safeForContactData: true,
  promptCaching: true,
  suggestedQualifyBatchSize: 10,
  maxOutputTokens: 16_000,
};

// Post-promo Sonnet 5 list rates. Deliberately the HIGHER numbers: the intro
// $2/$10 ends 31 Aug 2026, and an over-estimate keeps the $3 cap honest across
// the changeover instead of silently doubling its real meaning.
const PRICE_BOOK: PriceBook = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  searchPerThousand: 10,
  note:
    "Claude Sonnet 5 list pricing ($3/$15 per MTok). Introductory $2/$10 rates " +
    "run through 31 Aug 2026, so estimates before that date over-state spend. " +
    "Adaptive thinking bills as output tokens.",
};

type JsonRecord = Record<string, unknown>;

interface ApiMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

export function createAnthropicProvider(): ResearchProvider {
  return {
    id: "anthropic",
    modelId: MODEL_ID,
    capabilities: CAPABILITIES,
    priceBook: PRICE_BOOK,
    isConfigured,
    missingConfig,
    generate,
  };
}

function isConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function missingConfig(): string[] {
  return isConfigured() ? [] : ["ANTHROPIC_API_KEY"];
}

async function generate(call: ProviderCall): Promise<ProviderResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ProviderError("auth", "ANTHROPIC_API_KEY is not set");
  }

  const warnings: string[] = [];
  const startedAt = Date.now();

  const tools = buildSearchTools(call, warnings);
  const schema = toAnthropicJsonSchema(call.outputSchema, call.outputSchemaName, warnings);

  const outputConfig: JsonRecord = { effort: EFFORT_BY_STAGE[call.stage] };
  if (schema) {
    outputConfig.format = { type: "json_schema", schema };
  }

  const messages: ApiMessage[] = call.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const usage = emptyUsage();
  const citations = new Map<string, Citation>();
  let stopReason: StopReason = "error";
  let lastContent: unknown[] = [];

  for (let attempt = 0; ; attempt += 1) {
    const body: JsonRecord = {
      model: MODEL_ID,
      max_tokens: Math.min(call.limits.maxOutputTokens, CAPABILITIES.maxOutputTokens),
      messages,
      // budget_tokens and temperature/top_p/top_k are removed on Sonnet 5 and
      // return 400 — depth is controlled by output_config.effort alone.
      thinking: { type: "adaptive" },
      output_config: outputConfig,
    };
    const system = buildSystem(call);
    if (system) body.system = system;
    if (tools) body.tools = tools;

    const payload = await postMessages(body, apiKey, call.signal);
    mergeUsage(usage, payload);
    collectCitations(payload, citations, warnings);

    lastContent = Array.isArray(payload.content) ? payload.content : [];
    const stop = asString(payload.stop_reason);

    // Read stop_reason before content: a safety classifier decline returns 200
    // with empty or partial content.
    if (stop === "refusal") {
      warnings.push(refusalWarning(payload));
      return {
        raw: null,
        citations: [...citations.values()],
        usage,
        stopReason: "refusal",
        modelId: MODEL_ID,
        warnings,
      };
    }

    if (stop === "pause_turn") {
      messages.push({ role: "assistant", content: lastContent });
      const outOfTime = Date.now() - startedAt >= call.limits.deadlineMs;
      if (attempt >= MAX_CONTINUATIONS || outOfTime) {
        warnings.push(
          outOfTime
            ? "Claude was still searching when the stage deadline arrived; results are partial."
            : `Claude paused ${MAX_CONTINUATIONS + 1} times without finishing; results are partial.`
        );
        stopReason = "paused";
        break;
      }
      continue;
    }

    stopReason = stop === "max_tokens" ? "max_tokens" : "complete";
    break;
  }

  return {
    raw: extractOutput(lastContent, warnings),
    citations: [...citations.values()],
    usage,
    stopReason,
    modelId: MODEL_ID,
    warnings,
  };
}

// ── request construction ────────────────────────────────────────────────────

function buildSystem(call: ProviderCall): unknown[] | null {
  const text = call.system.trim();
  if (!text) return null;

  const block: JsonRecord = { type: "text", text };
  // The system prompt carries the industry exclusion block and is re-sent on
  // every call in a run, so a cache breakpoint here is most of the savings.
  if (call.cacheHint && CAPABILITIES.promptCaching) {
    block.cache_control = { type: "ephemeral" };
  }
  return [block];
}

function buildSearchTools(call: ProviderCall, warnings: string[]): JsonRecord[] | null {
  const plan = call.search;
  if (plan.mode === "none") return null;
  if (plan.mode === "host_tool") {
    throw new ProviderError(
      "unsupported",
      "The Anthropic adapter runs Claude's native web_search tool and cannot drive a " +
        "host-executed search loop. Set SEARCH_PROVIDER=native."
    );
  }

  const directive = plan.directive;
  const maxUses = Math.min(directive.maxSearches, call.limits.maxSearches);
  if (maxUses < 1) return null;

  const tool: JsonRecord = {
    type: SEARCH_TOOL_TYPE,
    name: "web_search",
    max_uses: maxUses,
    user_location: { type: "approximate", country: directive.region },
  };

  const allowed = directive.allowedDomains ?? [];
  const blocked = directive.blockedDomains ?? [];
  if (allowed.length > 0) {
    tool.allowed_domains = allowed;
    if (blocked.length > 0) {
      warnings.push(
        "allowed_domains and blocked_domains are mutually exclusive; the block list was dropped."
      );
    }
  } else if (blocked.length > 0) {
    tool.blocked_domains = blocked;
  }

  if (directive.freshnessDays !== undefined) {
    warnings.push("Claude's web_search tool has no freshness filter; freshnessDays was ignored.");
  }

  return [tool];
}

// ── transport ───────────────────────────────────────────────────────────────

async function postMessages(
  body: JsonRecord,
  apiKey: string,
  signal: AbortSignal
): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw isAbortError(err)
      ? new ProviderError("timeout", "Stage deadline reached before Claude responded")
      : new ProviderError("transport", `Could not reach the Anthropic API: ${describe(err)}`, true);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw isAbortError(err)
      ? new ProviderError("timeout", "Stage deadline reached while reading Claude's response")
      : new ProviderError("transport", `Anthropic response was cut off: ${describe(err)}`, true);
  }

  if (!response.ok) throw classifyHttpError(response.status, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("transport", "Anthropic returned a body that is not JSON", true);
  }
  if (!isRecord(parsed)) {
    throw new ProviderError("transport", "Anthropic returned an unexpected body shape", true);
  }
  return parsed;
}

function classifyHttpError(status: number, body: string): ProviderError {
  const detail = apiErrorMessage(body) ?? `HTTP ${status}`;
  if (status === 401 || status === 403) return new ProviderError("auth", detail);
  if (status === 429) return new ProviderError("rate_limit", detail, true);
  if (status === 529) return new ProviderError("overloaded", detail, true);
  if (status >= 500) return new ProviderError("transport", detail, true);
  if (status === 404) {
    return new ProviderError("invalid_request", `Unknown model or endpoint: ${detail}`);
  }
  return new ProviderError("invalid_request", detail);
}

function apiErrorMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error)) return asString(parsed.error.message);
  } catch {
    // fall through — a non-JSON error body is still worth surfacing verbatim
  }
  const trimmed = body.trim();
  return trimmed ? trimmed.slice(0, 400) : null;
}

// ── response reading ────────────────────────────────────────────────────────

function refusalWarning(payload: JsonRecord): string {
  const details = isRecord(payload.stop_details) ? payload.stop_details : {};
  const category = asString(details.category) ?? "unspecified";
  const explanation = asString(details.explanation);
  return explanation
    ? `Claude declined this request (${category}): ${explanation}`
    : `Claude declined this request (${category}).`;
}

function mergeUsage(into: ProviderUsage, payload: JsonRecord): void {
  const usage = isRecord(payload.usage) ? payload.usage : {};
  into.inputTokens += asNumber(usage.input_tokens);
  into.outputTokens += asNumber(usage.output_tokens);
  into.cacheReadInputTokens += asNumber(usage.cache_read_input_tokens);
  into.cacheWriteInputTokens += asNumber(usage.cache_creation_input_tokens);

  const serverTools = isRecord(usage.server_tool_use) ? usage.server_tool_use : {};
  into.searches += asNumber(serverTools.web_search_requests);
}

function collectCitations(
  payload: JsonRecord,
  into: Map<string, Citation>,
  warnings: string[]
): void {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const retrievedAt = new Date().toISOString();

  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === "web_search_tool_result") {
      // On success .content is a LIST of web_search_result; on failure it is an
      // OBJECT carrying error_code. Branch before indexing.
      const result = block.content;
      if (Array.isArray(result)) {
        for (const hit of result) {
          if (!isRecord(hit) || hit.type !== "web_search_result") continue;
          addCitation(into, {
            url: asString(hit.url),
            title: asString(hit.title),
            quotedText: null,
            retrievedAt,
            via: "provider_native",
          });
        }
      } else if (isRecord(result)) {
        const code = asString(result.error_code) ?? "unknown_error";
        warnings.push(`A web search failed (${code}); fewer sources were retrieved.`);
      }
      continue;
    }

    // Inline citations bind a specific claim to a retrieved URL — the strongest
    // evidence the engine's source-authenticity guardrail can work with.
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const cite of block.citations) {
        if (!isRecord(cite)) continue;
        addCitation(into, {
          url: asString(cite.url),
          title: asString(cite.title),
          quotedText: asString(cite.cited_text),
          retrievedAt,
          via: "provider_native",
        });
      }
    }
  }
}

function addCitation(into: Map<string, Citation>, candidate: Omit<Citation, "url"> & { url: string | null }): void {
  const url = candidate.url;
  if (!url) return;

  const existing = into.get(url);
  if (!existing) {
    into.set(url, { ...candidate, url });
    return;
  }
  // Keep the richer record: a quoted claim beats a bare search hit.
  if (!existing.quotedText && candidate.quotedText) {
    into.set(url, { ...existing, quotedText: candidate.quotedText, title: existing.title ?? candidate.title });
  }
}

function extractOutput(content: unknown[], warnings: string[]): unknown {
  let text = "";
  for (const block of content) {
    if (isRecord(block) && block.type === "text") text += asString(block.text) ?? "";
  }

  const trimmed = text.trim();
  if (!trimmed) {
    warnings.push("Claude returned no text output for this stage.");
    return "";
  }

  const parsed = parseJsonLoose(trimmed);
  if (parsed === undefined) {
    warnings.push("Claude's output was not valid JSON; the engine will reject this stage.");
    return trimmed;
  }
  return parsed;
}

function parseJsonLoose(text: string): unknown {
  const candidates = [text, stripCodeFence(text), sliceOutermostObject(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

function stripCodeFence(text: string): string | null {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return match ? match[1] : null;
}

function sliceOutermostObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

// ── zod → Anthropic JSON Schema ─────────────────────────────────────────────

// Anthropic's schema-constrained decoding rejects numeric and string-length
// bounds and requires additionalProperties:false on every object. The engine
// re-validates with the real zod schema afterwards, so dropping those keywords
// here loses no enforcement — it just moves it one layer out.
const DROPPED_KEYWORDS = new Set([
  "$schema",
  "default",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "contentEncoding",
  "contentMediaType",
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
]);

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

const SCHEMA_MAP_KEYWORDS = new Set(["properties", "$defs", "definitions"]);

function toAnthropicJsonSchema(
  schema: z.ZodType<unknown>,
  name: string,
  warnings: string[]
): JsonRecord | null {
  let generated: unknown;
  try {
    generated = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "any",
    });
  } catch (err) {
    warnings.push(
      `Could not derive a JSON Schema for "${name}" (${describe(err)}); ` +
        "Claude was asked for JSON without schema enforcement."
    );
    return null;
  }

  const sanitized = sanitizeSchema(generated);
  if (!isRecord(sanitized)) return null;

  // A stable title keys Anthropic's 24h compiled-schema cache.
  sanitized.title = name;
  return sanitized;
}

function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!isRecord(node)) return node;

  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYWORDS.has(key)) continue;

    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = sanitizeSchemaMap(value);
      continue;
    }
    if (key === "format") {
      if (typeof value === "string" && SUPPORTED_FORMATS.has(value)) out[key] = value;
      continue;
    }
    out[key] = sanitizeSchema(value);
  }

  if (isRecord(out.properties)) {
    if (typeof out.type !== "string") out.type = "object";
    out.additionalProperties = false;
    // Every field required keeps nullable values explicit (`null`) rather than
    // absent, which is what the stage schemas expect.
    out.required = Object.keys(out.properties);
  }
  return out;
}

// Property names are arbitrary strings — never run them through the keyword
// filter, or a field called `pattern` would silently vanish.
function sanitizeSchemaMap(node: unknown): JsonRecord {
  if (!isRecord(node)) return {};
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) out[key] = sanitizeSchema(value);
  return out;
}

// ── small helpers ───────────────────────────────────────────────────────────

function emptyUsage(): ProviderUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    searches: 0,
    searchesCountedBy: "provider",
    providerReportedCostUsd: null,
    simulated: false,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

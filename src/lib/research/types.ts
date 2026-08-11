// Provider port for the research engine.
//
// The cut: a ResearchProvider is a *transport* — "structured completion,
// optionally with web search". It knows nothing about ICP policy, guardrails,
// cost caps, or what a lead is allowed to contain. All of that lives in the
// engine, so a new vendor can never silently drift from PRD §6.1.
//
// LEAK TEST: if adding a provider requires editing anything under stages/,
// prompts/, or guardrails.ts, this abstraction has failed.

import type { z } from "zod";
import type { ResearchStage } from "./contracts";
import type { SearchPlan } from "./search/types";

export type ResearchProviderId = "gemini" | "anthropic" | "demo";

export type SearchCapability = "native" | "host_tool" | "none";

/** How much we trust the URLs a provider hands back. Surfaced in the UI. */
export type SourceFidelity = "high" | "medium" | "low";

export interface ProviderCapabilities {
  readonly search: SearchCapability;
  /** Can it return schema-constrained JSON in the SAME turn as a search? */
  readonly structuredOutputWithSearch: boolean;
  readonly structuredOutput: "schema_enforced" | "json_mode" | "prompt_only";
  readonly sourceFidelity: SourceFidelity;
  /**
   * False when the provider's terms permit human review / training on
   * submitted data. The engine refuses to send contact details (names,
   * emails, phones of real people) through such a provider — enforced in
   * code, not in a prompt.
   */
  readonly safeForContactData: boolean;
  readonly promptCaching: boolean;
  /** How many candidates it can deep-dive inside one ≤60s Vercel call. */
  readonly suggestedQualifyBatchSize: number;
  readonly maxOutputTokens: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  searches: number;
  searchesCountedBy: "provider" | "host" | "estimated";
  /** null ⇒ the engine estimates from the provider's PriceBook. */
  providerReportedCostUsd: number | null;
  /** True only for the demo/fixture provider. */
  simulated: boolean;
}

export type StopReason =
  | "complete"
  | "max_tokens"
  | "paused"
  | "refusal"
  | "budget_halt"
  | "error";

export interface Citation {
  url: string;
  title: string | null;
  quotedText: string | null;
  retrievedAt: string;
  /**
   * Provenance. `model_claim` means the model asserted this URL but we never
   * saw it retrieved — guardrail 4 strips those.
   */
  via: "provider_native" | "search_api" | "model_claim";
}

export interface ResearchMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StageLimits {
  maxOutputTokens: number;
  maxSearches: number;
  remainingBudgetUsd: number;
  /** Wall-clock budget for this stage; keeps us inside Vercel's 60s. */
  deadlineMs: number;
}

export interface ProviderCall {
  stage: ResearchStage;
  system: string;
  messages: ResearchMessage[];
  /** Providers MAY derive a JSON Schema from this; the engine re-validates regardless. */
  outputSchema: z.ZodType<unknown>;
  outputSchemaName: string;
  search: SearchPlan;
  limits: StageLimits;
  cacheHint?: { prefixKey: string };
  signal: AbortSignal;
}

export interface ProviderResponse {
  /** Parsed JSON when the provider produced it, else the raw string. */
  raw: unknown;
  citations: Citation[];
  usage: ProviderUsage;
  stopReason: StopReason;
  modelId: string;
  warnings: string[];
}

/** Per-million-token prices; searches priced per thousand. */
export interface PriceBook {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
  readonly searchPerThousand: number;
  /** Human-readable note shown next to cost figures, e.g. promo pricing end date. */
  readonly note: string;
}

export type ProviderErrorCode =
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "invalid_request"
  | "refusal"
  | "timeout"
  | "transport"
  | "unsupported";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ResearchProvider {
  readonly id: ResearchProviderId;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  readonly priceBook: PriceBook;
  /** Never throws — mirrors isSheetsConfigured(). */
  isConfigured(): boolean;
  /** Missing env var names, for the "not configured yet" message. */
  missingConfig(): string[];
  generate(call: ProviderCall): Promise<ProviderResponse>;
}

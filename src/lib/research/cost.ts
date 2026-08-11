// Cost math and the per-run budget cap (PRD §6.1, P0-10).
//
// This is deliberately provider-independent: a vendor hands back token counts,
// the engine prices them. Cost figures are an ESTIMATE, not a bill — rates
// drift, adaptive thinking bills as output, and native search counts arrive
// only in provider metadata. `PriceBook.note` carries the caveat so the UI can
// label which pricing a figure assumes.
//
// Not server-only: the run view renders these notes next to the cost meter.

import type { PriceBook, ProviderUsage, ResearchProviderId } from "./types";

/** Verified against published rates on 11 Aug 2026. */
export const PRICE_BOOKS: Record<ResearchProviderId, PriceBook> = {
  // Claude Sonnet 5. Standard rates are $3/$15 per MTok; the $2/$10
  // introductory rate below is what we're actually billed today. Cache rates
  // are multiples of the $3 standard base ($0.30 read = 0.1x, $3.75 write =
  // 1.25x), which is why they don't scale down with the promo.
  anthropic: {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    searchPerThousand: 10.0,
    note: "Introductory pricing ($2/$10 per MTok) through 2026-08-31; reverts to $3/$15 after — a run modelled at $2 costs ~$3 from 1 Sep.",
  },
  gemini: {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
    searchPerThousand: 0,
    note: "Free tier — no charge. Quality is below the PRD-specified Claude path.",
  },
  demo: {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
    searchPerThousand: 0,
    note: "Sample data — no API calls.",
  },
};

/**
 * A provider that drops a usage field leaves us with undefined/NaN. Left
 * unguarded that poisons the ledger permanently: `NaN >= cap` is false, so the
 * budget would never halt.
 */
function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function estimateCostUsd(usage: ProviderUsage, book: PriceBook): number {
  const tokens =
    safe(usage.inputTokens) * book.inputPerMTok +
    safe(usage.outputTokens) * book.outputPerMTok +
    safe(usage.cacheReadInputTokens) * book.cacheReadPerMTok +
    safe(usage.cacheWriteInputTokens) * book.cacheWritePerMTok;

  return tokens / 1_000_000 + (safe(usage.searches) / 1000) * book.searchPerThousand;
}

/**
 * The per-run cost cap.
 *
 * The cap is checked BETWEEN calls, so a single runaway call can overshoot it —
 * this is not an exact ceiling and must not be described as one. What bounds
 * the blast radius of any one call is `StageLimits.maxOutputTokens` and
 * `maxSearches`; the ledger's job is to stop the *next* call and let the run
 * finish gracefully with partial results.
 */
export class BudgetLedger {
  private spentUsd: number;

  constructor(
    readonly capUsd: number,
    spentUsd = 0
  ) {
    this.spentUsd = safe(spentUsd);
  }

  get spent(): number {
    return this.spentUsd;
  }

  get remaining(): number {
    return Math.max(0, this.capUsd - this.spentUsd);
  }

  get halted(): boolean {
    return this.spentUsd >= this.capUsd;
  }

  /**
   * Pre-call check. The caller passes its own estimate — add a safety margin
   * there if the stage is one whose output size is hard to predict.
   */
  canAfford(estimatedUsd: number): boolean {
    return !this.halted && this.spentUsd + safe(estimatedUsd) <= this.capUsd;
  }

  /** Records one call's usage and returns the cost that was added. */
  record(usage: ProviderUsage, book: PriceBook): number {
    // A provider-reported cost beats our arithmetic, but a garbage one
    // (negative, NaN) falls back to the estimate rather than corrupting the cap.
    const reported = usage.providerReportedCostUsd;
    const cost =
      reported !== null && Number.isFinite(reported) && reported >= 0
        ? reported
        : estimateCostUsd(usage, book);

    this.spentUsd += cost;
    return cost;
  }
}

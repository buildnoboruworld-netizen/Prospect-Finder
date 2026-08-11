import "server-only";

// Usage accounting: provider usage → the existing `runs` columns + stage_state.
//
// No schema change needed. tokens_in / tokens_out / searches / cost_usd already
// exist; cache-token detail (which has no column) lives in stage_state, which
// doubles as the durable state machine so a run can resume after Vercel's 60s
// wall cuts a stage short.

import type {
  Candidate,
  DiscoverOutput,
  QualifiedProfile,
  ResearchStage,
  SeedPlan,
  ShortfallReport,
} from "./contracts";
import { BudgetLedger } from "./cost";
import type { PriceBook, ProviderUsage, ResearchProviderId } from "./types";

export function emptyUsage(): ProviderUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    searches: 0,
    // Both label fields are the identity element for mergeUsage: with zero
    // searches and zero reported cost, neither can degrade the other side.
    searchesCountedBy: "provider",
    providerReportedCostUsd: 0,
    simulated: false,
  };
}

export function mergeUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    searches: a.searches + b.searches,
    searchesCountedBy: mergeSearchProvenance(a, b),
    // Partial reporting would understate the total, so one unreported call
    // makes the whole merge fall back to the engine's estimate.
    providerReportedCostUsd:
      a.providerReportedCostUsd === null || b.providerReportedCostUsd === null
        ? null
        : a.providerReportedCostUsd + b.providerReportedCostUsd,
    // Any fixture content taints the total — this is what drives the SAMPLE badge.
    simulated: a.simulated || b.simulated,
  };
}

/** Least-trusted label wins, but a side with no searches has no say. */
function mergeSearchProvenance(
  a: ProviderUsage,
  b: ProviderUsage
): ProviderUsage["searchesCountedBy"] {
  if (a.searches === 0) return b.searchesCountedBy;
  if (b.searches === 0) return a.searchesCountedBy;
  if (a.searchesCountedBy === "estimated" || b.searchesCountedBy === "estimated") {
    return "estimated";
  }
  if (a.searchesCountedBy === "host" || b.searchesCountedBy === "host") {
    return "host";
  }
  return "provider";
}

/**
 * The shape persisted in `runs.stage_state`. Versioned so it can evolve without
 * breaking in-flight runs. `provider` + `promptVersion` are the attribution
 * record: "results got worse last Tuesday" has to be answerable.
 */
export interface RunStageState {
  version: 1;
  provider: { id: ResearchProviderId; modelId: string; sample: boolean };
  /** Hash of the prompt templates that produced this run. */
  promptVersion: string;
  seed?: { plan: SeedPlan };
  discover?: { candidates: Candidate[]; excluded: DiscoverOutput["excluded"] };
  qualify?: {
    cursor: number;
    batchSize: number;
    profiles: QualifiedProfile[];
    failures: Array<{ name: string; reason: string }>;
  };
  score?: { draftedCompanyIds: string[]; shortfall: ShortfallReport | null };
  budget: { capUsd: number; spentUsd: number; halted: boolean };
  usageDetail: {
    cacheRead: number;
    cacheWrite: number;
    perStage: Record<ResearchStage, ProviderUsage>;
  };
  errors: Array<{ stage: ResearchStage; at: string; code: string; message: string }>;
}

/**
 * Folds one call's usage into the run state. Pure — the caller persists the
 * returned state, so a failed write can't leave the ledger double-counted.
 */
export function applyUsageToRun(
  state: RunStageState,
  stage: ResearchStage,
  usage: ProviderUsage,
  book: PriceBook
): { state: RunStageState; costDelta: number } {
  // Routing the cost through BudgetLedger keeps the persisted budget and the
  // in-memory cap check on exactly one implementation of "what did this cost".
  const ledger = new BudgetLedger(state.budget.capUsd, state.budget.spentUsd);
  const costDelta = ledger.record(usage, book);

  const prior = state.usageDetail.perStage[stage] ?? emptyUsage();

  return {
    costDelta,
    state: {
      ...state,
      budget: {
        ...state.budget,
        spentUsd: ledger.spent,
        halted: ledger.halted,
      },
      usageDetail: {
        cacheRead: state.usageDetail.cacheRead + usage.cacheReadInputTokens,
        cacheWrite: state.usageDetail.cacheWrite + usage.cacheWriteInputTokens,
        perStage: {
          ...state.usageDetail.perStage,
          [stage]: mergeUsage(prior, usage),
        },
      },
    },
  };
}

/**
 * The four numeric columns on the `runs` row. cost_usd comes from the budget
 * ledger rather than being re-derived here: it already reflects any
 * provider-reported costs, which token arithmetic alone cannot reproduce.
 */
export function runColumnTotals(state: RunStageState): {
  tokens_in: number;
  tokens_out: number;
  searches: number;
  cost_usd: number;
} {
  let tokens_in = 0;
  let tokens_out = 0;
  let searches = 0;

  for (const usage of Object.values(state.usageDetail.perStage)) {
    // Cache reads/writes are real input tokens — billed differently, not free.
    tokens_in +=
      usage.inputTokens + usage.cacheReadInputTokens + usage.cacheWriteInputTokens;
    tokens_out += usage.outputTokens;
    searches += usage.searches;
  }

  return { tokens_in, tokens_out, searches, cost_usd: state.budget.spentUsd };
}

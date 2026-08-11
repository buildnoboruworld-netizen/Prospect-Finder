import "server-only";

// The resumable stage machine (PRD §6.1).
//
// One advanceRun() call is one unit of work, sized to finish inside Vercel's
// 60s wall; everything it learns lands in runs.stage_state, so the next tick
// resumes exactly where this one stopped — including mid-qualify, which is
// cursored precisely because deep-diving 40 brands does not fit in one call.
//
// Policy lives here and never in a provider: the budget halt, batching, the
// one repair retry, the guardrail pass, and the refusal to re-prompt with
// looser criteria when a run comes up short (PRD P0-4). A short run is a
// correct run.

import { createAdminClient } from "@/lib/supabase/admin";
import type { IcpConfig, Industry, RunStage } from "@/lib/types";
import type { z } from "zod";
import {
  applyUsageToRun,
  emptyUsage,
  mergeUsage,
  runColumnTotals,
  type RunStageState,
} from "./accounting";
import { buildRetrievedUrlSet, normalizeCitations, urlKey } from "./citations";
import {
  STAGE_DEADLINE_MS,
  getCostCapUsd,
  getMaxSearchesPerRun,
  getProviderId,
  getTargetLeads,
} from "./config";
import type {
  Candidate,
  ExclusionReason,
  QualifiedProfile,
  ResearchStage,
  ShortfallReport,
} from "./contracts";
import { BudgetLedger, estimateCostUsd } from "./cost";
import { buildExclusions } from "./exclusions";
import { applyGuardrails, buildShortfall } from "./guardrails";
import { draftLeads } from "./persist";
import type { PromptOptions } from "./prompts/system";
import { PROMPT_VERSION } from "./prompts/version";
import { getProviderById } from "./providers/registry";
import { describeSearchGap, resolveSearchPlan } from "./search/resolve";
import {
  discoverOutputSchema,
  qualifyOutputSchema,
  scoreOutputSchema,
  seedPlanSchema,
} from "./schemas";
import type { SearchMode, SearchPlan } from "./search/types";
import { buildDiscoverCall, toDiscoverOutput } from "./stages/discover";
import { buildQualifyCall, toQualifiedProfiles } from "./stages/qualify";
import { buildScoreCall, toScoredLeads } from "./stages/score";
import { buildSeedCall, toSeedPlan } from "./stages/seed";
import type {
  Citation,
  ProviderCall,
  ProviderErrorCode,
  ProviderResponse,
  ProviderUsage,
  ResearchProvider,
} from "./types";
import { ProviderError } from "./types";

export interface AdvanceResult {
  /** Where the run stands after this tick — 'done' and 'failed' are terminal. */
  stage: RunStage;
  candidatesFound: number;
  leadsDrafted: number;
  costUsd: number;
  budgetHalted: boolean;
  shortfall: ShortfallReport | null;
  /** One plain line for the run view. */
  message: string;
  /**
   * When the provider asked us to wait (free-tier rate limits), how long
   * before the next tick. The run view sleeps this out instead of hammering
   * the next window.
   */
  retryAfterMs: number | null;
}

/** Wall-clock left for persistence after the provider work is cut off. */
const PERSIST_RESERVE_MS = 6_000;

/** Below this, a repair round-trip cannot finish, so it is not started. */
const MIN_CALL_MS = 8_000;

/**
 * A stage that keeps failing must not be retried forever by an unattended
 * cron. Six is generous for genuine rate limits and still bounded.
 */
const MAX_STAGE_ERRORS = 6;

/** How much of a bad reply we echo back when asking for a corrected one. */
const MAX_ECHO_CHARS = 20_000;

// Sized to the stage's real output, not to the model's ceiling: an unbounded
// max_tokens is the one way a single call can overshoot the budget cap, which
// is only checked between calls.
const MAX_OUTPUT_TOKENS: Record<ResearchStage, number> = {
  seed: 2_000,
  discover: 12_000,
  qualify: 8_000,
  score: 12_000,
};

type AdminClient = ReturnType<typeof createAdminClient>;

interface RunRow {
  id: string;
  industry_id: string;
  user_id: string;
  stage: RunStage;
  stage_state: unknown;
  candidates_found: number;
  leads_drafted: number;
  cost_usd: number;
  error: string | null;
  shortfall: ShortfallReport | null;
}

interface TickOutcome {
  nextStage: RunStage;
  candidatesFound: number;
  leadsDrafted: number;
  shortfall: ShortfallReport | null;
  budgetHalted: boolean;
  error: string | null;
  message: string;
  retryAfterMs: number | null;
}

/** Accumulates what a tick spent, so it is recorded even when the tick fails. */
interface CallScratch {
  usage: ProviderUsage;
  citations: Citation[];
  warnings: string[];
}

class BudgetHaltError extends Error {
  constructor(readonly capUsd: number) {
    super(`Stopped at the $${capUsd.toFixed(2)} research budget for this run.`);
    this.name = "BudgetHaltError";
  }
}

class StageOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageOutputError";
  }
}

export async function advanceRun(runId: string): Promise<AdvanceResult> {
  const admin = createAdminClient();
  const run = await loadRun(admin, runId);
  const saved = rehydrate(run.stage_state);

  if (run.stage === "done" || run.stage === "failed") {
    return {
      stage: run.stage,
      candidatesFound: run.candidates_found,
      leadsDrafted: run.leads_drafted,
      costUsd: run.cost_usd,
      budgetHalted: saved?.budget.halted ?? false,
      shortfall: run.shortfall,
      message:
        run.stage === "done"
          ? "This run has already finished."
          : `This run failed and will not resume: ${run.error ?? "no reason was recorded."}`,
      retryAfterMs: null,
    };
  }

  // A run stays on the provider it started with, so a mid-run change of
  // RESEARCH_PROVIDER cannot mix two engines' work into one lead list.
  let provider: ResearchProvider;
  try {
    provider = getProviderById(saved?.provider.id ?? getProviderId());
    if (!provider.isConfigured()) {
      const missing = provider.missingConfig().join(", ");
      throw new ProviderError(
        "auth",
        `Research is not configured — set ${missing || "the provider credentials"} in .env.local.`
      );
    }
    // Fails fast for a provider that needs a search backend we do not have.
    searchPlanFor(provider, 1);
  } catch (err) {
    return await failRun(admin, run, saved, describeError(err));
  }

  let state = saved ?? initState(provider, getCostCapUsd(), run.cost_usd);
  const stage: ResearchStage = saved === null ? "seed" : run.stage;

  if (saved === null && run.stage !== "seed") {
    // Restarting is the only safe move with no plan and no candidates, and
    // seeding the ledger from runs.cost_usd keeps the cap honest across it.
    state = withError(
      state,
      stage,
      "state_lost",
      "This run's saved progress could not be read, so it restarts from the search plan. Money already spent still counts against the cap."
    );
  }

  const outcome: TickOutcome = {
    nextStage: stage,
    candidatesFound: run.candidates_found,
    leadsDrafted: run.leads_drafted,
    shortfall: run.shortfall,
    budgetHalted: false,
    error: null,
    message: "",
    retryAfterMs: null,
  };

  if (state.budget.halted) {
    return await haltRun(admin, run, provider, state, outcome);
  }
  if (stageErrorCount(state, stage) >= MAX_STAGE_ERRORS) {
    outcome.nextStage = "failed";
    outcome.error = `The ${stage} stage failed ${MAX_STAGE_ERRORS} times in a row and will not be retried automatically.`;
    outcome.message = outcome.error;
    return await persist(admin, run, provider, state, outcome);
  }

  const ledger = new BudgetLedger(state.budget.capUsd, state.budget.spentUsd);
  const totals = runColumnTotals(state);
  const searchesLeft = Math.max(0, getMaxSearchesPerRun() - totals.searches);
  const opts: PromptOptions = {
    allowContactData: provider.capabilities.safeForContactData,
  };
  const prefixKey = `${state.promptVersion}:${opts.allowContactData ? "contacts" : "no-contacts"}`;

  const scratch: CallScratch = { usage: emptyUsage(), citations: [], warnings: [] };
  const controller = new AbortController();
  const deadlineAt = Date.now() + STAGE_DEADLINE_MS - PERSIST_RESERVE_MS;
  const remainingMs = (): number => deadlineAt - Date.now();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, remainingMs()));

  try {
    switch (stage) {
      case "seed": {
        const industry = await loadIndustry(admin, run.industry_id);
        const icp: IcpConfig = industry.icp_config ?? {};
        const exclusions = await buildExclusions(run.industry_id);

        const call = buildSeedCall(
          { industry, icp },
          context(provider, "seed", 0, ledger, remainingMs(), controller.signal, prefixKey),
          opts
        );
        const raw = await callStage(provider, call, seedPlanSchema, ledger, scratch, remainingMs);
        const plan = toSeedPlan(raw, exclusions, getTargetLeads());

        state = { ...state, seed: { plan } };
        outcome.nextStage = "discover";
        outcome.message = `Planned ${plan.queries.length} searches for ${industry.name}, with ${exclusions.brands.length} brands excluded.`;
        break;
      }

      case "discover": {
        const plan = required(state.seed?.plan, "its search plan");
        const maxSearches = Math.min(
          searchesLeft,
          Math.ceil(getMaxSearchesPerRun() * 0.4)
        );

        const call = buildDiscoverCall(
          { plan },
          context(provider, "discover", maxSearches, ledger, remainingMs(), controller.signal, prefixKey),
          opts
        );
        const raw = await callStage(provider, call, discoverOutputSchema, ledger, scratch, remainingMs);
        const output = toDiscoverOutput(
          raw,
          plan,
          buildRetrievedUrlSet(normalizeCitations(scratch.citations))
        );

        state = {
          ...state,
          discover: output,
          qualify: {
            cursor: 0,
            batchSize: Math.max(1, provider.capabilities.suggestedQualifyBatchSize),
            profiles: [],
            failures: [],
          },
        };
        outcome.candidatesFound = output.candidates.length;
        outcome.nextStage = "qualify";
        outcome.message = `Found ${output.candidates.length} candidates worth qualifying; ${output.excluded.length} were set aside.`;
        break;
      }

      case "qualify": {
        const plan = required(state.seed?.plan, "its search plan");
        const candidates = required(state.discover?.candidates, "its candidate list");
        const progress = required(state.qualify, "its qualification cursor");
        const batch: Candidate[] = candidates.slice(
          progress.cursor,
          progress.cursor + progress.batchSize
        );

        if (batch.length === 0) {
          outcome.nextStage = "score";
          outcome.message = `Qualified ${progress.profiles.length} of ${candidates.length} candidates.`;
          break;
        }

        // Spread what is left across the batches still to come, so the first
        // batch cannot spend the whole run's search budget on itself.
        const batchesLeft = Math.max(
          1,
          Math.ceil((candidates.length - progress.cursor) / progress.batchSize)
        );
        const maxSearches =
          searchesLeft > 0
            ? Math.max(1, Math.min(Math.floor(searchesLeft / batchesLeft), batch.length * 3))
            : 0;

        const call = buildQualifyCall(
          { batch, plan },
          context(provider, "qualify", maxSearches, ledger, remainingMs(), controller.signal, prefixKey),
          opts
        );
        const raw = await callStage(provider, call, qualifyOutputSchema, ledger, scratch, remainingMs);
        const result = toQualifiedProfiles(
          raw,
          batch,
          buildRetrievedUrlSet(normalizeCitations(scratch.citations)),
          opts.allowContactData
        );

        const cursor = progress.cursor + batch.length;
        state = {
          ...state,
          qualify: {
            ...progress,
            cursor,
            profiles: [...progress.profiles, ...result.profiles],
            failures: [...progress.failures, ...result.failures],
          },
        };
        outcome.nextStage = cursor >= candidates.length ? "score" : "qualify";
        outcome.message = `Qualified ${cursor} of ${candidates.length} candidates.`;
        break;
      }

      case "score": {
        const plan = required(state.seed?.plan, "its search plan");
        const profiles = state.qualify?.profiles ?? [];

        // Nothing survived qualification: calling the model to score an empty
        // list would cost money to produce a report we can write ourselves.
        const scored =
          profiles.length === 0
            ? { leads: [], explanation: null, dropped: [] }
            : toScoredLeads(
                await callStage(
                  provider,
                  buildScoreCall(
                    { profiles, plan },
                    context(provider, "score", 0, ledger, remainingMs(), controller.signal, prefixKey),
                    opts
                  ),
                  scoreOutputSchema,
                  ledger,
                  scratch,
                  remainingMs
                )
              );

        const guarded = applyGuardrails({
          leads: scored.leads,
          retrievedUrls: provenUrls(profiles),
          plan,
          allowContactData: opts.allowContactData,
        });

        const drafted =
          guarded.leads.length === 0
            ? { draftedIds: [], skipped: [] }
            : await draftLeads({
                runId: run.id,
                industryId: run.industry_id,
                ownerId: run.user_id,
                leads: guarded.leads,
                isSample: provider.id === "demo",
              });

        const duplicates = drafted.skipped.filter((s) => s.reason === "duplicate");
        const excluded: Array<{ name: string; reason: ExclusionReason }> = [
          ...(state.discover?.excluded ?? []),
          ...duplicates.map((s) => ({ name: s.name, reason: "duplicate" as const })),
        ];
        const setAside =
          guarded.dropped.length +
          scored.dropped.length +
          (state.qualify?.failures.length ?? 0) +
          (drafted.skipped.length - duplicates.length);

        const shortfall = withModelNote(
          buildShortfall(plan.targetLeads, drafted.draftedIds.length, excluded, setAside),
          scored.explanation
        );

        state = {
          ...state,
          score: { draftedCompanyIds: drafted.draftedIds, shortfall },
        };
        outcome.leadsDrafted = drafted.draftedIds.length;
        outcome.shortfall = shortfall;
        outcome.nextStage = "done";
        outcome.message = `Drafted ${drafted.draftedIds.length} leads against a target of ${plan.targetLeads}.`;
        break;
      }
    }
  } catch (err) {
    if (err instanceof BudgetHaltError) {
      return await haltRun(admin, run, provider, settle(state, stage, scratch, provider), outcome);
    }

    state = withError(state, stage, errorCode(err), describeError(err));
    if (isRetryable(err)) {
      // Nothing is lost: the cursor did not move, so the next tick redoes
      // exactly this batch.
      outcome.retryAfterMs =
        err instanceof ProviderError ? err.retryAfterMs : null;
      outcome.message = `${describeError(err)} Nothing was lost — start the next tick to continue.`;
    } else {
      outcome.nextStage = "failed";
      outcome.error = describeError(err);
      outcome.message = outcome.error;
    }
  } finally {
    clearTimeout(timer);
  }

  state = settle(state, stage, scratch, provider);

  if (state.budget.halted && outcome.nextStage !== "failed" && outcome.nextStage !== "done") {
    return await haltRun(admin, run, provider, state, outcome);
  }
  return await persist(admin, run, provider, state, outcome);
}

// ── provider calls ──────────────────────────────────────────────────────────

/**
 * One stage's worth of provider work: budget check, call, validate, and — on a
 * contract violation — exactly one correction attempt with the validation
 * errors fed back. The retry re-formats; it never re-researches, which is why
 * it runs with search switched off.
 */
async function callStage<T>(
  provider: ResearchProvider,
  call: ProviderCall,
  schema: z.ZodType<T>,
  ledger: BudgetLedger,
  scratch: CallScratch,
  remainingMs: () => number
): Promise<T> {
  const first = await spend(provider, call, ledger, scratch);
  const parsed = schema.safeParse(asJson(first.raw));
  if (parsed.success) return parsed.data;

  if (remainingMs() < MIN_CALL_MS) {
    throw new ProviderError(
      "timeout",
      `${provider.id} returned output this stage could not read, and there was no time left to ask for a correction.`,
      true
    );
  }

  const second = await spend(
    provider,
    repairCall(call, first, parsed.error, remainingMs()),
    ledger,
    scratch
  );
  const repaired = schema.safeParse(asJson(second.raw));
  if (repaired.success) return repaired.data;

  throw new StageOutputError(
    `${provider.id} could not produce a valid ${call.outputSchemaName}, even after one correction: ${formatIssues(repaired.error)}`
  );
}

async function spend(
  provider: ResearchProvider,
  call: ProviderCall,
  ledger: BudgetLedger,
  scratch: CallScratch
): Promise<ProviderResponse> {
  // Worst case, deliberately: the cap is only checked between calls, so the
  // pre-check has to assume the call fills its whole token and search budget.
  if (!ledger.canAfford(estimateCallCostUsd(call, provider.priceBook))) {
    throw new BudgetHaltError(ledger.capUsd);
  }

  const response = await provider.generate(call);

  scratch.usage = mergeUsage(scratch.usage, response.usage);
  scratch.citations.push(...response.citations);
  scratch.warnings.push(...response.warnings);
  // Advisory only — the persisted total comes from applyUsageToRun, which is
  // the single writer of budget.spentUsd.
  ledger.record(response.usage, provider.priceBook);

  if (response.stopReason === "refusal") {
    throw new ProviderError(
      "refusal",
      response.warnings.join(" ") || `${provider.id} declined this request.`
    );
  }
  if (response.stopReason === "max_tokens") {
    scratch.warnings.push(
      `The ${call.stage} stage hit its output limit, so its results may be cut short.`
    );
  }
  return response;
}

function repairCall(
  call: ProviderCall,
  response: ProviderResponse,
  error: z.ZodError,
  remainingMs: number
): ProviderCall {
  return {
    ...call,
    messages: [
      ...call.messages,
      { role: "assistant", content: echo(response.raw) },
      {
        role: "user",
        content:
          `Your reply did not match the required output contract:\n\n${formatIssues(error)}\n\n` +
          "Send the same findings again as JSON that satisfies the contract. This is a " +
          "formatting correction only: do not research anything further, do not add brands " +
          "you had not already found, and do not drop any you had.",
      },
    ],
    // Paying twice for the same searches is the easiest way to reach the cap
    // without producing anything.
    search: { mode: "none" },
    limits: { ...call.limits, maxSearches: 0, deadlineMs: remainingMs },
  };
}

function estimateCallCostUsd(
  call: ProviderCall,
  book: ResearchProvider["priceBook"]
): number {
  const chars =
    call.system.length +
    call.messages.reduce((total, message) => total + message.content.length, 0);

  return estimateCostUsd(
    {
      ...emptyUsage(),
      inputTokens: Math.ceil(chars / 4),
      outputTokens: call.limits.maxOutputTokens,
      searches: call.limits.maxSearches,
    },
    book
  );
}

function context(
  provider: ResearchProvider,
  stage: ResearchStage,
  maxSearches: number,
  ledger: BudgetLedger,
  deadlineMs: number,
  signal: AbortSignal,
  prefixKey: string
) {
  return {
    search: searchPlanFor(provider, maxSearches),
    limits: {
      maxOutputTokens: Math.min(
        MAX_OUTPUT_TOKENS[stage],
        provider.capabilities.maxOutputTokens
      ),
      maxSearches,
      remainingBudgetUsd: ledger.remaining,
      deadlineMs,
    },
    cacheHint: provider.capabilities.promptCaching ? { prefixKey } : undefined,
    signal,
  };
}

/**
 * The engine picks the search shape, never the provider — that keeps every
 * provider × search combination validated in one place. resolveSearchPlan
 * prefers a configured host backend over native search, because a host-run
 * search is the only mode that yields an exact retrieved-URL set for the
 * source guardrail (and, on Gemini's free tier, the only mode that works at
 * all — it has no grounding quota).
 */
function searchPlanFor(provider: ResearchProvider, maxSearches: number): SearchPlan {
  if (maxSearches < 1) return { mode: "none" };

  const plan = resolveSearchPlan(provider, { maxSearches, region: "IN" });

  if (plan.mode === "none" && provider.capabilities.search !== "none") {
    // Refusing beats running blind: with no retrieval there are no sources,
    // the guardrails drop every lead, and the run looks like "found nothing"
    // rather than like a misconfiguration.
    throw new ProviderError(
      "unsupported",
      describeSearchGap(provider) ??
        `${provider.id} has no usable search. Set SEARCH_PROVIDER + its API key, or RESEARCH_PROVIDER=demo.`
    );
  }
  return plan;
}

export function searchModeFor(provider: ResearchProvider): SearchMode {
  if (provider.capabilities.search === "none") return "none";
  return resolveSearchPlan(provider, { maxSearches: 1, region: "IN" }).mode;
}

// ── state ───────────────────────────────────────────────────────────────────

function initState(
  provider: ResearchProvider,
  capUsd: number,
  spentUsd: number
): RunStageState {
  return {
    version: 1,
    provider: {
      id: provider.id,
      modelId: provider.modelId,
      sample: provider.id === "demo",
    },
    promptVersion: PROMPT_VERSION,
    budget: { capUsd, spentUsd, halted: false },
    usageDetail: {
      cacheRead: 0,
      cacheWrite: 0,
      perStage: {
        seed: emptyUsage(),
        discover: emptyUsage(),
        qualify: emptyUsage(),
        score: emptyUsage(),
      },
    },
    errors: [],
  };
}

/**
 * jsonb carries no guarantees at rest. Anything we cannot recognise is treated
 * as absent rather than repaired, and `version` is what makes that judgement
 * safe to change later.
 */
function rehydrate(raw: unknown): RunStageState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<RunStageState>;
  if (candidate.version !== 1) return null;
  if (!candidate.budget || !candidate.usageDetail?.perStage || !candidate.provider) {
    return null;
  }
  return candidate as RunStageState;
}

/**
 * Closes out a tick: the money is recorded whatever happened to the work, and
 * provider warnings are kept on the run rather than lost with the request that
 * produced them (the demo provider's "this is sample data" arrives this way).
 */
function settle(
  state: RunStageState,
  stage: ResearchStage,
  scratch: CallScratch,
  provider: ResearchProvider
): RunStageState {
  let next = state;
  for (const warning of scratch.warnings) {
    next = withError(next, stage, "warning", warning);
  }
  return applyUsageToRun(next, stage, scratch.usage, provider.priceBook).state;
}

function withError(
  state: RunStageState,
  stage: ResearchStage,
  code: string,
  message: string
): RunStageState {
  return {
    ...state,
    errors: [...state.errors, { stage, at: new Date().toISOString(), code, message }],
  };
}

/**
 * Rate limits are excluded on purpose. They say nothing about whether this
 * stage can succeed — on a free tier they are the expected steady state, and
 * counting them would kill a healthy run for being throttled. The caller
 * paces off retryAfterMs instead; a genuinely stuck run still dies on the
 * real error codes.
 */
function stageErrorCount(state: RunStageState, stage: ResearchStage): number {
  return state.errors.filter(
    (e) => e.stage === stage && e.code !== "warning" && e.code !== "rate_limit"
  ).length;
}

/**
 * The URLs the run has proven it opened, rebuilt from the evidence that
 * survived the earlier stages. Citations are per-call and stage_state has no
 * room for a run-wide retrieval log, so the surviving sources ARE that log:
 * every one of them was checked against live citations when it was recorded.
 */
function provenUrls(profiles: QualifiedProfile[]): Set<string> {
  const urls = new Set<string>();
  for (const profile of profiles) {
    for (const source of profile.sources) {
      const key = urlKey(source.url);
      if (key !== null) urls.add(key);
    }
    for (const contact of profile.publicContacts) {
      const key = urlKey(contact.sourceUrl);
      if (key !== null) urls.add(key);
    }
  }
  return urls;
}

function withModelNote(
  report: ShortfallReport,
  explanation: string | null
): ShortfallReport {
  if (explanation === null || report.delivered >= report.target) return report;
  return {
    ...report,
    explanation: `${report.explanation}\n\nFrom the research engine: ${explanation}`,
  };
}

// ── persistence ─────────────────────────────────────────────────────────────

async function loadRun(admin: AdminClient, runId: string): Promise<RunRow> {
  const { data, error } = await admin
    .from("runs")
    .select(
      "id, industry_id, user_id, stage, stage_state, candidates_found, leads_drafted, cost_usd, error, shortfall"
    )
    .eq("id", runId)
    .maybeSingle();

  if (error) throw new Error(`Run ${runId} could not be loaded: ${error.message}`);
  if (!data) throw new Error(`Run ${runId} does not exist.`);

  const row = data as RunRow;
  // numeric(10,4) can arrive as a string depending on the driver.
  return { ...row, cost_usd: Number(row.cost_usd) || 0 };
}

async function loadIndustry(admin: AdminClient, industryId: string): Promise<Industry> {
  const { data, error } = await admin
    .from("industries")
    .select("*")
    .eq("id", industryId)
    .maybeSingle();

  if (error) throw new Error(`This run's industry could not be loaded: ${error.message}`);
  if (!data) throw new Error("This run's industry no longer exists.");
  return data as Industry;
}

async function persist(
  admin: AdminClient,
  run: RunRow,
  provider: ResearchProvider,
  state: RunStageState,
  outcome: TickOutcome
): Promise<AdvanceResult> {
  const totals = runColumnTotals(state);

  const { error } = await admin
    .from("runs")
    .update({
      stage: outcome.nextStage,
      stage_state: state,
      candidates_found: outcome.candidatesFound,
      leads_drafted: outcome.leadsDrafted,
      tokens_in: totals.tokens_in,
      tokens_out: totals.tokens_out,
      searches: totals.searches,
      cost_usd: Number(totals.cost_usd.toFixed(4)),
      error: outcome.error,
      shortfall: outcome.shortfall,
      provider: provider.id,
      model_id: provider.modelId,
      is_sample: provider.id === "demo",
    })
    .eq("id", run.id);

  if (error) throw new Error(`This run's progress could not be saved: ${error.message}`);

  return {
    stage: outcome.nextStage,
    retryAfterMs: outcome.retryAfterMs,
    candidatesFound: outcome.candidatesFound,
    leadsDrafted: outcome.leadsDrafted,
    costUsd: totals.cost_usd,
    budgetHalted: outcome.budgetHalted,
    shortfall: outcome.shortfall,
    message: outcome.message,
  };
}

/**
 * PRD P0-10: hitting the cap ends the run gracefully. Whatever was found is
 * already saved, the run is marked done rather than failed, and the shortfall
 * says plainly that money, not the market, was the limit.
 */
async function haltRun(
  admin: AdminClient,
  run: RunRow,
  provider: ResearchProvider,
  state: RunStageState,
  outcome: TickOutcome
): Promise<AdvanceResult> {
  const halted: RunStageState = {
    ...state,
    budget: { ...state.budget, halted: true },
  };
  const shortfall = haltShortfall(halted, outcome.leadsDrafted);

  return await persist(admin, run, provider, halted, {
    ...outcome,
    nextStage: "done",
    budgetHalted: true,
    shortfall,
    error: null,
    message: `Stopped at the $${halted.budget.capUsd.toFixed(2)} cap with ${outcome.leadsDrafted} of ${shortfall.target} leads drafted.`,
  });
}

function haltShortfall(state: RunStageState, delivered: number): ShortfallReport {
  const report = buildShortfall(
    state.seed?.plan.targetLeads ?? getTargetLeads(),
    delivered,
    state.discover?.excluded ?? [],
    state.qualify?.failures.length ?? 0
  );
  return {
    ...report,
    explanation: `Stopped at the $${state.budget.capUsd.toFixed(2)} research budget for this run before the list was finished. ${report.explanation}`,
  };
}

async function failRun(
  admin: AdminClient,
  run: RunRow,
  state: RunStageState | null,
  message: string
): Promise<AdvanceResult> {
  const payload: Record<string, unknown> = { stage: "failed", error: message };
  if (state !== null) payload.stage_state = state;
  await admin.from("runs").update(payload).eq("id", run.id);

  return {
    stage: "failed",
    retryAfterMs: null,
    candidatesFound: run.candidates_found,
    leadsDrafted: run.leads_drafted,
    costUsd: run.cost_usd,
    budgetHalted: state?.budget.halted ?? false,
    shortfall: run.shortfall,
    message,
  };
}

// ── small helpers ───────────────────────────────────────────────────────────

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`This run's saved state is missing ${what}, so it cannot continue.`);
  }
  return value;
}

function asJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function echo(raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (!text) return "(empty reply)";
  return text.length > MAX_ECHO_CHARS ? `${text.slice(0, MAX_ECHO_CHARS)}…` : text;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 20)
    .map((issue) => `- ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Retryable means "the same request may work in a minute" — never a contract
 * violation, which repeats identically however often it is retried.
 *
 * The code decides, not only the adapter's flag: whether a rate limit or a
 * blown deadline should end a run is engine policy, and an adapter that
 * constructs one of these with the default `retryable: false` must not be able
 * to turn a slow call into a dead run.
 */
const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "rate_limit",
  "overloaded",
  "timeout",
]);

function isRetryable(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return err.retryable || RETRYABLE_CODES.has(err.code);
}

function errorCode(err: unknown): string {
  if (err instanceof ProviderError) return err.code;
  if (err instanceof StageOutputError) return "invalid_output";
  return "internal";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

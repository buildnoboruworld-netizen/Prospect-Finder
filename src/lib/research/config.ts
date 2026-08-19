import "server-only";

// The ONLY place research env vars are read. Always lazily, inside functions,
// so `npm run build` succeeds with nothing configured (same precedent as
// isSheetsConfigured()).

import type { ResearchProviderId } from "./types";

export const DEFAULT_COST_CAP_USD = 3; // PRD §6.1: per-run budget cap
export const DEFAULT_TARGET_LEADS = 18; // PRD G1: 15–20
export const STAGE_DEADLINE_MS = 50_000; // Vercel's 60s wall, with headroom

export function getProviderId(): ResearchProviderId {
  const raw = (process.env.RESEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "anthropic" || raw === "gemini" || raw === "demo") return raw;
  // Otherwise infer from whichever key exists, preferring the PRD path.
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  // NOT "demo". Falling back to fixtures means someone who clicks "Run
  // research" on a misconfigured deployment silently gets sample data for the
  // wrong industry — which happened on Vercel: a Hair Care run drafted five
  // fixture MILLET brands. Demo must be opt-in. Naming the PRD provider here
  // instead makes isResearchConfigured() false, so the button stays disabled
  // and its tooltip names the missing credential.
  return "anthropic";
}

export function getCostCapUsd(): number {
  const raw = Number(process.env.RESEARCH_MAX_COST_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COST_CAP_USD;
}

export function getTargetLeads(): number {
  const raw = Number(process.env.RESEARCH_TARGET_LEADS);
  return Number.isFinite(raw) && raw >= 5 && raw <= 40
    ? Math.floor(raw)
    : DEFAULT_TARGET_LEADS;
}

/**
 * Max web searches per RUN — cost control, alongside the $ cap.
 *
 * Keep this generous. Qualify is what turns a name into a lead (domain,
 * follower band, site depth), and it searches per candidate: starve the run
 * budget and qualify returns all-nulls, which the scorer then correctly
 * refuses to draft. A run capped at 6 produced 5 candidates and 0 leads for
 * exactly this reason.
 */
export function getMaxSearchesPerRun(): number {
  const raw = Number(process.env.RESEARCH_MAX_SEARCHES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 40;
}

/**
 * Max web searches in a SINGLE stage call — deadline control, a different
 * concern from the run budget above. Searches run inside the stage's ~44s
 * slice alongside two model calls, so too many in one call times the stage
 * out. Conflating this with the run budget is what starved qualify.
 */
export function getMaxSearchesPerCall(): number {
  const raw = Number(process.env.RESEARCH_MAX_SEARCHES_PER_CALL);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}

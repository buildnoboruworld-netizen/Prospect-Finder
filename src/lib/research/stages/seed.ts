// Stage 1 — the search plan.
//
// The provider is trusted with the queries and the notes and nothing else: the
// exclusion set, the lead target and the search budget are engine policy, so a
// vendor cannot widen the brief by returning a different shape.

import type { SeedPlan, StageIO } from "../contracts";
import type { ExclusionSet } from "../exclusions";
import { orderedUnique } from "../prompts/render";
import { buildSeedPrompt } from "../prompts/seed";
import type { PromptOptions } from "../prompts/system";
import { seedPlanSchema, type SeedPlanRaw } from "../schemas";
import type { ProviderCall } from "../types";

/**
 * The half of a ProviderCall that is identical for every stage — budget,
 * search plan, deadline. Derived from the port rather than hand-written so it
 * cannot drift from it.
 */
type StageContext = Omit<
  ProviderCall,
  "stage" | "system" | "messages" | "outputSchema" | "outputSchemaName"
>;

export function buildSeedCall(
  input: StageIO["seed"]["input"],
  ctx: StageContext,
  opts: PromptOptions
): ProviderCall {
  const prompt = buildSeedPrompt(input, opts);
  return {
    ...ctx,
    stage: "seed",
    system: prompt.system ?? "",
    messages: prompt.messages,
    outputSchema: seedPlanSchema,
    outputSchemaName: "SeedPlan",
  };
}

/**
 * The model's queries plus the facts it never got a vote on. Near-duplicate
 * queries are collapsed here rather than in the prompt renderer, because this
 * plan is what the next stage is actually billed to execute.
 */
export function toSeedPlan(
  raw: SeedPlanRaw,
  exclusions: ExclusionSet,
  targetLeads: number
): SeedPlan {
  return {
    queries: orderedUnique(raw.queries),
    exclusionBrands: exclusions.brands,
    exclusionDomains: exclusions.domains,
    exclusionHandles: exclusions.handles,
    targetLeads,
    notes: raw.notes,
  };
}

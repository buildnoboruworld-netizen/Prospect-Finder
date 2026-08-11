// Stage 4 — judgement. No new research, so this stage runs without search and
// its output may only carry evidence the earlier stages proved.

import type { ScoredLead, StageIO } from "../contracts";
import { buildScorePrompt } from "../prompts/score";
import type { PromptOptions } from "../prompts/system";
import { scoreOutputSchema, type ScoreOutputRaw } from "../schemas";
import type { ProviderCall } from "../types";

type StageContext = Omit<
  ProviderCall,
  "stage" | "system" | "messages" | "outputSchema" | "outputSchemaName"
>;

export interface ScoreResult {
  leads: ScoredLead[];
  /** The model's own account of a short run — appended to the engine's. */
  explanation: string | null;
  dropped: Array<{ name: string; reason: string }>;
}

export function buildScoreCall(
  input: StageIO["score"]["input"],
  ctx: StageContext,
  opts: PromptOptions
): ProviderCall {
  const prompt = buildScorePrompt(input, opts);
  return {
    ...ctx,
    stage: "score",
    system: prompt.system ?? "",
    messages: prompt.messages,
    outputSchema: scoreOutputSchema,
    outputSchemaName: "ScoreOutput",
  };
}

export function toScoredLeads(raw: ScoreOutputRaw): ScoreResult {
  const leads: ScoredLead[] = [];
  const dropped: ScoreResult["dropped"] = [];

  for (const lead of raw.leads) {
    const fitScore = asFitScore(lead.fit_score);
    if (fitScore === null) {
      dropped.push({
        name: lead.name,
        reason: `Its fit score of ${lead.fit_score} is outside the 1–5 scale.`,
      });
      continue;
    }
    leads.push({ ...lead, fit_score: fitScore });
  }

  return { leads, explanation: raw.shortfallExplanation, dropped };
}

/**
 * Narrows to the union `companies.fit_score` is scored on. The zod schema
 * already bounds the number, so this only ever returns null if that schema
 * changes — which is exactly when we want the item rejected rather than
 * clamped into a score nobody assigned it.
 */
function asFitScore(value: number): ScoredLead["fit_score"] | null {
  switch (value) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return value;
    default:
      return null;
  }
}

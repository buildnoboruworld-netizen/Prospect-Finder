"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAppUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { advanceRun, getResearchProviderInfo } from "@/lib/research";
import type { AdvanceResult, ResearchProviderInfo } from "@/lib/research";
import { getCostCapUsd } from "@/lib/research/config";
import { RESEARCH_STAGES } from "@/lib/research/contracts";
import type { ActionResult } from "@/app/actions/companies";
import type { AppUser, Run, RunStage } from "@/lib/types";

// The run surface answers in the same shape as every other action.
export type { ActionResult };

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
type RunRef = Pick<Run, "id" | "user_id" | "industry_id" | "stage">;

const runIdSchema = z.uuid("That run id is not valid.");
const startRunSchema = z.object({ industryId: z.uuid("Pick an industry.") });

/**
 * One message, whichever surface asks — the server action and /api/runs/* must
 * name the same fix, and the fix depends on *how* it is unconfigured.
 */
function notConfiguredError(info: ResearchProviderInfo | null): string {
  if (info === null) {
    return "Research engine not configured — RESEARCH_PROVIDER names a provider this build has no adapter for. Use `anthropic`, or `demo` for sample data.";
  }
  if (info.missingConfig.length > 0) {
    return `Research engine not configured — set ${info.missingConfig.join(", ")} in .env.local.`;
  }
  return `Research engine not configured — ${info.id} needs a host-executed search backend and this build has none. Set RESEARCH_PROVIDER=anthropic for native search, or =demo for sample data.`;
}

/**
 * RLS lets every active teammate *read* every run (cross-reachout awareness),
 * so ownership has to be checked here rather than left to the policy.
 */
async function loadOwnedRun(
  supabase: SupabaseServerClient,
  runId: string,
  user: AppUser
): Promise<{ ok: true; run: RunRef } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("runs")
    .select("id, user_id, industry_id, stage")
    .eq("id", runId)
    .maybeSingle();

  if (error) return { ok: false, error: `Run lookup failed: ${error.message}` };
  if (!data) return { ok: false, error: "Run not found." };

  const run = data as RunRef;
  if (run.user_id !== user.id && user.role !== "admin") {
    return { ok: false, error: "You can only manage runs you started." };
  }
  return { ok: true, run };
}

/**
 * Creates the run row and nothing else: advanceRun() is self-initialising, so
 * the first tick is what records the provider's full state machine.
 */
export async function startRun(input: {
  industryId: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();

  // info.configured IS isResearchConfigured(), resolved once so the message
  // below can name the missing vars.
  const info = getResearchProviderInfo();
  if (info === null || !info.configured) {
    return { ok: false, error: notConfiguredError(info) };
  }

  const parsed = startRunSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { industryId } = parsed.data;
  const supabase = await createClient();

  // members research only within their allotted industries (as createCompany)
  if (user.role !== "admin") {
    const { data: assignment } = await supabase
      .from("assignments")
      .select("id")
      .eq("user_id", user.id)
      .eq("industry_id", industryId)
      .eq("active", true)
      .maybeSingle();
    if (!assignment) {
      return { ok: false, error: "You are not assigned to this industry." };
    }
  }

  const capUsd = getCostCapUsd();

  const { data: created, error } = await supabase
    .from("runs")
    .insert({
      industry_id: industryId,
      user_id: user.id,
      stage: "seed",
      // The engine owns stage_state and replaces this wholesale on the first
      // tick. It is written here only so the run view can show the cap before
      // any work exists — deliberately without `version`, so the engine reads
      // it as absent rather than as a half-built state machine.
      stage_state: { budget: { capUsd, spentUsd: 0, halted: false } },
      provider: info.id,
      model_id: info.modelId,
      is_sample: info.sample,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23503") {
      return { ok: false, error: "That industry no longer exists." };
    }
    return { ok: false, error: `Could not start the run: ${error.message}` };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "run.start",
    entity: "run",
    entityId: created.id,
    after: {
      industry_id: industryId,
      provider: info.id,
      model_id: info.modelId,
      is_sample: info.sample,
      cost_cap_usd: capUsd,
    },
  });

  revalidatePath("/");
  return {
    ok: true,
    data: { id: created.id },
    message: info.sample
      ? "Started in SAMPLE mode — the results are replayed fixtures, not research."
      : `Run started with a $${capUsd.toFixed(2)} budget.`,
  };
}

/**
 * One tick. This is what the run view polls.
 *
 * advanceRun() takes no lock, so two ticks in flight on one run would spend the
 * budget twice on the same stage — the caller must wait for each result before
 * asking for the next.
 */
export async function advanceRunAction(
  runId: string
): Promise<ActionResult<AdvanceResult>> {
  const user = await requireAppUser();

  const parsedId = runIdSchema.safeParse(runId);
  if (!parsedId.success) {
    return { ok: false, error: parsedId.error.issues[0]?.message ?? "Invalid run id" };
  }

  // Checked before the engine sees the run: advanceRun() treats missing
  // credentials as a permanent failure, and a key that is merely absent from
  // this deployment should not kill a resumable run.
  const info = getResearchProviderInfo();
  if (info === null || !info.configured) {
    return { ok: false, error: notConfiguredError(info) };
  }

  const supabase = await createClient();
  const found = await loadOwnedRun(supabase, parsedId.data, user);
  if (!found.ok) return { ok: false, error: found.error };
  const before = found.run;

  let result: AdvanceResult;
  try {
    result = await advanceRun(before.id);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "This run could not be advanced.",
    };
  }

  const terminal = result.stage === "done" || result.stage === "failed";
  if (terminal && result.stage !== before.stage) {
    await logAudit(supabase, {
      userId: user.id,
      action: result.stage === "done" ? "run.complete" : "run.fail",
      entity: "run",
      entityId: before.id,
      before: { stage: before.stage },
      after: {
        stage: result.stage,
        leads_drafted: result.leadsDrafted,
        cost_usd: result.costUsd,
        budget_halted: result.budgetHalted,
      },
    });
    // Drafted leads are companies, so the queues that list them are now stale.
    revalidatePath("/pipeline");
    revalidatePath("/");
  }

  revalidatePath(`/runs/${before.id}`);
  return { ok: true, data: result, message: result.message };
}

/**
 * Stops a run for good — 'failed' is the only non-resuming stage the engine
 * has, and advanceRun() refuses to pick a failed run back up.
 *
 * A tick already in flight cannot see this and will still write its own stage,
 * so cancelling during one may need repeating once it settles. Whatever the run
 * already drafted stays in the pipeline as drafts.
 */
export async function cancelRun(
  runId: string
): Promise<ActionResult<{ id: string; stage: RunStage }>> {
  const user = await requireAppUser();

  const parsedId = runIdSchema.safeParse(runId);
  if (!parsedId.success) {
    return { ok: false, error: parsedId.error.issues[0]?.message ?? "Invalid run id" };
  }

  const supabase = await createClient();
  const found = await loadOwnedRun(supabase, parsedId.data, user);
  if (!found.ok) return { ok: false, error: found.error };
  const run = found.run;

  if (run.stage === "done" || run.stage === "failed") {
    return { ok: false, error: "This run has already finished." };
  }

  const { data: updated, error } = await supabase
    .from("runs")
    .update({ stage: "failed", error: "Cancelled by user" })
    .eq("id", run.id)
    .in("stage", [...RESEARCH_STAGES])
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `Cancel failed: ${error.message}` };
  if (!updated) {
    return { ok: false, error: "That run finished before it could be cancelled." };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "run.cancel",
    entity: "run",
    entityId: run.id,
    before: { stage: run.stage },
    after: { stage: "failed", error: "Cancelled by user" },
  });

  revalidatePath(`/runs/${run.id}`);
  revalidatePath("/");
  return {
    ok: true,
    data: { id: run.id, stage: "failed" },
    message: "Run cancelled. Anything it already drafted is still in the pipeline.",
  };
}

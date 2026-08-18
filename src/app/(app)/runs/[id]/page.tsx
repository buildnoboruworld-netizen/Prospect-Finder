import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getResearchProviderInfo } from "@/lib/research";
import { getCostCapUsd } from "@/lib/research/config";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SampleDataNotice } from "@/components/sample-data-badge";
import type { ShortfallReport } from "@/lib/research/contracts";
import type { Run } from "@/lib/types";
import { RunProgress, type RunProgressState } from "./run-progress";

export const metadata = { title: "Run" };

// The provenance columns land in migration 20260811120001; src/lib/types.ts
// still describes the pre-Phase-2 runs row.
type RunDetail = Run & {
  provider: string | null;
  model_id: string | null;
  is_sample: boolean;
  shortfall: ShortfallReport | null;
  industry: { id: string; name: string } | null;
};

const FIDELITY_NOTE: Record<string, string> = {
  high: "Sources are URLs the provider actually retrieved — the strongest guarantee available.",
  medium:
    "Sources come from the provider's grounding metadata; some are redirects that can expire. Spot-check before approving.",
  low: "Sources are asserted by the model, not verified as retrieved. Check every link before approving.",
};

/** stage_state is typed as an opaque bag on the Run row; read it defensively. */
function readBudgetHalted(state: Record<string, unknown>): boolean {
  const budget = (state as { budget?: { halted?: unknown } }).budget;
  return budget?.halted === true;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireAppUser();
  const supabase = await createClient();

  const { data } = await supabase
    .from("runs")
    .select("*, industry:industries(id, name)")
    .eq("id", id)
    .maybeSingle();

  if (!data) notFound();
  const run = data as unknown as RunDetail;

  const info = getResearchProviderInfo();
  const costCapUsd = getCostCapUsd();

  // A finished run reports the provider that produced it; a run that hasn't
  // ticked yet has nothing recorded, so the configured provider is the honest
  // answer for what it is about to use. `?? null` also covers the column being
  // absent — an un-applied migration must not make a demo run look real.
  const recordedProvider = run.provider ?? null;
  const providerId = recordedProvider ?? info?.id ?? null;
  const modelId = run.model_id ?? info?.modelId ?? null;
  const describesThisRun =
    recordedProvider === null || recordedProvider === info?.id;
  const isSample =
    run.is_sample === true ||
    (recordedProvider === null && info?.sample === true);

  const owned = run.user_id === user.id;
  const terminal = run.stage === "done" || run.stage === "failed";
  const canDrive =
    (owned || user.role === "admin") &&
    !terminal &&
    info !== null &&
    info.configured;

  const initial: RunProgressState = {
    stage: run.stage,
    candidatesFound: run.candidates_found,
    leadsDrafted: run.leads_drafted,
    costUsd: run.cost_usd,
    budgetHalted: readBudgetHalted(run.stage_state),
    shortfall: run.shortfall,
    message: "",
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">
              Research run — {run.industry?.name ?? "unknown industry"}
            </h1>
            {isSample && <Badge variant="outline">sample run</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            Started {new Date(run.created_at).toLocaleString()}
            {!owned && " · started by a teammate"} ·{" "}
            <Link
              href={`/pipeline?industry=${run.industry_id}`}
              className="underline"
            >
              industry pipeline
            </Link>
          </p>
        </div>
      </div>

      {isSample && <SampleDataNotice />}

      {info === null && !terminal && (
        <Alert variant="destructive">
          <AlertTitle>No research provider is wired up</AlertTitle>
          <AlertDescription>
            <code className="font-mono text-xs">RESEARCH_PROVIDER</code> names a
            provider this build has no adapter for, so this run cannot advance.
            Set it to <code className="font-mono text-xs">anthropic</code>,{" "}
            <code className="font-mono text-xs">gemini</code>, or{" "}
            <code className="font-mono text-xs">demo</code> for sample data —
            each with its own API key in the environment.
          </AlertDescription>
        </Alert>
      )}

      {info !== null && !info.configured && !terminal && (
        <Alert variant="destructive">
          <AlertTitle>Research engine not configured yet</AlertTitle>
          <AlertDescription>
            {info.missingConfig.length > 0
              ? `Add ${info.missingConfig.join(", ")} to .env.local, then reload this page.`
              : `The ${info.id} provider cannot run in this build — it needs a host search backend, which does not exist yet.`}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-4">
            <Field label="Provider">
              {providerId ?? "—"}
              {isSample && (
                <Badge variant="outline" className="ml-2">
                  fixtures
                </Badge>
              )}
            </Field>
            <Field label="Model">
              <span className="font-mono text-xs">{modelId ?? "—"}</span>
            </Field>
            <Field label="Web search">
              {describesThisRun && info
                ? info.searchMode === "provider_native"
                  ? "provider's own search"
                  : info.searchMode === "host_tool"
                    ? "host-run search"
                    : "none"
                : "—"}
            </Field>
            <Field label="Tokens / searches">
              {run.tokens_in.toLocaleString()} in ·{" "}
              {run.tokens_out.toLocaleString()} out · {run.searches} searches
            </Field>
          </dl>

          {describesThisRun && info && (
            <p className="mt-4 text-xs text-muted-foreground">
              {FIDELITY_NOTE[info.sourceFidelity] ?? ""} {info.priceNote}
              {!info.safeForContactData &&
                " Contact details are never sent to this provider — leads from it arrive without contacts."}
            </p>
          )}
        </CardContent>
      </Card>

      <RunProgress
        runId={run.id}
        canDrive={canDrive}
        costCapUsd={costCapUsd}
        initial={initial}
        initialError={run.error}
      />

      {!owned && user.role !== "admin" && (
        <p className="text-sm text-muted-foreground">
          Read-only — only the teammate who started this run (or an admin) can
          drive or cancel it.
        </p>
      )}
    </div>
  );
}

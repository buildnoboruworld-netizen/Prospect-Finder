"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { advanceRunAction, cancelRun } from "@/app/actions/runs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RESEARCH_STAGES } from "@/lib/research/contracts";
import type { ShortfallReport } from "@/lib/research/contracts";
import type { RunStage } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Mirrors AdvanceResult from @/lib/research — that module is server-only. */
export interface RunProgressState {
  stage: RunStage;
  candidatesFound: number;
  leadsDrafted: number;
  costUsd: number;
  budgetHalted: boolean;
  shortfall: ShortfallReport | null;
  message: string;
  /** Set when the provider throttled us and named a wait. */
  retryAfterMs?: number | null;
}

const STEPS: RunStage[] = [...RESEARCH_STAGES, "done"];

const STEP_LABELS: Record<RunStage, string> = {
  seed: "Seed",
  discover: "Discover",
  qualify: "Qualify",
  score: "Score",
  done: "Done",
  failed: "Failed",
};

const STAGE_HINTS: Record<RunStage, string> = {
  seed: "Planning search queries and assembling the exclusion list.",
  discover: "Finding candidate brands, each with a retrieved source.",
  qualify: "Deep-diving candidates in batches — the slowest stage.",
  score: "Scoring fit, applying guardrails, drafting the leads that survive.",
  done: "Finished.",
  failed: "Stopped before finishing.",
};

const EXCLUSION_LABELS: Record<string, string> = {
  too_big: "too big for the retainer",
  duplicate: "already in the pipeline",
  rejected: "rejected earlier",
  off_icp: "outside the ICP",
  no_source: "no verifiable source",
  guardrail_dropped: "dropped by guardrails",
};

// One tick at a time, with a beat between them: the engine takes no lock, so
// two overlapping advances on one run would double-spend the budget.
const TICK_DELAY_MS = 700;

/**
 * Free tiers are request-rate limited (Gemini: ~20/min), so a throttled tick
 * asks us to wait. Ticking again immediately just burns the next window and
 * looks like a broken run — this is the difference between a run that pauses
 * for a minute and a run that dies.
 */
const MAX_BACKOFF_MS = 120_000;

function isTerminal(stage: RunStage): boolean {
  return stage === "done" || stage === "failed";
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function RunProgress({
  runId,
  canDrive,
  costCapUsd,
  initial,
  initialError,
}: {
  runId: string;
  /** False when the run belongs to someone else, or research isn't configured. */
  canDrive: boolean;
  costCapUsd: number;
  initial: RunProgressState;
  initialError: string | null;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState<RunProgressState>(initial);
  const [tick, setTick] = useState(0);
  const [auto, setAuto] = useState(canDrive && !isTerminal(initial.stage));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [cancelled, setCancelled] = useState(false);
  const [cancelPending, startCancel] = useTransition();

  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The drive loop. Each completed advance bumps `tick`, which re-arms this
  // effect for the next one — so there is never more than one call in flight,
  // and pausing simply stops re-arming.
  useEffect(() => {
    if (!auto || isTerminal(progress.stage)) return;

    const wait = Math.min(progress.retryAfterMs ?? TICK_DELAY_MS, MAX_BACKOFF_MS);

    const timer = setTimeout(async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      setWorking(true);
      try {
        const result = await advanceRunAction(runId);
        if (!mounted.current) return;
        if (result.ok) {
          setProgress(result.data);
          setError(null);
          if (isTerminal(result.data.stage)) {
            setAuto(false);
            router.refresh(); // drafted leads are now readable elsewhere
          }
          setTick((n) => n + 1);
        } else {
          setError(result.error);
          setAuto(false);
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setWorking(false);
      }
    }, wait);

    return () => clearTimeout(timer);
  }, [auto, progress.stage, progress.retryAfterMs, tick, runId, router]);

  function cancel() {
    setAuto(false);
    startCancel(async () => {
      const result = await cancelRun(runId);
      if (result.ok) {
        // cancelRun writes stage 'failed' — the engine has no 'cancelled'
        // stage — so mirror that, but label it as the deliberate act it was.
        setCancelled(true);
        setProgress((prev) => ({
          ...prev,
          stage: "failed",
          message:
            result.message ??
            "Run cancelled. Anything it already drafted is still in the pipeline.",
        }));
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const terminal = isTerminal(progress.stage);
  const currentStep = STEPS.indexOf(progress.stage);
  const spendPct =
    costCapUsd > 0 ? Math.min(100, (progress.costUsd / costCapUsd) * 100) : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
            {STEPS.map((step, i) => {
              const done = progress.stage === "failed" ? false : i < currentStep;
              const active = step === progress.stage;
              return (
                <div key={step} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
                      done && "bg-primary/15 text-foreground",
                      active && "bg-primary text-primary-foreground",
                      !done && !active && "bg-muted text-muted-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        done && "bg-primary",
                        active &&
                          (working
                            ? "animate-pulse bg-primary-foreground"
                            : "bg-primary-foreground"),
                        !done && !active && "bg-muted-foreground/40"
                      )}
                    />
                    {STEP_LABELS[step]}
                  </span>
                  {i < STEPS.length - 1 && (
                    <span
                      className={cn(
                        "h-px w-4",
                        done ? "bg-primary" : "bg-border"
                      )}
                    />
                  )}
                </div>
              );
            })}
            {progress.stage === "failed" && (
              <Badge variant={cancelled ? "outline" : "destructive"}>
                {cancelled ? "cancelled" : "failed"}
              </Badge>
            )}
          </div>

          <p className="text-sm text-muted-foreground">
            {working ? "Working… " : ""}
            {STAGE_HINTS[progress.stage]}
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Candidates found
              </p>
              <p className="font-heading text-2xl">{progress.candidatesFound}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Leads drafted
              </p>
              <p className="font-heading text-2xl">{progress.leadsDrafted}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Spend against cap
              </p>
              <p className="font-heading text-2xl">
                {money(progress.costUsd)}
                <span className="text-sm text-muted-foreground">
                  {" "}
                  / {money(costCapUsd)}
                </span>
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Research spend against the per-run cap"
              aria-valuenow={Math.round(spendPct)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  progress.budgetHalted ? "bg-amber-500" : "bg-primary"
                )}
                style={{ width: `${spendPct}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Estimated from token counts, not a bill — the cap is checked
              between calls, so a single call can overshoot it slightly.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canDrive && !terminal && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAuto((on) => !on)}
                  disabled={cancelPending}
                >
                  {auto ? "Pause" : working ? "Working…" : "Resume"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={cancel}
                  disabled={cancelPending}
                >
                  {cancelPending ? "Cancelling…" : "Cancel run"}
                </Button>
              </>
            )}
            {progress.leadsDrafted > 0 && (
              <Button asChild variant="secondary" size="sm">
                <Link href={`/review?run=${runId}`}>
                  Review {progress.leadsDrafted} drafted lead
                  {progress.leadsDrafted === 1 ? "" : "s"} →
                </Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {progress.budgetHalted && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
          <AlertTitle>
            Halted at the cost cap — {money(progress.costUsd)} of{" "}
            {money(costCapUsd)} spent
          </AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            The run stopped cleanly rather than spending more. The{" "}
            {progress.leadsDrafted} lead
            {progress.leadsDrafted === 1 ? "" : "s"} drafted before the cap{" "}
            {progress.leadsDrafted === 1 ? "is" : "are"} saved and reviewable.
            Raise <code className="font-mono text-xs">RESEARCH_MAX_COST_USD</code>{" "}
            and start another run to go further.
          </AlertDescription>
        </Alert>
      )}

      {progress.shortfall && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
          <AlertTitle>
            Delivered {progress.shortfall.delivered} of{" "}
            {progress.shortfall.target} leads — here is exactly why
          </AlertTitle>
          <AlertDescription className="space-y-2 text-amber-900 dark:text-amber-200">
            <p>{progress.shortfall.explanation}</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(progress.shortfall.excludedCounts).map(
                ([reason, count]) =>
                  count ? (
                    <Badge
                      key={reason}
                      variant="outline"
                      className="border-amber-400 text-amber-900 dark:border-amber-800 dark:text-amber-200"
                    >
                      {EXCLUSION_LABELS[reason] ?? reason} · {count}
                    </Badge>
                  ) : null
              )}
            </div>
            <p className="text-xs">
              The engine never loosens its criteria to hit a number. A short run
              reported honestly is the correct outcome — pad the list and the
              team wastes outreach on brands that were never a fit.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {progress.message && !progress.budgetHalted && (
        <p className="text-sm text-muted-foreground">{progress.message}</p>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>
            {progress.stage === "failed" ? "Run failed" : "Paused on an error"}
          </AlertTitle>
          <AlertDescription>
            {error}
            {!terminal && canDrive && (
              <span className="mt-2 block">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setAuto(true);
                  }}
                >
                  Retry this stage
                </Button>
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

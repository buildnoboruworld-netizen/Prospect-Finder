import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAppUser } from "@/lib/auth";
import { advanceRun, getResearchProviderInfo } from "@/lib/research";
import { RESEARCH_STAGES } from "@/lib/research/contracts";
import type { RunStage } from "@/lib/types";

// Server-side run driver.
//
// Without this, a run is driven by JavaScript in whoever's browser tab started
// it: close the tab, background it, or let the laptop sleep and the run stops
// mid-way. (Browsers throttle timers in background tabs, so a "running" tab
// can silently stall for minutes.) This endpoint moves the motor onto the
// server — Vercel's cron pokes it, it advances every in-flight run one stage,
// and runs finish whether or not anyone is watching.
//
// Deliberately advances ONE stage per run per invocation rather than looping a
// run to completion: each stage is already sized to fill the function's time
// budget, and one slow run must not starve the others.
//
// SCHEDULING: vercel.json runs this DAILY, which is all Vercel Hobby permits
// — a more frequent schedule makes Vercel REJECT THE WHOLE DEPLOYMENT, which
// is exactly what silently stopped three commits from shipping. So this is a
// once-a-day rescue for runs abandoned by a closed tab, NOT a driver. Real
// hands-off runs need Vercel Pro, or any external scheduler hitting this URL
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<your-app>/api/runs/drive
//
// Until one of those is in place the browser tab remains the primary driver,
// and this endpoint is the recovery path.

export const maxDuration = 60;

/** Leave room to answer before the platform kills the function. */
const WALL_CLOCK_MS = 50_000;

/** A run untouched for this long is presumed abandoned by its browser tab. */
const STALE_AFTER_MS = 90_000;

const ACTIVE_STAGES: RunStage[] = [...RESEARCH_STAGES];

interface DriveOutcome {
  runId: string;
  stage: RunStage;
  leadsDrafted?: number;
  error?: string;
}

async function drive(options: { onlyStale: boolean }): Promise<{
  ok: boolean;
  considered: number;
  advanced: DriveOutcome[];
  skipped: string;
}> {
  const info = getResearchProviderInfo();
  if (info === null || !info.configured) {
    return {
      ok: false,
      considered: 0,
      advanced: [],
      skipped: "Research engine is not configured on this deployment.",
    };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("runs")
    .select("id, updated_at")
    .in("stage", ACTIVE_STAGES)
    .order("updated_at", { ascending: true })
    .limit(25);

  if (error) {
    return { ok: false, considered: 0, advanced: [], skipped: error.message };
  }

  const rows = (data ?? []) as Array<{ id: string; updated_at: string }>;

  // A run whose tab is actively driving it is left alone: two drivers on one
  // run would double-spend the budget and race on stage_state (advanceRun
  // takes no lock). Only runs that have gone quiet get picked up.
  const cutoff = Date.now() - STALE_AFTER_MS;
  const candidates = options.onlyStale
    ? rows.filter((r) => new Date(r.updated_at).getTime() < cutoff)
    : rows;

  const started = Date.now();
  const advanced: DriveOutcome[] = [];

  for (const row of candidates) {
    if (Date.now() - started > WALL_CLOCK_MS) break;
    try {
      const result = await advanceRun(row.id);
      advanced.push({
        runId: row.id,
        stage: result.stage,
        leadsDrafted: result.leadsDrafted,
      });
    } catch (e) {
      // One bad run must not stop the sweep.
      advanced.push({
        runId: row.id,
        stage: "failed",
        error: e instanceof Error ? e.message : "unknown error",
      });
    }
  }

  return {
    ok: true,
    considered: candidates.length,
    advanced,
    skipped: `${rows.length - candidates.length} run(s) still being driven by a browser`,
  };
}

// GET — Vercel cron. Only sweeps runs whose browser has gone quiet.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await drive({ onlyStale: true });
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}

// POST — admin "nudge my runs along" without waiting for the next cron tick.
export async function POST() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const result = await drive({ onlyStale: false });
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}

import { NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { advanceRun, getResearchProviderInfo } from "@/lib/research";
import { createClient } from "@/lib/supabase/server";
import type { Run } from "@/lib/types";

// A tick is sized to fill Vercel's 60s wall (STAGE_DEADLINE_MS), so the
// function has to be allowed to use it.
export const maxDuration = 60;

// POST — advance one run by one stage.
//
// Same work as advanceRunAction, reachable as a plain request: a long run can
// be ticked from a poller or a script holding a session, without a server-action
// round-trip. advanceRun() takes no lock — never fire two of these at one run.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAppUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = await createClient();

  // RLS lets every active teammate read every run, so ownership is checked here.
  const { data, error } = await supabase
    .from("runs")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = data as Pick<Run, "id" | "user_id">;

  if (run.user_id !== user.id && user.role !== "admin") {
    return NextResponse.json(
      { error: "You can only advance runs you started" },
      { status: 403 }
    );
  }

  // 503 rather than letting advanceRun() fail the run permanently: an absent
  // key is this deployment's state, not this run's.
  const info = getResearchProviderInfo();
  if (info === null || !info.configured) {
    return NextResponse.json(
      {
        error:
          info === null
            ? "Research engine not configured — RESEARCH_PROVIDER names a provider this build has no adapter for."
            : info.missingConfig.length > 0
              ? `Research engine not configured — set ${info.missingConfig.join(", ")} in .env.local.`
              : `Research engine not configured — ${info.id} needs a host-executed search backend and this build has none.`,
      },
      { status: 503 }
    );
  }

  try {
    return NextResponse.json(await advanceRun(run.id));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "This run could not be advanced." },
      { status: 500 }
    );
  }
}

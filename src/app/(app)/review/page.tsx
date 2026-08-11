import Link from "next/link";
import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Company, Contact } from "@/lib/types";
import { ReviewQueue, type ReviewLead } from "./review-queue";

export const metadata = { title: "Review queue" };

// is_sample lands in migration 20260811120001; src/lib/types.ts still describes
// the pre-Phase-2 companies row.
type DraftRow = Company & {
  is_sample: boolean;
  industry: { id: string; name: string } | null;
  contacts: Contact[];
};

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string; run?: string }>;
}) {
  const { industry, run } = await searchParams;
  const user = await requireAppUser();
  const supabase = await createClient();

  // Only your own drafts: approving is an ownership decision, and RLS would
  // refuse the write anyway (PRD §7 — teammates' leads are read-only).
  let query = supabase
    .from("companies")
    .select("*, industry:industries(id, name), contacts(*)")
    .eq("status", "draft")
    .eq("owner_id", user.id)
    .order("fit_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(100);

  if (industry) query = query.eq("industry_id", industry);
  if (run) query = query.eq("created_by_run", run);

  const { data } = await query;
  const rows = (data ?? []) as unknown as DraftRow[];

  const leads: ReviewLead[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    domain: row.domain_normalized ?? row.domain,
    instagram_handle: row.instagram_handle_normalized ?? row.instagram_handle,
    ig_followers_band: row.ig_followers_band,
    city: row.city,
    revenue_estimate: row.revenue_estimate,
    funding_stage: row.funding_stage,
    shark_tank_status: row.shark_tank_status,
    digital_presence: row.digital_presence,
    fit_score: row.fit_score,
    confidence: row.confidence,
    hook: row.hook,
    sources: row.sources ?? [],
    is_sample: row.is_sample === true,
    created_by_run: row.created_by_run,
    industry_name: row.industry?.name ?? null,
    contacts: [...row.contacts].sort(
      (a, b) =>
        Number(b.is_primary) - Number(a.is_primary) ||
        a.created_at.localeCompare(b.created_at)
    ),
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Review queue</h1>
          <p className="text-sm text-muted-foreground">
            {leads.length} drafted lead{leads.length === 1 ? "" : "s"} waiting on
            you
            {run && " from this run"}. Approving syncs the lead to the Google
            Sheet; rejecting keeps it out of every future run.
          </p>
        </div>
        {run && (
          <Link href={`/runs/${run}`} className="text-sm underline">
            ← back to the run
          </Link>
        )}
      </div>

      <ReviewQueue leads={leads} />
    </div>
  );
}

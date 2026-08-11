import "server-only";

// The write boundary: ScoredLead → companies + contacts rows.
//
// Same dedup path as the manual-add action (src/app/actions/companies.ts):
// check_company_duplicate RPC first, unique-index 23505 as the race backstop.
// The difference is the failure mode — a run drafts many leads, so a collision
// skips that lead and the run continues, rather than surfacing an error.

import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { normalizeDomain, normalizeIgHandle } from "@/lib/normalize";
import type {
  ContactChannelStatus,
  DuplicateCheckResult,
} from "@/lib/types";
import type { ResearchContact, ScoredLead } from "./contracts";

export interface DraftLeadsInput {
  runId: string;
  industryId: string;
  ownerId: string;
  leads: ScoredLead[];
  isSample: boolean;
}

export interface DraftLeadsResult {
  draftedIds: string[];
  skipped: Array<{ name: string; reason: string }>;
}

type AdminClient = ReturnType<typeof createAdminClient>;

function orNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * PRD §6.1: research NEVER produces a `verified` channel — that status is
 * reserved for enrichment APIs (Phase 3). The return type has no `verified`
 * arm, so `verified` is literally unreachable from this file; the only way a
 * contact reaches that status is a Phase 3 enrichment write.
 */
function researchChannelStatus(
  value: string | null
): Exclude<ContactChannelStatus, "verified"> {
  return value === null ? "unknown" : "public_generic";
}

/**
 * True/false = the check ran. null = it could not run, and the unique indexes
 * below are the only remaining guard.
 *
 * The RPC gates on app_is_active(), which reads auth.uid() — a service-role
 * connection has no auth user, so inside a run the RPC can legitimately
 * refuse. The fallback re-implements only its exact-match arms, against the
 * same generated normalized columns the RPC reads.
 */
/**
 * A row THIS run already drafted, if the stage is being retried. Matched on
 * the dedup keys the DB itself enforces (normalized domain / handle), falling
 * back to the exact name within the run — a lead with neither a domain nor a
 * handle has no stronger identity to match on.
 */
async function findOwnDraft(
  admin: AdminClient,
  lead: ScoredLead,
  runId: string
): Promise<string | null> {
  const domain = normalizeDomain(lead.domain);
  const handle = normalizeIgHandle(lead.instagram_handle);

  const filters: Array<[string, string]> = [];
  if (domain) filters.push(["domain_normalized", domain]);
  if (handle) filters.push(["instagram_handle_normalized", handle]);
  if (filters.length === 0) filters.push(["name", lead.name]);

  for (const [column, value] of filters) {
    const { data, error } = await admin
      .from("companies")
      .select("id")
      .eq("created_by_run", runId)
      .eq(column, value)
      .limit(1);
    if (error) return null;
    const hit = (data as Array<{ id: string }> | null)?.[0];
    if (hit) return hit.id;
  }
  return null;
}

async function probeExactDuplicate(
  admin: AdminClient,
  lead: ScoredLead
): Promise<boolean | null> {
  const { data, error } = await admin.rpc("check_company_duplicate", {
    p_name: lead.name,
    p_domain: lead.domain,
    p_instagram: lead.instagram_handle,
    p_city: lead.city,
    p_exclude_id: null,
  });
  if (!error) {
    const result = data as DuplicateCheckResult;
    // fuzzy_matches deliberately ignored: PRD §7 says a fuzzy hit flags for
    // human confirmation and never auto-merges. The review queue is that human.
    return Boolean(result.domain_match || result.instagram_match);
  }

  const keys: Array<[string, string]> = [];
  const domain = normalizeDomain(lead.domain);
  if (domain) keys.push(["domain_normalized", domain]);
  const handle = normalizeIgHandle(lead.instagram_handle);
  if (handle) keys.push(["instagram_handle_normalized", handle]);

  for (const [column, value] of keys) {
    const { data: hits, error: lookupError } = await admin
      .from("companies")
      .select("id")
      .eq(column, value)
      .limit(1);
    if (lookupError) return null;
    if ((hits ?? []).length > 0) return true;
  }
  // No domain and no handle means no exact key exists — the RPC's exact arms
  // would have been null too.
  return false;
}

interface ContactWriteResult {
  inserted: number;
  error: string | null;
}

async function insertContacts(
  admin: AdminClient,
  companyId: string,
  contacts: ResearchContact[]
): Promise<ContactWriteResult> {
  const usable = contacts.filter(
    (c) => orNull(c.fullName) || orNull(c.email) || orNull(c.phone)
  );
  if (usable.length === 0) return { inserted: 0, error: null };

  // A founder is who the team wants to reach (PRD §6.1); fall back to the
  // first contact so the company always has exactly one primary.
  const founderIndex = usable.findIndex((c) => c.roleType === "founder");
  const primaryIndex = founderIndex === -1 ? 0 : founderIndex;

  const rows = usable.map((contact, index) => {
    const email = orNull(contact.email);
    const phone = orNull(contact.phone);
    return {
      company_id: companyId,
      full_name: orNull(contact.fullName),
      designation: orNull(contact.designation),
      role_type: contact.roleType,
      email,
      email_status: researchChannelStatus(email),
      phone,
      phone_status: researchChannelStatus(phone),
      source: "research" as const,
      is_primary: index === primaryIndex,
    };
  });

  const { error } = await admin.from("contacts").insert(rows);
  // A contact write failure must not undo a drafted company — the lead is
  // still worth reviewing, and Phase 3 enrichment can fill the gap.
  return error
    ? { inserted: 0, error: error.message }
    : { inserted: rows.length, error: null };
}

export async function draftLeads(
  input: DraftLeadsInput
): Promise<DraftLeadsResult> {
  const admin = createAdminClient();
  const draftedIds: string[] = [];
  const skipped: DraftLeadsResult["skipped"] = [];

  for (const lead of input.leads) {
    // Last line of defence behind guardrails.ts: PRD §6.1 says a lead with no
    // source cannot be drafted, and this is the only place rows are written.
    if (lead.sources.length === 0) {
      skipped.push({ name: lead.name, reason: "no_sources" });
      continue;
    }

    // Idempotency first. A tick can insert rows and then die before its run
    // state is saved (a timeout in the persist step is enough); the retry
    // re-runs this whole stage. Without this check the retry sees its OWN
    // rows, calls them duplicates, and reports "0 leads drafted" for a run
    // that actually drafted them — which is what happened on the first
    // successful run.
    const mine = await findOwnDraft(admin, lead, input.runId);
    if (mine !== null) {
      draftedIds.push(mine);
      continue;
    }

    // Re-check at write time (PRD §7 enforcement point 2): a teammate may have
    // added this company since the exclusion list was built at seed.
    if ((await probeExactDuplicate(admin, lead)) === true) {
      skipped.push({ name: lead.name, reason: "duplicate" });
      continue;
    }

    const { data: created, error } = await admin
      .from("companies")
      .insert({
        industry_id: input.industryId,
        name: lead.name,
        domain: lead.domain,
        instagram_handle: lead.instagram_handle,
        ig_followers_band: lead.ig_followers_band,
        city: lead.city,
        revenue_estimate: lead.revenue_estimate,
        funding_stage: lead.funding_stage,
        shark_tank_status: lead.shark_tank_status,
        digital_presence: lead.digital_presence,
        fit_score: lead.fit_score,
        hook: lead.hook,
        confidence: lead.confidence,
        sources: lead.sources,
        status: "draft",
        owner_id: input.ownerId,
        created_by_run: input.runId,
        is_sample: input.isSample,
      })
      .select("id")
      .single();

    if (error || !created) {
      // 23505 = the unique index caught a race the probe could not see (a
      // concurrent run, or a teammate saving mid-insert). Same handling as
      // createCompany, minus the abort: one lead is lost, the run goes on.
      const reason =
        error?.code === "23505"
          ? "duplicate"
          : `insert failed: ${error?.message ?? "no row returned"}`;
      skipped.push({ name: lead.name, reason });
      continue;
    }

    const companyId = created.id as string;
    draftedIds.push(companyId);

    const contactWrite = await insertContacts(
      admin,
      companyId,
      lead.public_contacts
    );

    await logAudit(admin, {
      userId: input.ownerId,
      action: "company.draft",
      entity: "company",
      entityId: companyId,
      after: {
        name: lead.name,
        status: "draft",
        created_by_run: input.runId,
        is_sample: input.isSample,
        fit_score: lead.fit_score,
        confidence: lead.confidence,
        sources: lead.sources.length,
        contacts: contactWrite.inserted,
        contacts_error: contactWrite.error,
      },
    });
  }

  return { draftedIds, skipped };
}

"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAppUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { companyInputSchema } from "@/lib/schemas";
import { isSheetsConfigured, syncAllTabs, syncIndustry } from "@/lib/sheets";
import type { Company, DuplicateCheckResult } from "@/lib/types";

export type ActionResult<T = null> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; duplicate?: DuplicateCheckResult };

interface DuplicateProbe {
  name?: string;
  domain?: string;
  instagram?: string;
  city?: string;
  excludeId?: string;
}

async function runDuplicateCheck(
  probe: DuplicateProbe
): Promise<DuplicateCheckResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_company_duplicate", {
    p_name: probe.name ?? null,
    p_domain: probe.domain ?? null,
    p_instagram: probe.instagram ?? null,
    p_city: probe.city ?? null,
    p_exclude_id: probe.excludeId ?? null,
  });
  if (error) throw new Error(`Duplicate check failed: ${error.message}`);
  return data as DuplicateCheckResult;
}

// Live check-as-you-type on the manual-add form (PRD §7, enforcement point 3).
export async function checkDuplicates(
  probe: DuplicateProbe
): Promise<ActionResult<DuplicateCheckResult>> {
  try {
    await requireAppUser();
    return { ok: true, data: await runDuplicateCheck(probe) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Check failed" };
  }
}

function hasExactMatch(dup: DuplicateCheckResult): boolean {
  return Boolean(dup.domain_match || dup.instagram_match);
}

// Best-effort sheet refresh after data changes; never fails the main action.
async function tryResyncIndustry(industryId: string): Promise<string | null> {
  if (!isSheetsConfigured()) {
    return "Sheets sync not configured yet — will sync once credentials are added.";
  }
  const result = await syncIndustry(industryId);
  return result.ok ? null : `Sheet sync failed: ${result.error}`;
}

export async function createCompany(input: {
  values: unknown;
  confirmNotDuplicate?: boolean;
  approveNow?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  const parsed = companyInputSchema.safeParse(input.values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const values = parsed.data;
  const supabase = await createClient();

  // members add companies only within their allotted industries
  if (user.role !== "admin") {
    const { data: assignment } = await supabase
      .from("assignments")
      .select("id")
      .eq("user_id", user.id)
      .eq("industry_id", values.industry_id)
      .eq("active", true)
      .maybeSingle();
    if (!assignment) {
      return { ok: false, error: "You are not assigned to this industry." };
    }
  }

  // dedup re-check at save time (PRD §7, enforcement point 2)
  let dup: DuplicateCheckResult;
  try {
    dup = await runDuplicateCheck({
      name: values.name,
      domain: values.domain,
      instagram: values.instagram_handle,
      city: values.city,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Dedup check failed" };
  }

  if (hasExactMatch(dup)) {
    return {
      ok: false,
      error: "This company already exists.",
      duplicate: dup,
    };
  }
  if (dup.fuzzy_matches.length > 0 && !input.confirmNotDuplicate) {
    return {
      ok: false,
      error:
        "A similar company exists. Confirm this is not a duplicate to save.",
      duplicate: dup,
    };
  }

  const { data: created, error } = await supabase
    .from("companies")
    .insert({
      industry_id: values.industry_id,
      name: values.name,
      domain: values.domain ?? null,
      instagram_handle: values.instagram_handle ?? null,
      city: values.city ?? null,
      ig_followers_band: values.ig_followers_band ?? null,
      revenue_estimate: values.revenue_estimate ?? null,
      funding_stage: values.funding_stage ?? null,
      shark_tank_status: values.shark_tank_status ?? null,
      digital_presence: values.digital_presence ?? null,
      fit_score: values.fit_score ?? null,
      hook: values.hook ?? null,
      confidence: values.confidence ?? null,
      sources: values.sources,
      status: "draft",
      owner_id: user.id,
    })
    .select("id, industry_id")
    .single();

  if (error) {
    // unique-index race (two teammates saving simultaneously, PRD §7)
    if (error.code === "23505") {
      const existing = await runDuplicateCheck({
        name: values.name,
        domain: values.domain,
        instagram: values.instagram_handle,
      });
      return {
        ok: false,
        error: "A teammate just saved this company.",
        duplicate: existing,
      };
    }
    return { ok: false, error: `Save failed: ${error.message}` };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "company.create",
    entity: "company",
    entityId: created.id,
    after: { ...values, status: "draft" },
  });

  let message: string | undefined;
  if (input.approveNow) {
    const approved = await approveCompany(created.id);
    message = approved.ok ? approved.message : approved.error;
  }

  revalidatePath("/");
  revalidatePath("/pipeline");
  return { ok: true, data: { id: created.id }, message };
}

export async function updateCompany(input: {
  id: string;
  values: unknown;
  confirmNotDuplicate?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  const parsed = companyInputSchema
    .omit({ industry_id: true })
    .partial()
    .safeParse(input.values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const values = parsed.data;
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("companies")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Company not found." };
  const beforeRow = before as Company;

  if (values.name || values.domain || values.instagram_handle) {
    const dup = await runDuplicateCheck({
      name: values.name ?? beforeRow.name,
      domain: values.domain ?? beforeRow.domain ?? undefined,
      instagram: values.instagram_handle ?? beforeRow.instagram_handle ?? undefined,
      city: values.city ?? beforeRow.city ?? undefined,
      excludeId: input.id,
    });
    if (hasExactMatch(dup)) {
      return { ok: false, error: "Another company already uses that domain/handle.", duplicate: dup };
    }
    if (dup.fuzzy_matches.length > 0 && !input.confirmNotDuplicate) {
      return {
        ok: false,
        error: "A similar company exists. Confirm this is not a duplicate to save.",
        duplicate: dup,
      };
    }
  }

  const { data: updated, error } = await supabase
    .from("companies")
    .update(values)
    .eq("id", input.id)
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Another company already uses that domain/handle." };
    }
    return { ok: false, error: `Update failed: ${error.message}` };
  }
  if (!updated) {
    return { ok: false, error: "You can only edit companies you own." };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "company.update",
    entity: "company",
    entityId: input.id,
    before: beforeRow,
    after: values,
  });

  let message: string | undefined;
  if (["approved", "enriched", "synced"].includes(beforeRow.status)) {
    message = (await tryResyncIndustry(beforeRow.industry_id)) ?? undefined;
  }

  revalidatePath(`/companies/${input.id}`);
  revalidatePath("/pipeline");
  return { ok: true, data: { id: input.id }, message };
}

export async function approveCompany(
  id: string
): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!company) return { ok: false, error: "Company not found." };
  const row = company as Company;

  if (row.status === "rejected") {
    return {
      ok: false,
      error: "This company was rejected. Only an admin can un-reject it.",
    };
  }

  const { data: updated, error } = await supabase
    .from("companies")
    .update({ status: "approved" })
    .eq("id", id)
    .in("status", ["draft", "approved"])
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `Approve failed: ${error.message}` };
  if (!updated) {
    return { ok: false, error: "You can only approve companies you own." };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "company.approve",
    entity: "company",
    entityId: id,
    before: { status: row.status },
    after: { status: "approved" },
  });

  // PRD §9: sync on approve
  const syncNote = await tryResyncIndustry(row.industry_id);

  revalidatePath(`/companies/${id}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
  return {
    ok: true,
    data: { id },
    message: syncNote ?? "Approved and synced to the sheet.",
  };
}

export async function rejectCompany(input: {
  id: string;
  reason: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  const reason = input.reason?.trim();
  if (!reason || reason.length < 3) {
    return { ok: false, error: "A rejection reason is required." };
  }
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (!company) return { ok: false, error: "Company not found." };
  const row = company as Company;

  const { data: updated, error } = await supabase
    .from("companies")
    .update({ status: "rejected", rejected_reason: reason })
    .eq("id", input.id)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `Reject failed: ${error.message}` };
  if (!updated) {
    return { ok: false, error: "You can only reject companies you own." };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "company.reject",
    entity: "company",
    entityId: input.id,
    before: { status: row.status },
    after: { status: "rejected", rejected_reason: reason },
  });

  // if it was already on the sheet, rewrite the tab so it disappears
  let message: string | undefined;
  if (["approved", "enriched", "synced"].includes(row.status)) {
    message = (await tryResyncIndustry(row.industry_id)) ?? undefined;
  }

  revalidatePath(`/companies/${input.id}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
  return {
    ok: true,
    data: { id: input.id },
    message: message ?? "Rejected — it will never resurface in runs or manual adds.",
  };
}

// PRD §7: rejected companies are excluded forever UNLESS admin un-rejects.
export async function unrejectCompany(
  id: string
): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  if (user.role !== "admin") {
    return { ok: false, error: "Only admins can un-reject companies." };
  }
  const supabase = await createClient();

  const { data: updated, error } = await supabase
    .from("companies")
    .update({ status: "draft", rejected_reason: null })
    .eq("id", id)
    .eq("status", "rejected")
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `Un-reject failed: ${error.message}` };
  if (!updated) return { ok: false, error: "Company is not rejected." };

  await logAudit(supabase, {
    userId: user.id,
    action: "company.unreject",
    entity: "company",
    entityId: id,
    after: { status: "draft" },
  });

  revalidatePath(`/companies/${id}`);
  revalidatePath("/pipeline");
  return { ok: true, data: { id }, message: "Back to draft." };
}

// Admin "Sync now" — full re-sync of every tab + Master (PRD §9).
export async function syncSheetsNow(): Promise<ActionResult<{ tabs: string[] }>> {
  const user = await requireAppUser();
  if (user.role !== "admin") {
    return { ok: false, error: "Only admins can trigger a full re-sync." };
  }
  if (!isSheetsConfigured()) {
    return {
      ok: false,
      error:
        "Sheets sync not configured — add GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 and GOOGLE_SHEET_ID first.",
    };
  }

  const result = await syncAllTabs();
  if (!result.ok) {
    return { ok: false, error: result.error ?? "Sync failed" };
  }

  const supabase = await createClient();
  await logAudit(supabase, {
    userId: user.id,
    action: "sheets.full_sync",
    entity: "sheet",
    after: { tabs: result.tabs, companies: result.companiesSynced },
  });

  revalidatePath("/pipeline");
  return {
    ok: true,
    data: { tabs: result.tabs },
    message: `Synced ${result.companiesSynced} companies across ${result.tabs.length} tabs.`,
  };
}

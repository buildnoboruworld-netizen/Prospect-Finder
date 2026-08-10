"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAppUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { clampManualChannelStatus, contactInputSchema } from "@/lib/schemas";
import type { ActionResult } from "@/app/actions/companies";
import type { Company, Contact } from "@/lib/types";
import { isSheetsConfigured, syncIndustry } from "@/lib/sheets";

async function resyncIfOnSheet(company: Pick<Company, "industry_id" | "status">) {
  if (!isSheetsConfigured()) return;
  if (["approved", "enriched", "synced"].includes(company.status)) {
    await syncIndustry(company.industry_id); // best-effort; errors land in sheet_sync_log
  }
}

export async function addContact(input: {
  values: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  const parsed = contactInputSchema.safeParse(input.values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid contact" };
  }
  const values = parsed.data;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("id, industry_id, status, owner_id")
    .eq("id", values.company_id)
    .maybeSingle();
  if (!company) return { ok: false, error: "Company not found." };

  if (values.is_primary) {
    await supabase
      .from("contacts")
      .update({ is_primary: false })
      .eq("company_id", values.company_id)
      .eq("is_primary", true);
  }

  const { data: created, error } = await supabase
    .from("contacts")
    .insert({
      company_id: values.company_id,
      full_name: values.full_name ?? null,
      designation: values.designation ?? null,
      role_type: values.role_type,
      email: values.email ?? null,
      // manual entries can never claim 'verified' (PRD §6.1 guardrail)
      email_status: values.email ? clampManualChannelStatus(values.email_status) : "unknown",
      phone: values.phone ?? null,
      phone_status: values.phone ? clampManualChannelStatus(values.phone_status) : "unknown",
      source: "manual",
      is_primary: values.is_primary,
    })
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `Save failed: ${error.message}` };
  if (!created) {
    return { ok: false, error: "You can only add contacts to companies you own." };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "contact.create",
    entity: "contact",
    entityId: created.id,
    after: values,
  });
  await resyncIfOnSheet(company as Company);

  revalidatePath(`/companies/${values.company_id}`);
  return { ok: true, data: { id: created.id } };
}

export async function updateContact(input: {
  id: string;
  values: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  const parsed = contactInputSchema.safeParse(input.values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid contact" };
  }
  const values = parsed.data;
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("contacts")
    .select("*, company:companies(id, industry_id, status)")
    .eq("id", input.id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Contact not found." };
  const before = existing as Contact & { company: Company };

  if (values.is_primary && !before.is_primary) {
    await supabase
      .from("contacts")
      .update({ is_primary: false })
      .eq("company_id", before.company_id)
      .eq("is_primary", true);
  }

  const { data: updated, error } = await supabase
    .from("contacts")
    .update({
      full_name: values.full_name ?? null,
      designation: values.designation ?? null,
      role_type: values.role_type,
      email: values.email ?? null,
      email_status: values.email ? clampManualChannelStatus(values.email_status) : "unknown",
      phone: values.phone ?? null,
      phone_status: values.phone ? clampManualChannelStatus(values.phone_status) : "unknown",
      is_primary: values.is_primary,
    })
    .eq("id", input.id)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `Update failed: ${error.message}` };
  if (!updated) {
    return { ok: false, error: "You can only edit contacts on companies you own." };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "contact.update",
    entity: "contact",
    entityId: input.id,
    before,
    after: values,
  });
  await resyncIfOnSheet(before.company);

  revalidatePath(`/companies/${before.company_id}`);
  return { ok: true, data: { id: input.id } };
}

export async function deleteContact(
  id: string
): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("contacts")
    .select("*, company:companies(id, industry_id, status)")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Contact not found." };
  const before = existing as Contact & { company: Company };

  const { data: deleted, error } = await supabase
    .from("contacts")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `Delete failed: ${error.message}` };
  if (!deleted) {
    return { ok: false, error: "You can only remove contacts on companies you own." };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "contact.delete",
    entity: "contact",
    entityId: id,
    before,
  });
  await resyncIfOnSheet(before.company);

  revalidatePath(`/companies/${before.company_id}`);
  return { ok: true, data: { id } };
}

export async function setPrimaryContact(
  id: string
): Promise<ActionResult<{ id: string }>> {
  const user = await requireAppUser();
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("contacts")
    .select("id, company_id, company:companies(id, industry_id, status)")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Contact not found." };
  const row = existing as unknown as Contact & { company: Company };

  await supabase
    .from("contacts")
    .update({ is_primary: false })
    .eq("company_id", row.company_id)
    .eq("is_primary", true);

  const { data: updated, error } = await supabase
    .from("contacts")
    .update({ is_primary: true })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `Failed: ${error.message}` };
  if (!updated) {
    return { ok: false, error: "You can only edit contacts on companies you own." };
  }

  await logAudit(supabase, {
    userId: user.id,
    action: "contact.set_primary",
    entity: "contact",
    entityId: id,
  });
  await resyncIfOnSheet(row.company);

  revalidatePath(`/companies/${row.company_id}`);
  return { ok: true, data: { id } };
}

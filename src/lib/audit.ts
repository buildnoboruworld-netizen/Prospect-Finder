import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

interface AuditEntry {
  userId: string | null;
  action: string; // e.g. "company.approve"
  entity: string; // e.g. "company"
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

// Best-effort audit trail — never blocks the main operation.
export async function logAudit(
  supabase: SupabaseClient,
  entry: AuditEntry
): Promise<void> {
  try {
    await supabase.from("audit_log").insert({
      user_id: entry.userId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  } catch {
    // swallow — audit failures must not break user actions
  }
}

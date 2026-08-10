import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — BYPASSES RLS. Server-only ("server-only" makes any
// client-bundle import a build error). Used for: linking auth users to
// allowlist rows, sheet-sync bookkeeping, cron.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY missing — set it in .env.local (server-only, never expose to the client)."
    );
  }
  return createSupabaseClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

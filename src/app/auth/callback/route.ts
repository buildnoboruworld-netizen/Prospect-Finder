import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AppUser } from "@/lib/types";

// OAuth callback: exchange the code, then gate on the allowlist (users table).
// Allowlisted → link auth_user_id (idempotent) and enter the app.
// Not allowlisted → sign out immediately and show the friendly denial (P0-1).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const email = data.user.email?.toLowerCase() ?? null;
  const admin = createAdminClient();

  const { data: allowRow } = email
    ? await admin.from("users").select("*").eq("email", email).maybeSingle()
    : { data: null };

  const appUser = allowRow as AppUser | null;

  if (!appUser || !appUser.active) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/denied`);
  }

  // Link (or re-link) the auth account and backfill the display name.
  if (appUser.auth_user_id !== data.user.id || !appUser.name) {
    await admin
      .from("users")
      .update({
        auth_user_id: data.user.id,
        name:
          appUser.name ??
          (data.user.user_metadata?.full_name as string | undefined) ??
          null,
      })
      .eq("id", appUser.id);
  }

  return NextResponse.redirect(`${origin}/`);
}

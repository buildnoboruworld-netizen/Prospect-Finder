import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AppUser } from "@/lib/types";

export interface SessionInfo {
  appUser: AppUser;
}

// Loads the allowlisted team-member row for the current session.
// null → signed in but NOT on the allowlist (or deactivated).
// Works for every auth method (Google OAuth, email+password): if the session
// isn't linked to an allowlist row yet, we link it here by email.
export async function getAppUser(): Promise<AppUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: byId } = await supabase
    .from("users")
    .select("*")
    .eq("auth_user_id", user.id)
    .eq("active", true)
    .maybeSingle();
  if (byId) return byId as AppUser;

  // First sign-in (or a re-created auth account): match the allowlist by
  // email and link it. Admin client — the row isn't linked to us yet.
  const email = user.email?.toLowerCase();
  if (!email) return null;

  const admin = createAdminClient();
  const { data: byEmail } = await admin
    .from("users")
    .select("*")
    .eq("email", email)
    .maybeSingle();
  if (!byEmail || !byEmail.active) return null;

  await admin
    .from("users")
    .update({
      auth_user_id: user.id,
      name:
        byEmail.name ??
        (user.user_metadata?.full_name as string | undefined) ??
        null,
    })
    .eq("id", byEmail.id);

  return { ...(byEmail as AppUser), auth_user_id: user.id };
}

// For gated layouts/actions: redirects instead of returning null.
export async function requireAppUser(): Promise<AppUser> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const appUser = await getAppUser();
  if (!appUser) redirect("/denied");
  return appUser;
}

export async function requireAdmin(): Promise<AppUser> {
  const appUser = await requireAppUser();
  if (appUser.role !== "admin") redirect("/");
  return appUser;
}

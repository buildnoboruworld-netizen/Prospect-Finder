import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AppUser } from "@/lib/types";

export interface SessionInfo {
  appUser: AppUser;
}

// Loads the allowlisted team-member row for the current session.
// null → signed in with Google but NOT on the allowlist (or deactivated).
export async function getAppUser(): Promise<AppUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("auth_user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  return (data as AppUser | null) ?? null;
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

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { AppUser } from "@/lib/types";
import { UserManagement } from "./user-management";

export const metadata = { title: "Team" };

export default async function AdminUsersPage() {
  const admin = await requireAdmin();
  const supabase = await createClient();

  const { data } = await supabase
    .from("users")
    .select("*")
    .order("created_at");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Team allowlist</h1>
        <p className="text-sm text-muted-foreground">
          Only these Google accounts can sign in. Industry assignments are
          seeded via SQL for now (admin UI lands in Phase 4).
        </p>
      </div>
      <UserManagement users={(data ?? []) as AppUser[]} selfId={admin.id} />
    </div>
  );
}

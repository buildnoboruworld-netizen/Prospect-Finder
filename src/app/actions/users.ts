"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAppUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import type { ActionResult } from "@/app/actions/companies";
import type { UserRole } from "@/lib/types";

const addUserSchema = z.object({
  email: z.email("Enter a valid Google email"),
  name: z.string().trim().optional(),
  role: z.enum(["admin", "member"]).default("member"),
});

// Allowlist management (P0-1): only rows in `users` with active=true can
// sign in. Admin-only by both this guard and RLS.
export async function addTeamUser(input: {
  email: string;
  name?: string;
  role?: UserRole;
}): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAppUser();
  if (admin.role !== "admin") {
    return { ok: false, error: "Only admins can manage the team allowlist." };
  }

  const parsed = addUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { data: created, error } = await supabase
    .from("users")
    .insert({
      email: parsed.data.email.toLowerCase(),
      name: parsed.data.name || null,
      role: parsed.data.role,
      active: true,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That email is already on the list." };
    }
    return { ok: false, error: `Failed: ${error.message}` };
  }

  await logAudit(supabase, {
    userId: admin.id,
    action: "user.add",
    entity: "user",
    entityId: created.id,
    after: parsed.data,
  });

  revalidatePath("/admin/users");
  return { ok: true, data: { id: created.id } };
}

export async function setUserActive(input: {
  id: string;
  active: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAppUser();
  if (admin.role !== "admin") {
    return { ok: false, error: "Only admins can manage the team allowlist." };
  }
  if (input.id === admin.id && !input.active) {
    return { ok: false, error: "You can't deactivate your own account." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("users")
    .update({ active: input.active })
    .eq("id", input.id);

  if (error) return { ok: false, error: `Failed: ${error.message}` };

  await logAudit(supabase, {
    userId: admin.id,
    action: input.active ? "user.activate" : "user.deactivate",
    entity: "user",
    entityId: input.id,
  });

  revalidatePath("/admin/users");
  return { ok: true, data: { id: input.id } };
}

export async function setUserRole(input: {
  id: string;
  role: UserRole;
}): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAppUser();
  if (admin.role !== "admin") {
    return { ok: false, error: "Only admins can manage roles." };
  }
  if (input.id === admin.id && input.role !== "admin") {
    return { ok: false, error: "You can't demote your own account." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("users")
    .update({ role: input.role })
    .eq("id", input.id);

  if (error) return { ok: false, error: `Failed: ${error.message}` };

  await logAudit(supabase, {
    userId: admin.id,
    action: "user.set_role",
    entity: "user",
    entityId: input.id,
    after: { role: input.role },
  });

  revalidatePath("/admin/users");
  return { ok: true, data: { id: input.id } };
}

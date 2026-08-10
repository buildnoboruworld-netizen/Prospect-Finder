import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Industry } from "@/lib/types";
import { CompanyForm } from "./company-form";

export const metadata = { title: "Add company" };

export default async function NewCompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string }>;
}) {
  const { industry: preselect } = await searchParams;
  const user = await requireAppUser();
  const supabase = await createClient();

  let industries: Pick<Industry, "id" | "name">[] = [];
  if (user.role === "admin") {
    const { data } = await supabase
      .from("industries")
      .select("id, name")
      .order("name");
    industries = data ?? [];
  } else {
    const { data } = await supabase
      .from("assignments")
      .select("industry:industries(id, name)")
      .eq("user_id", user.id)
      .eq("active", true);
    industries = (data ?? [])
      .map((r) => r.industry as unknown as Pick<Industry, "id" | "name">)
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Add company</h1>
        <p className="text-sm text-muted-foreground">
          Found a brand on Instagram or Amazon? Add it here — duplicates are
          checked live against the whole team&apos;s database.
        </p>
      </div>
      <CompanyForm industries={industries} defaultIndustryId={preselect} />
    </div>
  );
}

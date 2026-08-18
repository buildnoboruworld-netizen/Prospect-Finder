import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isSheetsConfigured } from "@/lib/sheets";
import { EnrichWorkbook, type EnrichIndustry } from "./enrich-workbook";

export const metadata = { title: "Enrichment" };

interface IndustryLite {
  id: string;
  name: string;
  code: string | null;
}

// Mirrors the export query in src/lib/workbook/export.ts so the counts shown
// next to the download button match what the file actually contains: sample
// companies are fabricated demo rows, and rejected ones never leave the app.
interface CountableCompany {
  industry_id: string;
  contacts: { id: string }[];
}

export default async function EnrichPage() {
  const user = await requireAppUser();
  const supabase = await createClient();
  const isAdmin = user.role === "admin";

  // The picker offers only what this person may upload back — downloading a
  // teammate's industry would produce a workbook the importer refuses row by
  // row (CLAUDE.md: uploads are allotment-scoped, admins get everything).
  let visible: IndustryLite[];
  if (isAdmin) {
    const { data } = await supabase
      .from("industries")
      .select("id, name, code")
      .order("name");
    visible = (data ?? []) as IndustryLite[];
  } else {
    const { data } = await supabase
      .from("assignments")
      .select("industry:industries(id, name, code)")
      .eq("user_id", user.id)
      .eq("active", true);
    visible = ((data ?? []) as unknown as { industry: IndustryLite | null }[])
      .map((a) => a.industry)
      .filter((i): i is IndustryLite => i !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const byIndustry = new Map<string, { companies: number; waiting: number }>();
  if (visible.length > 0) {
    const { data } = await supabase
      .from("companies")
      .select("industry_id, contacts(id)")
      .in(
        "industry_id",
        visible.map((i) => i.id)
      )
      .eq("is_sample", false)
      .neq("status", "rejected");
    for (const row of (data ?? []) as unknown as CountableCompany[]) {
      const tally = byIndustry.get(row.industry_id) ?? { companies: 0, waiting: 0 };
      tally.companies += 1;
      if (row.contacts.length === 0) tally.waiting += 1;
      byIndustry.set(row.industry_id, tally);
    }
  }

  const industries: EnrichIndustry[] = visible.map((i) => ({
    ...i,
    companies: byIndustry.get(i.id)?.companies ?? 0,
    waiting: byIndustry.get(i.id)?.waiting ?? 0,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Enrichment</h1>
        <p className="text-sm text-muted-foreground">
          The tool finds the companies; you attach the people. Download a
          workbook, look the contacts up in RocketReach, fill the green columns,
          and upload it back — you will see exactly what changes before anything
          is saved.
        </p>
      </div>

      <EnrichWorkbook
        industries={industries}
        isAdmin={isAdmin}
        sheetPullAvailable={isAdmin && isSheetsConfigured()}
      />
    </div>
  );
}

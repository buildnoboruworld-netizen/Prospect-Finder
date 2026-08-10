import Link from "next/link";
import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Assignment, Company, Industry } from "@/lib/types";

type AssignmentRow = Assignment & {
  industry: Industry | null;
  user: { id: string; name: string | null; email: string } | null;
};

export default async function HomePage() {
  const user = await requireAppUser();
  const supabase = await createClient();

  const [{ data: industriesData }, { data: assignmentsData }, { data: companiesData }] =
    await Promise.all([
      supabase.from("industries").select("*").order("name"),
      supabase
        .from("assignments")
        .select(
          "*, industry:industries(*), user:users!assignments_user_id_fkey(id, name, email)"
        )
        .eq("active", true),
      supabase.from("companies").select("id, industry_id, status, owner_id"),
    ]);

  const industries = (industriesData ?? []) as Industry[];
  const assignments = (assignmentsData ?? []) as unknown as AssignmentRow[];
  const companies = (companiesData ?? []) as Pick<
    Company,
    "id" | "industry_id" | "status" | "owner_id"
  >[];

  const isAdmin = user.role === "admin";
  const myAssignments = assignments.filter((a) => a.user_id === user.id);
  const visibleIndustries = isAdmin
    ? industries
    : industries.filter((i) => myAssignments.some((a) => a.industry_id === i.id));

  const countsFor = (industryId: string) => {
    const rows = companies.filter(
      (c) =>
        c.industry_id === industryId && (isAdmin || c.owner_id === user.id)
    );
    return {
      total: rows.length,
      draft: rows.filter((c) => c.status === "draft").length,
      approved: rows.filter((c) => c.status === "approved").length,
      synced: rows.filter((c) => ["synced", "enriched"].includes(c.status)).length,
      rejected: rows.filter((c) => c.status === "rejected").length,
    };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {isAdmin ? "All industries" : "My industries"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "Team-wide pipeline counts per industry."
              : "Your allotted industries and pipeline counts."}
          </p>
        </div>
        <Button asChild>
          <Link href="/companies/new">Add company</Link>
        </Button>
      </div>

      {visibleIndustries.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No industries assigned yet</CardTitle>
            <CardDescription>
              Ask Pragaman to allot you an industry — assignments appear here
              automatically.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleIndustries.map((industry) => {
            const counts = countsFor(industry.id);
            const assignees = assignments.filter(
              (a) => a.industry_id === industry.id
            );
            return (
              <Card key={industry.id} className="flex flex-col">
                <CardHeader>
                  <CardTitle className="text-lg">{industry.name}</CardTitle>
                  <CardDescription>
                    {counts.total === 0
                      ? "No leads yet"
                      : `${counts.total} ${isAdmin ? "team" : "of your"} lead${counts.total === 1 ? "" : "s"}`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 space-y-3">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="secondary">draft {counts.draft}</Badge>
                    <Badge variant="secondary">approved {counts.approved}</Badge>
                    <Badge variant="secondary">synced {counts.synced}</Badge>
                    <Badge variant="secondary">rejected {counts.rejected}</Badge>
                  </div>
                  {isAdmin && (
                    <p className="text-xs text-muted-foreground">
                      {assignees.length > 0
                        ? `Assigned: ${assignees
                            .map((a) => a.user?.name ?? a.user?.email ?? "?")
                            .join(", ")}`
                        : "Unassigned"}
                    </p>
                  )}
                </CardContent>
                <CardFooter className="gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled
                    title="Research engine ships in Phase 2"
                  >
                    Run research
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/companies/new?industry=${industry.id}`}>
                      Add company
                    </Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/pipeline?industry=${industry.id}`}>
                      Pipeline →
                    </Link>
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

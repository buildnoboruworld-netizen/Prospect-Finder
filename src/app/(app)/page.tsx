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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  const myIndustries = industries.filter((i) =>
    assignments.some((a) => a.industry_id === i.id && a.user_id === user.id)
  );

  const countsFor = (industryId: string, mineOnly: boolean) => {
    const rows = companies.filter(
      (c) => c.industry_id === industryId && (!mineOnly || c.owner_id === user.id)
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
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">My industries</h1>
          <p className="text-sm text-muted-foreground">
            Your allotted industries and pipeline counts.
          </p>
        </div>
        <Button asChild>
          <Link href="/companies/new">Add company</Link>
        </Button>
      </div>

      {myIndustries.length === 0 ? (
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
          {myIndustries.map((industry) => {
            const counts = countsFor(industry.id, true);
            return (
              <Card key={industry.id} className="flex flex-col">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    {industry.name}
                    {industry.code && (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {industry.code}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {counts.total === 0
                      ? "No leads yet"
                      : `${counts.total} of your lead${counts.total === 1 ? "" : "s"}`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="secondary">draft {counts.draft}</Badge>
                    <Badge variant="secondary">approved {counts.approved}</Badge>
                    <Badge variant="secondary">synced {counts.synced}</Badge>
                    <Badge variant="secondary">rejected {counts.rejected}</Badge>
                  </div>
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

      {isAdmin && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">All industries</h2>
            <p className="text-sm text-muted-foreground">
              Team-wide allotment and pipeline counts across all{" "}
              {industries.length} industries.
            </p>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Code</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Approved+</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {industries.map((industry) => {
                  const counts = countsFor(industry.id, false);
                  const assignees = assignments.filter(
                    (a) => a.industry_id === industry.id
                  );
                  return (
                    <TableRow key={industry.id}>
                      <TableCell className="font-mono text-xs">
                        {industry.code ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/pipeline?industry=${industry.id}&scope=all`}
                          className="font-medium hover:underline"
                        >
                          {industry.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {assignees.length > 0 ? (
                          <span className="text-sm">
                            {assignees
                              .map((a) => a.user?.name ?? a.user?.email ?? "?")
                              .join(", ")}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            unassigned
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{counts.total}</TableCell>
                      <TableCell className="text-right">
                        {counts.approved + counts.synced}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}

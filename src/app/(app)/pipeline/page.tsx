import Link from "next/link";
import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PresenceBadge, StatusBadge } from "@/components/status-badge";
import type { CompanyListRow, Industry } from "@/lib/types";
import { PipelineFilters } from "./filters";
import { SyncNowButton } from "./sync-now-button";

export const metadata = { title: "Pipeline" };

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{
    industry?: string;
    status?: string;
    scope?: string;
    q?: string;
  }>;
}) {
  const { industry, status, scope, q } = await searchParams;
  const user = await requireAppUser();
  const supabase = await createClient();

  const { data: industriesData } = await supabase
    .from("industries")
    .select("id, name")
    .order("name");

  let query = supabase
    .from("companies")
    .select(
      "*, industry:industries(id, name, slug), owner:users(id, name, email), contacts(*)"
    )
    .order("updated_at", { ascending: false })
    .limit(250);

  if (industry) query = query.eq("industry_id", industry);
  if (status) query = query.eq("status", status);
  if ((scope ?? "mine") === "mine") query = query.eq("owner_id", user.id);
  if (q) query = query.ilike("name", `%${q}%`);

  const { data: companiesData } = await query;
  const companies = (companiesData ?? []) as unknown as CompanyListRow[];
  const industries = (industriesData ?? []) as Pick<Industry, "id" | "name">[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Your leads are editable; teammates&apos; leads are read-only for
            cross-reachout awareness.
          </p>
        </div>
        {user.role === "admin" && <SyncNowButton />}
      </div>

      <PipelineFilters industries={industries} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Industry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Fit</TableHead>
              <TableHead>Presence</TableHead>
              <TableHead>Primary contact</TableHead>
              <TableHead>Owner</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {companies.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="h-24 text-center text-muted-foreground"
                >
                  No companies match. Add one manually or run research (Phase 2).
                </TableCell>
              </TableRow>
            ) : (
              companies.map((c) => {
                const primary =
                  c.contacts.find((ct) => ct.is_primary) ?? c.contacts[0];
                const mine = c.owner_id === user.id;
                return (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/companies/${c.id}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {[c.domain, c.city].filter(Boolean).join(" · ") || "—"}
                      </p>
                    </TableCell>
                    <TableCell>{c.industry?.name ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell>{c.fit_score ? `${c.fit_score}/5` : "—"}</TableCell>
                    <TableCell>
                      <PresenceBadge presence={c.digital_presence} />
                    </TableCell>
                    <TableCell>
                      {primary ? (
                        <span className="text-sm">
                          {primary.full_name ?? primary.email ?? "—"}
                          {c.contacts.length > 1 && (
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              +{c.contacts.length - 1}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          → enrich
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">
                        {c.owner?.name ?? c.owner?.email ?? "—"}
                      </span>
                      {mine && (
                        <Badge variant="outline" className="ml-1">
                          you
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        {companies.length} compan{companies.length === 1 ? "y" : "ies"} shown
        (max 250).
      </p>
    </div>
  );
}

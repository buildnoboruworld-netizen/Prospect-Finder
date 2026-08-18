import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import type { AppUser, CompanyStatus, Industry, RunStage } from "@/lib/types";

export const metadata = { title: "Dashboard" };

// is_sample lands in migration 20260811120001; src/lib/types.ts still describes
// the pre-Phase-2 companies/runs rows, so the extra columns are declared here.
interface CompanyAgg {
  id: string;
  industry_id: string;
  owner_id: string;
  status: CompanyStatus;
  is_sample: boolean;
  contacts: { id: string; email: string | null }[];
}

interface RunTotals {
  cost_usd: number;
  leads_drafted: number;
  stage: RunStage;
  is_sample: boolean;
}

interface RunRecent extends RunTotals {
  id: string;
  created_at: string;
  provider: string | null;
  candidates_found: number;
  industry: { name: string } | null;
  user: { name: string | null; email: string } | null;
}

interface AssignmentAgg {
  industry_id: string;
  user_id: string;
}

// Everything from approved onwards is a lead the team is actually working, and
// the only population where "does it have a contact yet?" is a fair question.
const APPROVED_PLUS: readonly CompanyStatus[] = ["approved", "enriched", "synced"];
const STATUS_ORDER: readonly CompanyStatus[] = [
  "draft",
  "approved",
  "enriched",
  "synced",
  "rejected",
];

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

// Sub-cent run costs round to $0.00 and look free, which is exactly the number
// an admin would then stop watching.
function usd(n: number): string {
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}

function personName(u: { name: string | null; email: string } | null): string {
  return u?.name ?? u?.email ?? "—";
}

function Bar({
  value,
  total,
  muted = false,
}: {
  value: number;
  total: number;
  muted?: boolean;
}) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", muted ? "bg-foreground/35" : "bg-primary")}
        style={{ width: `${total === 0 ? 0 : (value / total) * 100}%` }}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  await requireAdmin();
  const supabase = await createClient();

  // Two run queries on purpose: the totals must cover every run ever, the
  // listing only the last handful — one query cannot honestly do both.
  const [
    { data: industriesData },
    { data: usersData },
    { data: assignmentsData },
    { data: companiesData },
    { data: runTotalsData },
    { data: runsRecentData },
  ] = await Promise.all([
    supabase.from("industries").select("id, name, code").order("name"),
    supabase.from("users").select("id, name, email, role, active").order("name"),
    supabase.from("assignments").select("industry_id, user_id").eq("active", true),
    supabase
      .from("companies")
      .select("id, industry_id, owner_id, status, is_sample, contacts(id, email)"),
    supabase.from("runs").select("cost_usd, leads_drafted, stage, is_sample"),
    supabase
      .from("runs")
      .select(
        "id, created_at, stage, provider, leads_drafted, candidates_found, cost_usd, is_sample, industry:industries(name), user:users(name, email)"
      )
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  const industries = (industriesData ?? []) as Pick<
    Industry,
    "id" | "name" | "code"
  >[];
  const users = (usersData ?? []) as Pick<
    AppUser,
    "id" | "name" | "email" | "role" | "active"
  >[];
  const assignments = (assignmentsData ?? []) as AssignmentAgg[];
  const companies = (companiesData ?? []) as unknown as CompanyAgg[];
  const runTotals = (runTotalsData ?? []) as RunTotals[];
  const runsRecent = (runsRecentData ?? []) as unknown as RunRecent[];

  const hasContact = (c: CompanyAgg) => c.contacts.length > 0;
  const hasEmail = (c: CompanyAgg) =>
    c.contacts.some((ct) => (ct.email ?? "").trim() !== "");

  const approvedPlus = companies.filter((c) => APPROVED_PLUS.includes(c.status));
  const withContact = approvedPlus.filter(hasContact);
  const withEmail = approvedPlus.filter(hasEmail);
  const sampleDrafts = companies.filter((c) => c.is_sample).length;

  const statusCounts = STATUS_ORDER.map((status) => ({
    status,
    count: companies.filter((c) => c.status === status).length,
  }));
  const draftCount = companies.filter((c) => c.status === "draft").length;

  const byOwner = users
    .map((u) => {
      const own = companies.filter((c) => c.owner_id === u.id);
      const ownApproved = own.filter((c) => APPROVED_PLUS.includes(c.status));
      return {
        user: u,
        total: own.length,
        draft: own.filter((c) => c.status === "draft").length,
        approved: ownApproved.length,
        contacted: ownApproved.filter(hasContact).length,
        industries: assignments.filter((a) => a.user_id === u.id).length,
      };
    })
    .sort((a, b) => b.total - a.total || a.user.email.localeCompare(b.user.email));

  const byIndustry = industries.map((industry) => {
    const rows = companies.filter((c) => c.industry_id === industry.id);
    const approved = rows.filter((c) => APPROVED_PLUS.includes(c.status));
    return {
      industry,
      total: rows.length,
      draft: rows.filter((c) => c.status === "draft").length,
      approved: approved.length,
      needsContact: approved.filter((c) => !hasContact(c)).length,
      assignees: assignments
        .filter((a) => a.industry_id === industry.id)
        .map((a) => users.find((u) => u.id === a.user_id))
        .filter((u): u is (typeof users)[number] => u !== undefined),
    };
  });

  const busiestIndustry = byIndustry.reduce((max, r) => Math.max(max, r.total), 0);
  const emptyIndustries = byIndustry.filter((r) => r.total === 0);
  const totalSpend = runTotals.reduce((sum, r) => sum + r.cost_usd, 0);
  const failedRuns = runTotals.filter((r) => r.stage === "failed").length;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Team dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Where the pipeline stands across all {industries.length} industries,
            and where the effort is missing.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/pipeline?scope=all">All leads</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/users">Team allowlist</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Leads in the system"
          value={companies.length.toLocaleString()}
          hint={
            sampleDrafts > 0
              ? `${sampleDrafts} of them are sample/demo rows`
              : "Every status, every industry"
          }
        />
        <Stat
          label="Approved and beyond"
          value={approvedPlus.length.toLocaleString()}
          hint={`${pct(approvedPlus.length, companies.length)}% of everything drafted`}
        />
        <Stat
          label="Waiting on review"
          value={draftCount.toLocaleString()}
          hint="Drafts nobody has judged yet"
        />
        <Stat
          label="Research spend"
          value={usd(totalSpend)}
          hint={`${runTotals.length} run${runTotals.length === 1 ? "" : "s"}${
            failedRuns > 0 ? ` · ${failedRuns} failed` : ""
          }`}
        />
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Enrichment coverage</h2>
          <p className="text-sm text-muted-foreground">
            Contacts are looked up by hand now, so this is the number that says
            whether approved leads are actually reachable.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardDescription>Approved+ with at least one contact</CardDescription>
              <CardTitle className="text-3xl">
                {pct(withContact.length, approvedPlus.length)}%
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Bar value={withContact.length} total={approvedPlus.length} />
              <p className="text-xs text-muted-foreground">
                {withContact.length} of {approvedPlus.length} companies ·{" "}
                {approvedPlus.length - withContact.length} still have nobody
                attached.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Approved+ with an email address</CardDescription>
              <CardTitle className="text-3xl">
                {pct(withEmail.length, approvedPlus.length)}%
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Bar value={withEmail.length} total={approvedPlus.length} muted />
              <p className="text-xs text-muted-foreground">
                {withEmail.length} of {approvedPlus.length} companies · a contact
                without an email cannot be mailed.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Leads by status</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-20 text-right">Leads</TableHead>
                <TableHead>Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statusCounts.map(({ status, count }) => (
                <TableRow key={status}>
                  <TableCell>
                    <StatusBadge status={status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{count}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Bar value={count} total={companies.length} />
                      <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                        {pct(count, companies.length)}%
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Leads by owner</h2>
          <p className="text-sm text-muted-foreground">
            Everyone on the allowlist, including the ones who have not started.
          </p>
        </div>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Teammate</TableHead>
                <TableHead className="text-right">Industries</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Drafts</TableHead>
                <TableHead className="text-right">Approved+</TableHead>
                <TableHead className="text-right">With contact</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byOwner.map((row) => (
                <TableRow key={row.user.id}>
                  <TableCell>
                    <span className="font-medium">{personName(row.user)}</span>
                    {row.user.role === "admin" && (
                      <Badge variant="outline" className="ml-2">
                        admin
                      </Badge>
                    )}
                    {!row.user.active && (
                      <Badge variant="outline" className="ml-2">
                        inactive
                      </Badge>
                    )}
                    {row.total === 0 && row.industries > 0 && (
                      <p className="text-xs text-muted-foreground">
                        allotted {row.industries} industr
                        {row.industries === 1 ? "y" : "ies"}, no leads yet
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.industries}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.total}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.draft}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.approved}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.contacted}
                    {row.approved > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({pct(row.contacted, row.approved)}%)
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Leads by industry</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Code</TableHead>
                <TableHead>Industry</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Drafts</TableHead>
                <TableHead className="text-right">Approved+</TableHead>
                <TableHead className="text-right">No contact</TableHead>
                <TableHead className="w-28">Volume</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byIndustry.map((row) => (
                <TableRow key={row.industry.id}>
                  <TableCell className="font-mono text-xs">
                    {row.industry.code ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/pipeline?industry=${row.industry.id}&scope=all`}
                      className="font-medium hover:underline"
                    >
                      {row.industry.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {row.assignees.length > 0 ? (
                      <span className="text-sm">
                        {row.assignees.map(personName).join(", ")}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        unassigned
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.total}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.draft}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.approved}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.needsContact > 0 ? (
                      <span className="font-medium">{row.needsContact}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Bar value={row.total} total={busiestIndustry} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Industries with nothing in them</h2>
        {emptyIndustries.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Every industry has at least one lead</CardTitle>
              <CardDescription>
                No blank patches left — the whole allotment sheet is being
                worked.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>
                {emptyIndustries.length} of {industries.length} industries have no
                leads yet
              </CardTitle>
              <CardDescription>
                An unassigned industry needs an owner before it needs a research
                run.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {emptyIndustries.map((row) => (
                <Badge key={row.industry.id} variant="outline" className="h-auto py-1">
                  {row.industry.name}
                  <span className="ml-1 text-muted-foreground">
                    {row.assignees.length > 0
                      ? row.assignees.map(personName).join(", ")
                      : "unassigned"}
                  </span>
                </Badge>
              ))}
            </CardContent>
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Recent research runs</h2>
          <p className="text-sm text-muted-foreground">
            {usd(totalSpend)} spent across {runTotals.length} run
            {runTotals.length === 1 ? "" : "s"}. Costs are provider estimates,
            not invoices.
          </p>
        </div>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Industry</TableHead>
                <TableHead>Started by</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead className="text-right">Candidates</TableHead>
                <TableHead className="text-right">Drafted</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runsRecent.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No research runs yet. Anyone with an allotted industry can
                    start one from Home.
                  </TableCell>
                </TableRow>
              ) : (
                runsRecent.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="whitespace-nowrap text-sm">
                      <Link href={`/runs/${run.id}`} className="hover:underline">
                        {new Date(run.created_at).toLocaleString()}
                      </Link>
                    </TableCell>
                    <TableCell>{run.industry?.name ?? "—"}</TableCell>
                    <TableCell>{personName(run.user)}</TableCell>
                    <TableCell>
                      <span className="text-sm">{run.provider ?? "—"}</span>
                      {run.is_sample && (
                        <Badge variant="outline" className="ml-2">
                          sample
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={run.stage === "failed" ? "destructive" : "outline"}
                      >
                        {run.stage}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.candidates_found}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.leads_drafted}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(run.cost_usd)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

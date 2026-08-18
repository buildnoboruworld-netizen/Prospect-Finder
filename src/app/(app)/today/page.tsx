import Link from "next/link";
import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getResearchProviderInfo } from "@/lib/research";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import type { CompanyStatus, Industry } from "@/lib/types";
import { RunResearchButton } from "../run-research-button";

export const metadata = { title: "Today" };

type IndustryLite = Pick<Industry, "id" | "name" | "code">;

// is_sample lands in migration 20260811120001; src/lib/types.ts still describes
// the pre-Phase-2 companies row.
interface WorkItem {
  id: string;
  name: string;
  domain: string | null;
  city: string | null;
  status: CompanyStatus;
  owner_id: string;
  industry_id: string;
  fit_score: number | null;
  is_sample: boolean;
  updated_at: string;
  contacts: { id: string; email: string | null }[];
  industry: IndustryLite | null;
}

const APPROVED_PLUS: readonly CompanyStatus[] = ["approved", "enriched", "synced"];

/**
 * The enrichment workbook download. `columns.ts` is the shared column contract
 * behind it; `industry` narrows the export to one industry's companies with the
 * contact columns left blank for RocketReach lookups.
 */
function workbookHref(industryId: string): string {
  return `/api/workbook/export?industry=${industryId}`;
}

function Queue({
  target,
  count,
  label,
}: {
  target: string;
  count: number;
  label: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{count}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {count === 0 ? (
          "nothing waiting"
        ) : (
          <a href={`#${target}`} className="underline">
            jump to the list
          </a>
        )}
      </CardContent>
    </Card>
  );
}

export default async function TodayPage() {
  const user = await requireAppUser();
  const supabase = await createClient();

  const { data: assignmentsData } = await supabase
    .from("assignments")
    .select("industry:industries(id, name, code)")
    .eq("user_id", user.id)
    .eq("active", true);

  const myIndustries = ((assignmentsData ?? []) as unknown as {
    industry: IndustryLite | null;
  }[])
    .map((a) => a.industry)
    .filter((i): i is IndustryLite => i !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const myIndustryIds = new Set(myIndustries.map((i) => i.id));

  // Two scopes, because the permissions differ: only I can approve drafts I
  // own, but enrichment uploads are allowed across a whole allotted industry.
  const base = supabase
    .from("companies")
    .select(
      "id, name, domain, city, status, owner_id, industry_id, fit_score, is_sample, updated_at, contacts(id, email), industry:industries(id, name, code)"
    )
    .order("updated_at", { ascending: false })
    .limit(500);
  const { data: companiesData } = await (myIndustries.length > 0
    ? base.or(
        `owner_id.eq.${user.id},industry_id.in.(${[...myIndustryIds].join(",")})`
      )
    : base.eq("owner_id", user.id));

  const companies = (companiesData ?? []) as unknown as WorkItem[];

  const drafts = companies
    .filter((c) => c.owner_id === user.id && c.status === "draft")
    .sort(
      (a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0) || a.name.localeCompare(b.name)
    );

  const inMyIndustries = companies.filter(
    (c) => myIndustryIds.has(c.industry_id) && APPROVED_PLUS.includes(c.status)
  );
  const needsEnrichment = inMyIndustries.filter((c) => c.contacts.length === 0);
  const enriched = inMyIndustries.filter((c) => c.contacts.length > 0);

  // "Never synced" is a sheet-log question, not a status question: `enriched`
  // survives re-syncs, so status alone would report healthy rows as missing.
  const syncedIds = new Set<string>();
  if (enriched.length > 0) {
    const { data: syncLogData } = await supabase
      .from("sheet_sync_log")
      .select("company_id")
      .eq("status", "success")
      .in(
        "company_id",
        enriched.map((c) => c.id)
      );
    for (const row of (syncLogData ?? []) as { company_id: string }[]) {
      syncedIds.add(row.company_id);
    }
  }
  const notOnSheet = enriched.filter((c) => !syncedIds.has(c.id));

  const enrichmentByIndustry = myIndustries
    .map((industry) => ({
      industry,
      rows: needsEnrichment.filter((c) => c.industry_id === industry.id),
    }))
    .filter((group) => group.rows.length > 0);

  // Deployment state, resolved once: it names the missing env vars in the
  // disabled button's tooltip so nobody has to read the server log.
  const research = getResearchProviderInfo();
  const researchDisabledReason =
    research === null
      ? "Research engine not configured (RESEARCH_PROVIDER names no known provider)."
      : !research.configured
        ? research.missingConfig.length > 0
          ? `Research engine not configured — set ${research.missingConfig.join(", ")}.`
          : `Research engine not configured — ${research.id} has no usable web search.`
        : null;

  const firstName = (user.name ?? user.email).split(/[\s.@]+/)[0];
  const totalOpen = drafts.length + needsEnrichment.length + notOnSheet.length;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Today</h1>
          <p className="text-sm text-muted-foreground">
            {totalOpen === 0
              ? `Nothing is blocked on you, ${firstName}. Start a research run below to refill the queue.`
              : `${totalOpen} thing${totalOpen === 1 ? "" : "s"} waiting on you across your ${myIndustries.length} allotted industr${myIndustries.length === 1 ? "y" : "ies"}.`}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/pipeline">My pipeline</Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Queue target="review" count={drafts.length} label="Drafts to review" />
        <Queue
          target="enrichment"
          count={needsEnrichment.length}
          label="Need a contact"
        />
        <Queue target="sheet" count={notOnSheet.length} label="Not on the sheet" />
      </div>

      <section id="review" className="scroll-mt-20 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Drafted leads awaiting review</h2>
            <p className="text-sm text-muted-foreground">
              Approving publishes a lead to the Google Sheet; rejecting keeps it
              out of every future run.
            </p>
          </div>
          {drafts.length > 0 && (
            <Button asChild size="sm">
              <Link href="/review">Open review queue</Link>
            </Button>
          )}
        </div>
        {drafts.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Review queue is clear</CardTitle>
              <CardDescription>
                Nothing is waiting on your judgement. A research run on one of
                your industries is the fastest way to refill it.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead className="text-right">Fit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drafts.slice(0, 8).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/companies/${c.id}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                      {c.is_sample && (
                        <Badge variant="outline" className="ml-2">
                          sample
                        </Badge>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {[c.domain, c.city].filter(Boolean).join(" · ") || "—"}
                      </p>
                    </TableCell>
                    <TableCell>{c.industry?.name ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.fit_score ? `${c.fit_score}/5` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {drafts.length > 8 && (
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                Showing the 8 best-scoring of {drafts.length} —{" "}
                <Link href="/review" className="underline">
                  review them all
                </Link>
                .
              </p>
            )}
          </div>
        )}
      </section>

      <section id="enrichment" className="scroll-mt-20 space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Approved, but nobody to contact</h2>
          <p className="text-sm text-muted-foreground">
            Download the workbook for an industry, look the people up in
            RocketReach, fill the contact columns, and upload it back. Company ID
            stays untouched; a blank one creates a new company.
          </p>
        </div>
        {enrichmentByIndustry.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>
                {myIndustries.length === 0
                  ? "Nothing to enrich until you have an industry"
                  : inMyIndustries.length === 0
                    ? "No approved leads yet"
                    : "Every approved lead has a contact"}
              </CardTitle>
              <CardDescription>
                {myIndustries.length === 0
                  ? "Enrichment workbooks are scoped to an allotted industry, so this list stays empty until one is assigned to you."
                  : inMyIndustries.length === 0
                    ? "Approve a drafted lead and it shows up here, ready for a RocketReach lookup."
                    : `All ${inMyIndustries.length} approved compan${inMyIndustries.length === 1 ? "y" : "ies"} in your industries ${inMyIndustries.length === 1 ? "has" : "have"} at least one person attached. That is the whole job — nicely done.`}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-4">
            {enrichmentByIndustry.map(({ industry, rows }) => (
              <Card key={industry.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {industry.name}
                    {industry.code && (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {industry.code}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {rows.length} compan{rows.length === 1 ? "y" : "ies"} with no
                    contact yet.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1 text-sm">
                    {rows.slice(0, 6).map((c) => (
                      <li key={c.id} className="flex items-center gap-2">
                        <Link
                          href={`/companies/${c.id}`}
                          className="font-medium hover:underline"
                        >
                          {c.name}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {[c.domain, c.city].filter(Boolean).join(" · ")}
                        </span>
                        <StatusBadge status={c.status} />
                      </li>
                    ))}
                  </ul>
                  {rows.length > 6 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      + {rows.length - 6} more in the workbook.
                    </p>
                  )}
                </CardContent>
                <CardFooter className="gap-2">
                  <Button asChild size="sm">
                    <a href={workbookHref(industry.id)}>Download workbook</a>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/pipeline?industry=${industry.id}`}>
                      Pipeline →
                    </Link>
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section id="sheet" className="scroll-mt-20 space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Has contacts, not on the sheet</h2>
          <p className="text-sm text-muted-foreground">
            These have people attached but no successful Google Sheet write, so
            the team cannot see them yet.
          </p>
        </div>
        {notOnSheet.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>
                {enriched.length === 0
                  ? "No enriched companies to sync yet"
                  : "Everything enriched is on the sheet"}
              </CardTitle>
              <CardDescription>
                {enriched.length === 0
                  ? "Attach a contact to an approved company and its sync status appears here."
                  : `All ${enriched.length} enriched compan${enriched.length === 1 ? "y is" : "ies are"} mirrored to the Google Sheet.`}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Contacts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {notOnSheet.slice(0, 15).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/companies/${c.id}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>{c.industry?.name ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.contacts.length}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              Editing a lead re-syncs its industry automatically. If these stay
              here, ask an admin to hit <strong>Sync now</strong> on the pipeline
              — the sheet credentials are probably missing.
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">My industries</h2>
          <p className="text-sm text-muted-foreground">
            Research drafts the companies; you decide which ones are real.
          </p>
        </div>
        {myIndustries.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No industries assigned yet</CardTitle>
              <CardDescription>
                Ask Pragaman to allot you an industry — it appears here
                automatically, and this page fills up the moment it does.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {myIndustries.map((industry) => {
              const mine = companies.filter(
                (c) => c.industry_id === industry.id && c.owner_id === user.id
              );
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
                      {mine.length === 0
                        ? "No leads of yours here yet — a run takes a few minutes."
                        : `${mine.length} of your lead${mine.length === 1 ? "" : "s"}`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1" />
                  <CardFooter className="gap-2">
                    <RunResearchButton
                      industryId={industry.id}
                      disabledReason={researchDisabledReason}
                    />
                    <Button asChild variant="outline" size="sm">
                      <a href={workbookHref(industry.id)}>Workbook</a>
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/companies/new?industry=${industry.id}`}>
                        Add
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

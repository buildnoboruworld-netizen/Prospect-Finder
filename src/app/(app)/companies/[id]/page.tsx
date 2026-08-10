import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { PresenceBadge, StatusBadge } from "@/components/status-badge";
import type {
  AuditLog,
  Company,
  Contact,
  SheetSyncLog,
} from "@/lib/types";
import { CompanyActions } from "./company-actions";
import { ContactsSection } from "./contacts-section";
import { EditCompanyDialog } from "./edit-company-dialog";

type CompanyDetail = Company & {
  industry: { id: string; name: string } | null;
  owner: { id: string; name: string | null; email: string } | null;
  contacts: Contact[];
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children ?? "—"}</dd>
    </div>
  );
}

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireAppUser();
  const supabase = await createClient();

  const { data } = await supabase
    .from("companies")
    .select(
      "*, industry:industries(id, name), owner:users(id, name, email), contacts(*)"
    )
    .eq("id", id)
    .maybeSingle();

  if (!data) notFound();
  const company = data as unknown as CompanyDetail;
  const canEdit = user.role === "admin" || company.owner_id === user.id;

  const [{ data: syncData }, { data: auditData }] = await Promise.all([
    supabase
      .from("sheet_sync_log")
      .select("*")
      .eq("company_id", id)
      .order("synced_at", { ascending: false })
      .limit(5),
    supabase
      .from("audit_log")
      .select("*, user:users(name, email)")
      .eq("entity_id", id)
      .order("at", { ascending: false })
      .limit(10),
  ]);

  const syncLog = (syncData ?? []) as SheetSyncLog[];
  const audit = (auditData ?? []) as unknown as (AuditLog & {
    user: { name: string | null; email: string } | null;
  })[];

  const contacts = [...company.contacts].sort(
    (a, b) =>
      Number(b.is_primary) - Number(a.is_primary) ||
      a.created_at.localeCompare(b.created_at)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{company.name}</h1>
            <StatusBadge status={company.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {company.industry?.name ?? "—"} · owned by{" "}
            {company.owner?.name ?? company.owner?.email ?? "—"}
            {company.owner_id === user.id && " (you)"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && <EditCompanyDialog company={company} />}
          <CompanyActions
            companyId={company.id}
            status={company.status}
            canEdit={canEdit}
            isAdmin={user.role === "admin"}
          />
        </div>
      </div>

      {!canEdit && (
        <Alert>
          <AlertDescription>
            Read-only — this lead belongs to{" "}
            {company.owner?.name ?? company.owner?.email}. Coordinate before any
            cross-reachout.
          </AlertDescription>
        </Alert>
      )}

      {company.status === "rejected" && (
        <Alert variant="destructive">
          <AlertTitle>Rejected — excluded from all future runs</AlertTitle>
          <AlertDescription>
            Reason: {company.rejected_reason ?? "—"}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Website">
              {company.domain ? (
                <a
                  href={`https://${company.domain_normalized ?? company.domain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {company.domain}
                </a>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Instagram">
              {company.instagram_handle_normalized ? (
                <a
                  href={`https://instagram.com/${company.instagram_handle_normalized}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  @{company.instagram_handle_normalized}
                </a>
              ) : (
                "—"
              )}
            </Field>
            <Field label="City">{company.city ?? "—"}</Field>
            <Field label="IG followers">{company.ig_followers_band ?? "—"}</Field>
            <Field label="Revenue estimate">{company.revenue_estimate ?? "—"}</Field>
            <Field label="Funding stage">{company.funding_stage ?? "—"}</Field>
            <Field label="Shark Tank">{company.shark_tank_status ?? "—"}</Field>
            <Field label="Digital presence">
              <PresenceBadge presence={company.digital_presence} />
            </Field>
            <Field label="Fit / confidence">
              {company.fit_score ? `${company.fit_score}/5` : "—"}
              {company.confidence && (
                <Badge variant="outline" className="ml-2">
                  {company.confidence}
                </Badge>
              )}
            </Field>
          </dl>
          {company.hook && (
            <>
              <Separator className="my-4" />
              <Field label="Discovery-gap hook">{company.hook}</Field>
            </>
          )}
          {(company.sources ?? []).length > 0 && (
            <>
              <Separator className="my-4" />
              <Field label="Sources">
                <ul className="list-disc space-y-1 pl-4">
                  {company.sources.map((s, i) => (
                    <li key={i}>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-sm underline"
                      >
                        {s.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </Field>
            </>
          )}
        </CardContent>
      </Card>

      <ContactsSection
        companyId={company.id}
        contacts={contacts}
        canEdit={canEdit}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sheet sync</CardTitle>
          </CardHeader>
          <CardContent>
            {syncLog.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Not synced yet — appears in the Google Sheet after approval.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {syncLog.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <Badge
                      variant={s.status === "success" ? "secondary" : "destructive"}
                    >
                      {s.status}
                    </Badge>
                    <span>{new Date(s.synced_at).toLocaleString()}</span>
                    {s.error_message && (
                      <span className="text-xs text-destructive">
                        {s.error_message}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audit trail</CardTitle>
          </CardHeader>
          <CardContent>
            {audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {audit.map((a) => (
                  <li key={a.id}>
                    <span className="font-medium">{a.action}</span>{" "}
                    <span className="text-muted-foreground">
                      by {a.user?.name ?? a.user?.email ?? "system"} ·{" "}
                      {new Date(a.at).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Added {new Date(company.created_at).toLocaleDateString()} · last updated{" "}
        {new Date(company.updated_at).toLocaleString()} ·{" "}
        <Link href="/pipeline" className="underline">
          back to pipeline
        </Link>
      </p>
    </div>
  );
}

import "server-only";
import { google, type sheets_v4 } from "googleapis";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Company, Contact, Industry } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// One-way Google Sheets sync: DB → Sheet (PRD §9). The Sheet is a mirror,
// the DB is truth. Full tab rewrite per sync = idempotent, no drift.
// Tabs: one per industry + "Master". Six core columns first, in this exact
// order, then the detail columns. One row per contact, company fields
// repeated, primary contact flagged in the last column.
// ─────────────────────────────────────────────────────────────────────────────

export const SHEET_COLUMNS = [
  "Industry",
  "Company",
  "Contact Person",
  "Designation",
  "Email",
  "Phone",
  "Website",
  "Instagram",
  "City",
  "Revenue/Stage",
  "Shark Tank",
  "Fit",
  "Digital Presence",
  "Hook",
  "Confidence",
  "Owner",
  "Status",
  "Sources",
  "Primary",
] as const;

const MASTER_TAB = "Master";
// statuses that appear in the sheet — approved and beyond, never drafts/rejects
const SYNCABLE_STATUSES = ["approved", "enriched", "synced"] as const;

export function isSheetsConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 && process.env.GOOGLE_SHEET_ID
  );
}

function getSheetsClient(): { api: sheets_v4.Sheets; spreadsheetId: string } {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!b64 || !spreadsheetId) {
    throw new Error(
      "Google Sheets sync not configured — set GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 and GOOGLE_SHEET_ID in .env.local."
    );
  }

  let creds: { client_email: string; private_key: string };
  try {
    creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64-encoded JSON."
    );
  }

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return { api: google.sheets({ version: "v4", auth }), spreadsheetId };
}

type CompanyWithJoins = Company & {
  contacts: Contact[];
  owner: { name: string | null; email: string } | null;
  industry: { name: string } | null;
};

function companyRows(c: CompanyWithJoins): string[][] {
  const base = {
    industry: c.industry?.name ?? "",
    company: c.name,
    website: c.domain ?? "",
    instagram: c.instagram_handle_normalized
      ? `@${c.instagram_handle_normalized}`
      : "",
    city: c.city ?? "",
    revenueStage: [c.revenue_estimate, c.funding_stage]
      .filter(Boolean)
      .join(" · "),
    sharkTank: c.shark_tank_status ?? "",
    fit: c.fit_score?.toString() ?? "",
    presence: c.digital_presence ?? "",
    hook: c.hook ?? "",
    confidence: c.confidence ?? "",
    owner: c.owner?.name ?? c.owner?.email ?? "",
    status: c.status,
    sources: (c.sources ?? []).map((s) => s.url).join("\n"),
  };

  const toRow = (contact: Contact | null): string[] => [
    base.industry,
    base.company,
    contact?.full_name ?? "",
    contact?.designation ?? "",
    contact?.email ?? "",
    contact?.phone ?? "",
    base.website,
    base.instagram,
    base.city,
    base.revenueStage,
    base.sharkTank,
    base.fit,
    base.presence,
    base.hook,
    base.confidence,
    base.owner,
    base.status,
    base.sources,
    contact?.is_primary ? "★" : "",
  ];

  const contacts = [...(c.contacts ?? [])].sort(
    (a, b) =>
      Number(b.is_primary) - Number(a.is_primary) ||
      a.created_at.localeCompare(b.created_at)
  );

  // no contacts yet → still one row so the company is visible (→ enrich later)
  return contacts.length === 0 ? [toRow(null)] : contacts.map(toRow);
}

async function fetchSyncableCompanies(
  industryId?: string
): Promise<CompanyWithJoins[]> {
  const admin = createAdminClient();
  let query = admin
    .from("companies")
    .select(
      "*, contacts(*), owner:users(name, email), industry:industries(name)"
    )
    .in("status", [...SYNCABLE_STATUSES])
    .order("name");
  if (industryId) query = query.eq("industry_id", industryId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load companies: ${error.message}`);
  return (data ?? []) as unknown as CompanyWithJoins[];
}

async function ensureTab(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string
): Promise<void> {
  const meta = await api.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(
    (s) => s.properties?.title === title
  );
  if (!exists) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
  }
}

async function writeTab(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  rows: string[][]
): Promise<void> {
  await ensureTab(api, spreadsheetId, title);
  await api.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${title}'!A:Z`,
  });
  await api.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [[...SHEET_COLUMNS], ...rows] },
  });
}

export interface SyncResult {
  ok: boolean;
  tabs: string[];
  companiesSynced: number;
  error?: string;
}

// Rewrites one industry tab + the Master tab. Marks approved companies as
// synced and logs to sheet_sync_log.
export async function syncIndustry(industryId: string): Promise<SyncResult> {
  const admin = createAdminClient();
  const { data: industryRow, error: indErr } = await admin
    .from("industries")
    .select("id, name")
    .eq("id", industryId)
    .single();
  if (indErr || !industryRow) {
    return { ok: false, tabs: [], companiesSynced: 0, error: "Industry not found" };
  }
  const industry = industryRow as Pick<Industry, "id" | "name">;

  const companies = await fetchSyncableCompanies(industryId);

  try {
    const { api, spreadsheetId } = getSheetsClient();
    const rows = companies.flatMap(companyRows);
    await writeTab(api, spreadsheetId, industry.name, rows);
    await rebuildMasterTab(api, spreadsheetId);
    await recordSyncSuccess(companies);
    return {
      ok: true,
      tabs: [industry.name, MASTER_TAB],
      companiesSynced: companies.length,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown sync error";
    await recordSyncError(companies, message);
    return { ok: false, tabs: [], companiesSynced: 0, error: message };
  }
}

// Full re-sync: every industry tab that has syncable companies + Master.
export async function syncAllTabs(): Promise<SyncResult> {
  const admin = createAdminClient();
  const { data: industriesData, error } = await admin
    .from("industries")
    .select("id, name")
    .order("name");
  if (error) {
    return { ok: false, tabs: [], companiesSynced: 0, error: error.message };
  }

  const all = await fetchSyncableCompanies();
  const tabs: string[] = [];

  try {
    const { api, spreadsheetId } = getSheetsClient();
    for (const industry of industriesData ?? []) {
      const companies = all.filter((c) => c.industry_id === industry.id);
      if (companies.length === 0) continue;
      await writeTab(
        api,
        spreadsheetId,
        industry.name,
        companies.flatMap(companyRows)
      );
      tabs.push(industry.name);
    }
    await rebuildMasterTab(api, spreadsheetId, all);
    tabs.push(MASTER_TAB);
    await recordSyncSuccess(all);
    return { ok: true, tabs, companiesSynced: all.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown sync error";
    await recordSyncError(all, message);
    return { ok: false, tabs, companiesSynced: 0, error: message };
  }
}

async function rebuildMasterTab(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  preloaded?: CompanyWithJoins[]
): Promise<void> {
  const all = preloaded ?? (await fetchSyncableCompanies());
  const rows = all
    .sort(
      (a, b) =>
        (a.industry?.name ?? "").localeCompare(b.industry?.name ?? "") ||
        a.name.localeCompare(b.name)
    )
    .flatMap(companyRows);
  await writeTab(api, spreadsheetId, MASTER_TAB, rows);
}

async function recordSyncSuccess(companies: CompanyWithJoins[]): Promise<void> {
  if (companies.length === 0) return;
  const admin = createAdminClient();
  const ids = companies.map((c) => c.id);

  await admin.from("sheet_sync_log").insert(
    companies.map((c, i) => ({
      company_id: c.id,
      sheet_row: i + 2, // 1-based + header row
      status: "success" as const,
    }))
  );
  // approved → synced (never touch enriched — that state survives re-syncs)
  await admin
    .from("companies")
    .update({ status: "synced" })
    .in("id", ids)
    .eq("status", "approved");
}

async function recordSyncError(
  companies: CompanyWithJoins[],
  message: string
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from("sheet_sync_log").insert(
      companies.slice(0, 50).map((c) => ({
        company_id: c.id,
        status: "error" as const,
        error_message: message,
      }))
    );
  } catch {
    // logging must not mask the original failure
  }
}

import "server-only";
import { google, type sheets_v4 } from "googleapis";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Company, Contact } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// One-way Google Sheets sync: DB → Sheet (PRD §9). The Sheet is a mirror,
// the DB is truth. Full tab rewrite per sync = idempotent, no drift.
// Tabs: one per industry + "Master". Six core columns first, in this exact
// order, then the detail columns. One row per contact, company fields
// repeated, primary contact flagged in the last column.
//
// All writes are batched (one spreadsheets.get + one addSheet batch + one
// values.batchClear + one values.batchUpdate) so a full 26-industry sync
// stays far below the Sheets API's per-minute request quota.
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

async function fetchSyncableCompanies(): Promise<CompanyWithJoins[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("companies")
    .select(
      "*, contacts(*), owner:users(name, email), industry:industries(name)"
    )
    .in("status", [...SYNCABLE_STATUSES])
    .order("name");
  if (error) throw new Error(`Failed to load companies: ${error.message}`);
  return (data ?? []) as unknown as CompanyWithJoins[];
}

// Rewrites every given tab in 4 API calls total, regardless of tab count.
async function writeTabs(tabs: Map<string, string[][]>): Promise<void> {
  const { api, spreadsheetId } = getSheetsClient();

  const meta = await api.spreadsheets.get({ spreadsheetId });
  const existing = new Set(
    (meta.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t))
  );
  const missing = [...tabs.keys()].filter((t) => !existing.has(t));
  if (missing.length > 0) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  await api.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges: [...tabs.keys()].map((t) => `'${t}'!A:Z`) },
  });

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [...tabs.entries()].map(([title, rows]) => ({
        range: `'${title}'!A1`,
        values: [[...SHEET_COLUMNS], ...rows],
      })),
    },
  });
}

function masterRows(all: CompanyWithJoins[]): string[][] {
  return [...all]
    .sort(
      (a, b) =>
        (a.industry?.name ?? "").localeCompare(b.industry?.name ?? "") ||
        a.name.localeCompare(b.name)
    )
    .flatMap(companyRows);
}

export interface SyncResult {
  ok: boolean;
  tabs: string[];
  companiesSynced: number;
  error?: string;
}

// Rewrites one industry tab + the Master tab.
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

  const all = await fetchSyncableCompanies();
  const mine = all.filter((c) => c.industry_id === industryId);

  try {
    const tabs = new Map<string, string[][]>([
      [industryRow.name, mine.flatMap(companyRows)],
      [MASTER_TAB, masterRows(all)],
    ]);
    await writeTabs(tabs);
    await recordSyncSuccess(mine, all);
    return {
      ok: true,
      tabs: [industryRow.name, MASTER_TAB],
      companiesSynced: mine.length,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown sync error";
    await recordSyncError(mine, message);
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

  // Every industry tab is rewritten even when empty: keeps the mirror
  // self-healing (a rejected/deleted last lead disappears from its tab) and
  // pre-creates all tabs. Still 4 API calls total thanks to batching.
  const all = await fetchSyncableCompanies();
  const tabs = new Map<string, string[][]>();
  for (const industry of industriesData ?? []) {
    const companies = all.filter((c) => c.industry_id === industry.id);
    tabs.set(industry.name, companies.flatMap(companyRows));
  }
  tabs.set(MASTER_TAB, masterRows(all));

  try {
    await writeTabs(tabs);
    await recordSyncSuccess(all, all);
    return { ok: true, tabs: [...tabs.keys()], companiesSynced: all.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown sync error";
    await recordSyncError(all, message);
    return { ok: false, tabs: [], companiesSynced: 0, error: message };
  }
}

// Log a success row (with the tab row number) for companies whose industry
// tab was rewritten, and flip approved → synced for every company now on the
// sheet (Master always carries all of them).
async function recordSyncSuccess(
  tabCompanies: CompanyWithJoins[],
  allWritten: CompanyWithJoins[]
): Promise<void> {
  const admin = createAdminClient();

  if (tabCompanies.length > 0) {
    let row = 2; // 1-based + header
    const logs = tabCompanies.flatMap((c) => {
      const entry = {
        company_id: c.id,
        sheet_row: row,
        status: "success" as const,
      };
      row += Math.max(1, c.contacts?.length ?? 0);
      return [entry];
    });
    await admin.from("sheet_sync_log").insert(logs);
  }

  const ids = allWritten.map((c) => c.id);
  if (ids.length > 0) {
    // approved → synced (never touch enriched — that state survives re-syncs)
    await admin
      .from("companies")
      .update({ status: "synced" })
      .in("id", ids)
      .eq("status", "approved");
  }
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

import "server-only";
import { google, type sheets_v4 } from "googleapis";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { normalizeDomain, normalizeIgHandle, normalizeName } from "@/lib/normalize";
import { clampManualChannelStatus } from "@/lib/schemas";
import { normalizeHeader } from "@/lib/workbook/columns";
import type {
  Company,
  Contact,
  ContactRoleType,
  ContactSource,
} from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Google Sheets sync (PRD §9), now two-way for contact columns only
// (CLAUDE.md "Enrichment workflow", 18 Aug 2026).
//
// PUSH — DB → Sheet: the Sheet is a mirror, the DB is truth. Full tab rewrite
// per sync = idempotent, no drift. Tabs: one per industry + "Master". Six core
// columns first, in this exact order, then the detail columns. One row per
// contact, company fields repeated, primary contact flagged in the last column.
//
// PULL — Sheet → DB: the five contact columns (Contact Person, Designation,
// Email, Phone, Primary) are read back, because contacts now come from
// RocketReach lookups the team does by hand and the sheet is where they type
// them. Every other column stays one-way, so a stray edit to Hook or Fit is
// still discarded by the next rewrite.
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

// ─────────────────────────────────────────────────────────────────────────────
// PULL — Sheet → DB, contact columns only.
//
// The pull never CREATES a company. A row whose company cannot be resolved is
// reported, never guessed: inventing a company from a typo'd name is exactly
// the failure the dedup rules (PRD §7) exist to prevent. New companies arrive
// through the workbook, which carries an explicit Industry Code.
//
// The Master tab is not pulled either — its rows duplicate the industry tabs,
// so reading both would make "which copy is newer?" unanswerable. Master stays
// a read-only roll-up; edits belong in the industry tab.
// ─────────────────────────────────────────────────────────────────────────────

export interface PullResult {
  ok: boolean;
  scanned: number;
  created: number;
  updated: number;
  unmatched: Array<{ row: number; reason: string }>;
  error?: string;
}

interface TabTarget {
  id: string;
  name: string;
}

type SheetColumn = (typeof SHEET_COLUMNS)[number];

/** Reads one cell of the current row by column meaning, "" when absent. */
type RowReader = (column: SheetColumn) => string;

const HEADER_LOOKUP = new Map<string, SheetColumn>(
  SHEET_COLUMNS.map((c) => [normalizeHeader(c), c])
);

// Sheets hands cells back as strings for text and numbers for anything it
// managed to parse (a hand-typed phone, mostly), so nothing may be assumed.
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return (typeof value === "string" ? value : String(value)).trim();
}

// Columns are located by HEADER TEXT, never by position: this is a shared
// sheet and people insert, hide and reorder columns in it.
function mapHeaders(headerRow: unknown[]): Map<SheetColumn, number> {
  const found = new Map<SheetColumn, number>();
  headerRow.forEach((raw, index) => {
    const column = HEADER_LOOKUP.get(normalizeHeader(cellText(raw)));
    // first occurrence wins — a duplicated header (copy/paste accident) must
    // not silently redirect reads to the empty copy
    if (column && !found.has(column)) found.set(column, index);
  });
  return found;
}

interface CompanyIndex {
  byDomain: Map<string, CompanyWithJoins>;
  byInstagram: Map<string, CompanyWithJoins>;
  byName: Map<string, CompanyWithJoins[]>;
}

function indexCompanies(companies: CompanyWithJoins[]): CompanyIndex {
  const index: CompanyIndex = {
    byDomain: new Map(),
    byInstagram: new Map(),
    byName: new Map(),
  };
  for (const company of companies) {
    // both sides of every comparison go through src/lib/normalize.ts, so the
    // sheet cell and the DB row are folded the same way
    const domain = normalizeDomain(company.domain);
    if (domain) index.byDomain.set(domain, company);
    const handle = normalizeIgHandle(company.instagram_handle);
    if (handle) index.byInstagram.set(handle, company);
    const name = normalizeName(company.name);
    if (name) {
      const bucket = index.byName.get(name);
      if (bucket) bucket.push(company);
      else index.byName.set(name, [company]);
    }
  }
  return index;
}

type Resolution =
  | { kind: "company"; company: CompanyWithJoins }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" };

// Domain and Instagram handle are the hard dedup keys (unique indexes, PRD §7)
// so they outrank the company name, which people abbreviate and re-type.
function resolveCompany(index: CompanyIndex, read: RowReader): Resolution {
  const domain = normalizeDomain(read("Website"));
  const byDomain = domain ? index.byDomain.get(domain) : undefined;
  if (byDomain) return { kind: "company", company: byDomain };

  const handle = normalizeIgHandle(read("Instagram"));
  const byHandle = handle ? index.byInstagram.get(handle) : undefined;
  if (byHandle) return { kind: "company", company: byHandle };

  const name = normalizeName(read("Company"));
  const matches = name ? index.byName.get(name) ?? [] : [];
  if (matches.length === 1) return { kind: "company", company: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  return { kind: "none" };
}

// Identity inside a company is the email; a blank email falls back to the
// name. The fallback is what makes the actual workflow work — the team looks a
// founder up in RocketReach and pastes the address onto the row that already
// carries that person's name, so the email is new precisely when we need to
// match on something else.
function findContact(
  contacts: Contact[],
  email: string,
  fullName: string
): Contact | undefined {
  const wanted = email.toLowerCase();
  if (wanted) {
    const byEmail = contacts.find((c) => (c.email ?? "").toLowerCase() === wanted);
    if (byEmail) return byEmail;
  }
  const name = normalizeName(fullName);
  if (!name) return undefined;
  return contacts.find((c) => normalizeName(c.full_name) === name);
}

// 'verified' is reserved for enrichment-API results (PRD §6.1 guardrail).
// Every status this file writes is routed through the clamp, which makes that
// value unreachable from the sheet path by construction rather than by care.
function channelStatusFor(value: string): "public_generic" | "unknown" {
  return clampManualChannelStatus(value ? "public_generic" : "unknown");
}

interface ContactPatch {
  full_name?: string;
  designation?: string;
  email?: string;
  email_status?: "public_generic" | "unknown";
  phone?: string;
  phone_status?: "public_generic" | "unknown";
  source?: ContactSource;
}

// Google Sheets parses a hand-typed +919876543210 into a number and hands it
// back without the +, which would otherwise look like a human edit on every
// single pull. Same digits ⇒ same phone.
function samePhone(a: string, b: string): boolean {
  return a.replace(/\D/g, "") === b.replace(/\D/g, "");
}

function dbChangedSinceLastPush(
  updatedAt: string,
  lastPushAt: number | null
): boolean {
  if (lastPushAt === null) return false;
  const changed = Date.parse(updatedAt);
  return Number.isFinite(changed) && changed > lastPushAt;
}

/**
 * Conflict rule: MOST RECENT CHANGE WINS (CLAUDE.md, 18 Aug 2026).
 *
 * A sheet cell carries no edit timestamp, so "most recent" is INFERRED here —
 * a future reader must not mistake this for a real comparison of two dates:
 *
 *   the push writes DB values into the sheet, so right after a sync the two
 *   agree cell for cell. A sheet cell that DIFFERS from the DB can therefore
 *   only have been typed by a person since that write, which makes it the
 *   newer value, so it wins.
 *
 * Two guards keep that inference from eating good data:
 *
 *  1. A BLANK sheet cell never overwrites a value in the DB. Blank is
 *     ambiguous — "I cleared it" and "I never filled it in" look identical —
 *     and the destructive reading is not worth the convenience. Clearing a
 *     contact is done in the app.
 *  2. If the contact row changed in the DB *after* the last successful push,
 *     the sheet still shows the pre-edit value: it differs for the opposite
 *     reason and is stale, not new, so the DB wins. Without this guard every
 *     in-app contact edit would be reverted by the pull that runs at the start
 *     of the very sync that edit triggers.
 */
function contactPatch(
  existing: Contact,
  read: RowReader,
  lastPushAt: number | null
): ContactPatch {
  const patch: ContactPatch = {};
  if (dbChangedSinceLastPush(existing.updated_at, lastPushAt)) return patch;

  const fullName = read("Contact Person");
  if (fullName && fullName !== (existing.full_name ?? "")) {
    patch.full_name = fullName;
  }

  const designation = read("Designation");
  if (designation && designation !== (existing.designation ?? "")) {
    patch.designation = designation;
  }

  const email = read("Email");
  if (email && email.toLowerCase() !== (existing.email ?? "").toLowerCase()) {
    patch.email = email;
    patch.email_status = channelStatusFor(email);
  }

  const phone = read("Phone");
  if (phone && !samePhone(phone, existing.phone ?? "")) {
    patch.phone = phone;
    patch.phone_status = channelStatusFor(phone);
  }

  // a person retyped it, so the row is human-maintained from here on
  if (Object.keys(patch).length > 0) patch.source = "manual";
  return patch;
}

function contactInsert(companyId: string, read: RowReader) {
  const email = read("Email");
  const phone = read("Phone");
  return {
    company_id: companyId,
    full_name: read("Contact Person") || null,
    designation: read("Designation") || null,
    // the Sheet has no Role column (see src/lib/workbook/columns.ts) and role
    // is not something to infer from a job title
    role_type: "other" as ContactRoleType,
    email: email || null,
    email_status: channelStatusFor(email),
    phone: phone || null,
    phone_status: channelStatusFor(phone),
    source: "manual" as ContactSource,
    // settled in a second pass — one primary per company is a unique index
    is_primary: false,
  };
}

// "no"/"false"/"0" read as a deliberate un-starring; anything else non-blank
// is a star, because people type ★, x, yes and TRUE interchangeably.
const NOT_PRIMARY = new Set(["", "no", "n", "false", "0", "-", "—"]);

function wantsPrimary(read: RowReader): boolean {
  return !NOT_PRIMARY.has(read("Primary").toLowerCase());
}

// When the sheet was last rewritten from the DB — the reference point for
// guard 2 above. One row, newest first; null means we have never pushed, in
// which case the sheet cannot be holding anything of ours anyway.
async function lastSheetWriteAt(): Promise<number | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("sheet_sync_log")
    .select("synced_at")
    .eq("status", "success")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { synced_at: string } | null;
  if (!row) return null;
  const at = Date.parse(row.synced_at);
  return Number.isFinite(at) ? at : null;
}

// The mirror image of guard 2, for rows that no longer have a DB row to
// compare against: a contact deleted in the app after the last push is still
// sitting in the sheet, so its row "differs from the DB" — but because it is
// stale, not because a person typed it. Creating it back would silently undo
// every delete, and the delete's own sync is the pull that would do it.
// Deletes are found in the audit trail because contacts leave no tombstone.
async function contactsDeletedSincePush(
  lastPushAt: number | null
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (lastPushAt === null) return keys;

  const admin = createAdminClient();
  const { data } = await admin
    .from("audit_log")
    .select("before")
    .eq("action", "contact.delete")
    .gt("at", new Date(lastPushAt).toISOString())
    .limit(500);

  for (const row of (data ?? []) as Array<{ before: Partial<Contact> | null }>) {
    const before = row.before;
    if (!before?.company_id) continue;
    const email = (before.email ?? "").toLowerCase();
    if (email) keys.add(`${before.company_id}|e:${email}`);
    const name = normalizeName(before.full_name ?? null);
    if (name) keys.add(`${before.company_id}|n:${name}`);
  }
  return keys;
}

async function pullTargets(industryId?: string): Promise<TabTarget[]> {
  const admin = createAdminClient();
  const base = admin.from("industries").select("id, name").order("name");
  const { data, error } = industryId ? await base.eq("id", industryId) : await base;
  if (error) throw new Error(`Failed to load industries: ${error.message}`);
  return (data ?? []) as TabTarget[];
}

interface PullOutcome {
  result: PullResult;
  /** Tabs that could not be read — the caller must NOT rewrite these. */
  failedTabs: Set<string>;
}

async function pullTabs(targets: TabTarget[]): Promise<PullOutcome> {
  const result: PullResult = {
    ok: true,
    scanned: 0,
    created: 0,
    updated: 0,
    unmatched: [],
  };
  const failedTabs = new Set<string>();
  if (targets.length === 0) return { result, failedTabs };

  const { api, spreadsheetId } = getSheetsClient();

  // A tab that does not exist yet has never been pushed to, so it holds
  // nothing to read; asking for it would just 400 the whole batch.
  const meta = await api.spreadsheets.get({ spreadsheetId });
  const existing = new Set(
    (meta.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t))
  );
  const present = targets.filter((t) => existing.has(t.name));
  if (present.length === 0) return { result, failedTabs };

  // One batchGet for every tab: a 26-industry pull costs a single read
  // request, matching the batching discipline of the push.
  const response = await api.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: present.map((t) => `'${t.name}'!A:Z`),
  });
  const valueRanges = response.data.valueRanges ?? [];

  const companies = await fetchSyncableCompanies();
  const lastPushAt = await lastSheetWriteAt();
  const deletedSincePush = await contactsDeletedSincePush(lastPushAt);
  const admin = createAdminClient();
  const touched = new Set<string>();

  for (const [tabIndex, target] of present.entries()) {
    const grid: unknown[][] = valueRanges[tabIndex]?.values ?? [];
    if (grid.length === 0) continue;

    const headers = mapHeaders(grid[0]);
    if (!headers.has("Company")) {
      failedTabs.add(target.name);
      result.unmatched.push({
        row: 1,
        reason: `${target.name}: header row has no "Company" column — the tab was not read, and is left untouched rather than rewritten.`,
      });
      continue;
    }

    const index = indexCompanies(
      companies.filter((c) => c.industry_id === target.id)
    );
    // live per-company contact lists, so a second row in the same tab sees
    // what the first row just did
    const working = new Map<string, Contact[]>();
    const claimed = new Set<string>();
    const primaryIntent = new Map<string, { contactId: string; row: number }>();

    try {
      for (let r = 1; r < grid.length; r += 1) {
        const cells = grid[r] ?? [];
        if (cells.every((cell) => cellText(cell) === "")) continue; // spacer row
        result.scanned += 1;

        const rowNumber = r + 1; // 1-based, header is row 1
        const read: RowReader = (column) => {
          const at = headers.get(column);
          return at === undefined ? "" : cellText(cells[at]);
        };
        const reject = (reason: string) =>
          result.unmatched.push({
            row: rowNumber,
            reason: `${target.name} row ${rowNumber}: ${reason}`,
          });

        const fullName = read("Contact Person");
        const email = read("Email");
        const hasContactData =
          fullName || email || read("Phone") || read("Designation");
        // the placeholder row we write for a company with no contacts yet
        if (!hasContactData) continue;

        const resolution = resolveCompany(index, read);
        if (resolution.kind === "ambiguous") {
          reject(
            `"${read("Company")}" matches ${resolution.count} companies in this industry — fill in Website or Instagram to say which.`
          );
          continue;
        }
        if (resolution.kind === "none") {
          reject(
            `no company here matches "${read("Company")}" — add the company in the app first (the sheet never creates companies).`
          );
          continue;
        }
        const company = resolution.company;

        if (!fullName && !email) {
          reject("needs a Contact Person or an Email to identify the contact.");
          continue;
        }

        const contacts =
          working.get(company.id) ?? [...(company.contacts ?? [])];
        working.set(company.id, contacts);

        const match = findContact(contacts, email, fullName);
        if (match && claimed.has(match.id)) {
          reject(
            "an earlier row in this tab already updated this contact — remove the duplicate row."
          );
          continue;
        }

        if (match) {
          claimed.add(match.id);
          const patch = contactPatch(match, read, lastPushAt);
          if (Object.keys(patch).length > 0) {
            const { error } = await admin
              .from("contacts")
              .update(patch)
              .eq("id", match.id);
            if (error) {
              reject(`could not be saved — ${error.message}`);
              continue;
            }
            Object.assign(match, patch); // keep the in-memory row honest
            if (!touched.has(match.id)) {
              touched.add(match.id);
              result.updated += 1;
            }
          }
          if (wantsPrimary(read) && !primaryIntent.has(company.id)) {
            primaryIntent.set(company.id, { contactId: match.id, row: rowNumber });
          }
          continue;
        }

        const deletedKeys = [
          email ? `${company.id}|e:${email.toLowerCase()}` : null,
          `${company.id}|n:${normalizeName(fullName) ?? ""}`,
        ];
        if (deletedKeys.some((k) => k !== null && deletedSincePush.has(k))) {
          reject(
            "was deleted in the app after the sheet was last written — this row disappears on the next sync, so it was not re-created."
          );
          continue;
        }

        const insert = contactInsert(company.id, read);
        const { data: created, error } = await admin
          .from("contacts")
          .insert(insert)
          .select("id")
          .maybeSingle();
        const createdRow = created as { id: string } | null;
        if (error || !createdRow) {
          reject(`could not be saved — ${error?.message ?? "insert returned nothing"}`);
          continue;
        }
        const now = new Date().toISOString();
        contacts.push({
          ...insert,
          id: createdRow.id,
          credits_spent: 0,
          created_at: now,
          updated_at: now,
        });
        touched.add(createdRow.id);
        result.created += 1;
        if (wantsPrimary(read) && !primaryIntent.has(company.id)) {
          primaryIntent.set(company.id, {
            contactId: createdRow.id,
            row: rowNumber,
          });
        }
      }

      for (const [companyId, intent] of primaryIntent) {
        const contacts = working.get(companyId) ?? [];
        const current = contacts.find((c) => c.is_primary);
        if (current?.id === intent.contactId) continue; // unchanged
        // contacts_one_primary_per_company is a unique index, so the old star
        // has to come off before the new one goes on
        await admin
          .from("contacts")
          .update({ is_primary: false })
          .eq("company_id", companyId)
          .eq("is_primary", true);
        const { error } = await admin
          .from("contacts")
          .update({ is_primary: true })
          .eq("id", intent.contactId);
        if (error) {
          result.unmatched.push({
            row: intent.row,
            reason: `${target.name} row ${intent.row}: primary contact could not be set — ${error.message}`,
          });
          continue;
        }
        if (!touched.has(intent.contactId)) {
          touched.add(intent.contactId);
          result.updated += 1;
        }
      }
    } catch (e) {
      // one bad tab must not cost us the others, and must not be rewritten
      failedTabs.add(target.name);
      result.unmatched.push({
        row: 1,
        reason: `${target.name}: pull aborted — ${e instanceof Error ? e.message : "unknown error"}`,
      });
    }
  }

  if (result.created + result.updated + result.unmatched.length > 0) {
    await logAudit(admin, {
      userId: null, // system action: cron or a sync triggered by any teammate
      action: "sheets.pull",
      entity: "sheet",
      after: {
        tabs: present.map((t) => t.name),
        scanned: result.scanned,
        created: result.created,
        updated: result.updated,
        unmatched: result.unmatched,
      },
    });
  }

  return { result, failedTabs };
}

type SafePull =
  | { ok: true; result: PullResult; failedTabs: Set<string> }
  | { ok: false; error: string };

async function pullSafely(targets: TabTarget[]): Promise<SafePull> {
  try {
    const { result, failedTabs } = await pullTabs(targets);
    return { ok: true, result, failedTabs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown pull error" };
  }
}

// Reads contact columns back out of the industry tab(s) into the DB.
// Pass an industryId for one tab, omit it for every industry.
export async function pullContactsFromSheet(
  industryId?: string
): Promise<PullResult> {
  const failed = (error: string): PullResult => ({
    ok: false,
    scanned: 0,
    created: 0,
    updated: 0,
    unmatched: [],
    error,
  });
  try {
    const targets = await pullTargets(industryId);
    if (industryId && targets.length === 0) return failed("Industry not found");
    const pull = await pullSafely(targets);
    return pull.ok ? pull.result : failed(pull.error);
  } catch (e) {
    return failed(e instanceof Error ? e.message : "Unknown pull error");
  }
}

export interface SyncResult {
  ok: boolean;
  tabs: string[];
  companiesSynced: number;
  error?: string;
  pull?: PullResult;
}

// Rewrites one industry tab + the Master tab, after reading that tab's edits.
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
  const target: TabTarget = { id: industryRow.id, name: industryRow.name };

  // PULL BEFORE PUSH. writeTabs() clears a tab before rewriting it, so any
  // contact a teammate typed and we have not read yet dies the instant we
  // push. Reading first is the only order in which two-way sync is lossless —
  // which also means a failed pull must abort the push rather than proceed:
  // pushing over unread edits is precisely the data loss this guards against.
  const pull = await pullSafely([target]);
  if (!pull.ok) {
    return {
      ok: false,
      tabs: [],
      companiesSynced: 0,
      error: `Could not read the "${target.name}" tab (${pull.error}) — the rewrite was aborted, so nothing in the sheet was lost.`,
    };
  }
  if (pull.failedTabs.has(target.name)) {
    return {
      ok: false,
      tabs: [],
      companiesSynced: 0,
      pull: pull.result,
      error: `Could not read the "${target.name}" tab — the rewrite was aborted, so nothing in the sheet was lost.`,
    };
  }

  // fetched after the pull so the push writes back what we just read
  const all = await fetchSyncableCompanies();
  const mine = all.filter((c) => c.industry_id === industryId);

  try {
    const tabs = new Map<string, string[][]>([
      [target.name, mine.flatMap(companyRows)],
      [MASTER_TAB, masterRows(all)],
    ]);
    await writeTabs(tabs);
    await recordSyncSuccess(mine, all);
    return {
      ok: true,
      tabs: [target.name, MASTER_TAB],
      companiesSynced: mine.length,
      pull: pull.result,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown sync error";
    await recordSyncError(mine, message);
    return { ok: false, tabs: [], companiesSynced: 0, pull: pull.result, error: message };
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
  const industries = (industriesData ?? []) as TabTarget[];

  // PULL BEFORE PUSH — see syncIndustry. Here the abort is per tab: a tab we
  // could not read is simply left alone (its edits stay safe in the sheet and
  // get picked up next run) while the healthy tabs still sync.
  const pull = await pullSafely(industries);
  if (!pull.ok) {
    return {
      ok: false,
      tabs: [],
      companiesSynced: 0,
      error: `Sheet pull failed (${pull.error}) — the rewrite was aborted, so no sheet edits were lost.`,
    };
  }
  const skipped = industries
    .map((i) => i.name)
    .filter((name) => pull.failedTabs.has(name));

  // Every readable industry tab is rewritten even when empty: keeps the mirror
  // self-healing (a rejected/deleted last lead disappears from its tab) and
  // pre-creates all tabs. Still 4 API calls total thanks to batching.
  const all = await fetchSyncableCompanies();
  const tabs = new Map<string, string[][]>();
  for (const industry of industries) {
    if (pull.failedTabs.has(industry.name)) continue;
    const companies = all.filter((c) => c.industry_id === industry.id);
    tabs.set(industry.name, companies.flatMap(companyRows));
  }
  tabs.set(MASTER_TAB, masterRows(all));

  try {
    await writeTabs(tabs);
    await recordSyncSuccess(all, all);
    return {
      ok: skipped.length === 0,
      tabs: [...tabs.keys()],
      companiesSynced: all.length,
      pull: pull.result,
      error:
        skipped.length === 0
          ? undefined
          : `Left ${skipped.length} tab(s) untouched because their contact pull failed: ${skipped.join(", ")}.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown sync error";
    await recordSyncError(all, message);
    return { ok: false, tabs: [], companiesSynced: 0, pull: pull.result, error: message };
  }
}

// The one door the cron and the admin "Sync now" button should use: pull the
// team's contact edits in, then push the DB back out, in that order.
export async function syncSheets(industryId?: string): Promise<SyncResult> {
  return industryId ? syncIndustry(industryId) : syncAllTabs();
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

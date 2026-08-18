import "server-only";

// Enrichment workbook → database (CLAUDE.md "Enrichment workflow", 18 Aug 2026).
//
// Three steps, deliberately separate: parse the file, PLAN what would happen,
// then apply a plan the human has seen. The preview is the point — an upload
// can create companies and rewrite contacts across a whole industry, and the
// only defence against a mis-filled column is showing the person the outcome
// before anything is written.
//
// Nothing here is trusted from the client: `applyImport` must be handed a plan
// produced by `planImport` on the server in the same request (re-parse and
// re-plan the uploaded file rather than accepting a posted plan) — it re-checks
// only the unique-index races, not permissions.

import { Workbook, type CellValue } from "exceljs";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { normalizeDomain, normalizeIgHandle, normalizeName } from "@/lib/normalize";
import { contactRoleValues } from "@/lib/schemas";
import { isSheetsConfigured, syncIndustry } from "@/lib/sheets";
import type {
  CompanyStatus,
  ContactChannelStatus,
  ContactRoleType,
  DuplicateCheckResult,
  DuplicateMatch,
} from "@/lib/types";
import {
  CONTACT_KEYS,
  COLUMNS,
  INSTRUCTIONS_SHEET_NAME,
  SHEET_NAME,
  keyForHeader,
  type ColumnKey,
  type WorkbookRow,
} from "@/lib/workbook/columns";

type AdminClient = ReturnType<typeof createAdminClient>;

/** Without these three columns a row cannot be resolved to a company at all. */
const REQUIRED_KEYS: readonly ColumnKey[] = ["companyId", "industryCode", "company"];

/** A person filling contacts by hand will never legitimately exceed this. */
const MAX_DATA_ROWS = 5000;

/** How far down to look for the header when the file has a title row on top. */
const HEADER_SCAN_ROWS = 5;

const uuidSchema = z.uuid();
const emailSchema = z.email();

// ── parse ───────────────────────────────────────────────────────────────────

export interface ParseWorkbookResult {
  /**
   * One entry per worksheet row below the header, INCLUDING blank rows (as
   * empty objects) so an index maps back to a real row number for the preview.
   */
  rows: WorkbookRow[];
  /** Non-empty means nothing can be imported; `rows` is then empty. */
  errors: string[];
}

function numberToText(value: number): string {
  if (!Number.isFinite(value)) return "";
  // A phone column that lost its text formatting comes back as a number;
  // String() would render large values in exponential notation and finish the
  // job Excel started.
  return Number.isInteger(value) && Math.abs(value) < 1e21
    ? value.toFixed(0)
    : String(value);
}

/**
 * exceljs hands back objects for rich text, hyperlinks and formulas. A naive
 * String(cell.value) yields "[object Object]" on those, which would silently
 * poison every affected cell, so each shape is unwrapped explicitly.
 */
function cellToText(value: CellValue, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return numberToText(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (depth > 3) return "";
  if ("richText" in value) {
    return value.richText.map((part) => part.text).join("").trim();
  }
  if ("hyperlink" in value) {
    // Display text first: a Website cell autolinked by Excel keeps the typed
    // domain in `text` and a mailto:/https:// wrapper in `hyperlink`.
    return value.text.trim() || value.hyperlink.trim();
  }
  if ("formula" in value || "sharedFormula" in value) {
    return cellToText(value.result ?? null, depth + 1);
  }
  return ""; // #REF! / #N/A and friends carry no data
}

function isBlankRow(row: WorkbookRow): boolean {
  return Object.keys(row).length === 0;
}

export async function parseWorkbook(buffer: Buffer): Promise<ParseWorkbookResult> {
  const workbook = new Workbook();
  try {
    // exceljs types its loader against an ArrayBuffer-shaped Buffer of its own,
    // so the node Buffer's bytes are handed over rather than the Buffer itself.
    const bytes = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(bytes).set(buffer);
    await workbook.xlsx.load(bytes);
  } catch {
    return {
      rows: [],
      errors: ["Could not read this file — export a fresh workbook and re-fill it."],
    };
  }

  // The exported workbook carries an instructions tab too, so falling back to
  // "the first sheet" must skip it or a renamed Leads tab reads as garbage.
  const sheet =
    workbook.getWorksheet(SHEET_NAME) ??
    workbook.worksheets.find((s) => s.name !== INSTRUCTIONS_SHEET_NAME) ??
    workbook.worksheets[0];
  if (!sheet) return { rows: [], errors: ["The workbook has no sheets."] };

  // Header is matched by TEXT, never by position — people reorder columns and
  // paste through Google Sheets. Scan a few rows so a stray title row above the
  // table does not break the upload.
  let headerRowNumber = 0;
  let bestMatches = 0;
  let columnKeys = new Map<number, ColumnKey>();
  const scanTo = Math.min(HEADER_SCAN_ROWS, sheet.rowCount);
  for (let n = 1; n <= scanTo; n += 1) {
    const candidate = new Map<number, ColumnKey>();
    const row = sheet.getRow(n);
    for (let col = 1; col <= sheet.columnCount; col += 1) {
      const key = keyForHeader(cellToText(row.getCell(col).value));
      // First column wins a duplicated header; a second "Email" is ignored
      // rather than silently overriding the one the person filled in.
      if (key && ![...candidate.values()].includes(key)) candidate.set(col, key);
    }
    if (candidate.size > bestMatches) {
      bestMatches = candidate.size;
      headerRowNumber = n;
      columnKeys = candidate;
    }
  }

  if (headerRowNumber === 0) {
    return {
      rows: [],
      errors: [
        "No recognisable column headers were found — the first sheet must have the header row from the exported template.",
      ],
    };
  }

  const found = new Set(columnKeys.values());
  const missing = REQUIRED_KEYS.filter((key) => !found.has(key)).map(
    (key) => COLUMNS.find((c) => c.key === key)?.header ?? key
  );
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`],
    };
  }

  const errors: string[] = [];
  const rows: WorkbookRow[] = [];
  // Pad out any rows above the header so rows[i] is always worksheet row i + 2,
  // which is what the preview shows the person.
  for (let n = 2; n <= headerRowNumber; n += 1) rows.push({});

  for (let n = headerRowNumber + 1; n <= sheet.rowCount; n += 1) {
    if (rows.length >= MAX_DATA_ROWS + headerRowNumber - 1) {
      errors.push(
        `This file has more than ${MAX_DATA_ROWS} rows — split it and upload in batches.`
      );
      break;
    }
    const source = sheet.getRow(n);
    const parsed: WorkbookRow = {};
    for (const [col, key] of columnKeys) {
      const text = cellToText(source.getCell(col).value);
      if (text !== "") parsed[key] = text;
    }
    rows.push(parsed);
  }

  // Trailing blank rows are Excel padding, not data the person meant to send.
  while (rows.length > 0 && isBlankRow(rows[rows.length - 1] ?? {})) rows.pop();

  return { rows, errors };
}

// ── plan ────────────────────────────────────────────────────────────────────

export interface ContactValues {
  fullName: string | null;
  designation: string | null;
  roleType: ContactRoleType;
  email: string | null;
  phone: string | null;
}

export type RowCompanyPlan =
  | { action: "existing"; companyId: string; name: string; industryId: string; industryName: string }
  | {
      action: "link";
      companyId: string;
      name: string;
      industryId: string;
      industryName: string;
      matchedOn: "domain" | "instagram";
    }
  | { action: "create"; key: string; name: string; industryId: string; industryName: string }
  | { action: "skip" };

export type RowContactPlan =
  | { action: "none" }
  | { action: "create"; values: ContactValues }
  | { action: "update"; contactId: string; values: ContactValues; existingName: string | null }
  | { action: "skip"; reason: string };

export interface PlannedRow {
  /** 1-based worksheet row, so preview messages point at the file the person sees. */
  rowNumber: number;
  company: RowCompanyPlan;
  contact: RowContactPlan;
  warnings: string[];
  error: string | null;
}

/** A company that does not exist yet. Several rows can share one (one row per contact). */
export interface PlannedCompany {
  key: string;
  name: string;
  industryId: string;
  industryName: string;
  domain: string | null;
  instagramHandle: string | null;
  city: string | null;
  revenueEstimate: string | null;
  fundingStage: string | null;
  sharkTankStatus: string | null;
  rowNumbers: number[];
}

export interface ImportCounts {
  rows: number;
  companiesToCreate: number;
  companiesLinked: number;
  contactsToCreate: number;
  contactsToUpdate: number;
  rowsWithErrors: number;
}

export interface ImportPlan {
  counts: ImportCounts;
  companies: PlannedCompany[];
  rows: PlannedRow[];
  /** File-level problems. */
  errors: string[];
  /** File-level notes worth showing above the preview table. */
  warnings: string[];
}

export interface PlanImportInput {
  rows: WorkbookRow[];
  userId: string;
  isAdmin: boolean;
}

interface CompanyRef {
  id: string;
  name: string;
  industryId: string;
  status: CompanyStatus;
}

interface IndustryRef {
  id: string;
  name: string;
  code: string | null;
}

interface ExistingContactRef {
  id: string;
  companyId: string;
  email: string | null;
  fullName: string | null;
}

const emptyPlan = (errors: string[]): ImportPlan => ({
  counts: {
    rows: 0,
    companiesToCreate: 0,
    companiesLinked: 0,
    contactsToCreate: 0,
    contactsToUpdate: 0,
    rowsWithErrors: 0,
  },
  companies: [],
  rows: [],
  errors,
  warnings: [],
});

/** Domains typed by hand ("n/a", "coming soon") must not reach the dedup keys. */
function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(value);
}

function parseRole(raw: string | undefined): {
  roleType: ContactRoleType;
  warning: string | null;
} {
  if (!raw) return { roleType: "other", warning: null };
  const candidate = raw.trim().toLowerCase();
  const match = contactRoleValues.find((role) => role === candidate);
  if (match) return { roleType: match, warning: null };
  return {
    roleType: "other",
    warning: `Role "${raw}" is not one of founder / marketing / other — saved as "other".`,
  };
}

function hasContactFields(row: WorkbookRow): boolean {
  return CONTACT_KEYS.some((key) => (row[key] ?? "") !== "");
}

/**
 * The RPC gates on app_is_active(), so it needs the caller's session — a
 * service-role connection has no auth user and would be refused. When it is
 * unavailable the exact-match arms are re-run against the same generated
 * normalized columns; fuzzy matching (pg_trgm) is simply lost, which downgrades
 * a warning, never a guard.
 */
async function probeDuplicate(
  admin: AdminClient,
  probe: { name: string; domain: string | null; instagram: string | null; city: string | null }
): Promise<DuplicateCheckResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("check_company_duplicate", {
      p_name: probe.name,
      p_domain: probe.domain,
      p_instagram: probe.instagram,
      p_city: probe.city,
      p_exclude_id: null,
    });
    if (!error) return data as DuplicateCheckResult;
  } catch {
    // fall through to the direct lookups below
  }

  const columns = "id, name, domain, instagram_handle, city, status, rejected_reason, owner_id";
  const lookup = async (column: string, value: string): Promise<DuplicateMatch | null> => {
    const { data } = await admin.from("companies").select(columns).eq(column, value).limit(1);
    const hit = (data ?? [])[0];
    return hit
      ? { ...(hit as Omit<DuplicateMatch, "owner_name" | "industry_name">), owner_name: null, industry_name: null }
      : null;
  };

  return {
    domain_match: probe.domain ? await lookup("domain_normalized", probe.domain) : null,
    instagram_match: probe.instagram ? await lookup("instagram_handle_normalized", probe.instagram) : null,
    fuzzy_matches: [],
  };
}

async function loadCompanies(admin: AdminClient, ids: string[]): Promise<Map<string, CompanyRef>> {
  const out = new Map<string, CompanyRef>();
  if (ids.length === 0) return out;
  const { data } = await admin
    .from("companies")
    .select("id, name, industry_id, status")
    .in("id", ids);
  for (const row of (data ?? []) as Array<{
    id: string;
    name: string;
    industry_id: string;
    status: CompanyStatus;
  }>) {
    out.set(row.id, {
      id: row.id,
      name: row.name,
      industryId: row.industry_id,
      status: row.status,
    });
  }
  return out;
}

async function loadContacts(
  admin: AdminClient,
  companyIds: string[]
): Promise<Map<string, ExistingContactRef[]>> {
  const out = new Map<string, ExistingContactRef[]>();
  if (companyIds.length === 0) return out;
  const { data } = await admin
    .from("contacts")
    .select("id, company_id, email, full_name")
    .in("company_id", companyIds);
  for (const row of (data ?? []) as Array<{
    id: string;
    company_id: string;
    email: string | null;
    full_name: string | null;
  }>) {
    const list = out.get(row.company_id) ?? [];
    list.push({
      id: row.id,
      companyId: row.company_id,
      email: row.email,
      fullName: row.full_name,
    });
    out.set(row.company_id, list);
  }
  return out;
}

export async function planImport(input: PlanImportInput): Promise<ImportPlan> {
  const admin = createAdminClient();

  const { data: industryData, error: industryError } = await admin
    .from("industries")
    .select("id, name, code");
  if (industryError) {
    return emptyPlan([`Could not load industries: ${industryError.message}`]);
  }
  const industries = new Map<string, IndustryRef>();
  const industriesByCode = new Map<string, IndustryRef>();
  for (const row of (industryData ?? []) as Array<{ id: string; name: string; code: string | null }>) {
    const ref: IndustryRef = { id: row.id, name: row.name, code: row.code };
    industries.set(ref.id, ref);
    if (ref.code) industriesByCode.set(ref.code.trim().toUpperCase(), ref);
  }

  // Uploads are allowed for your own allotted industries; admins get all.
  const allotted = new Set<string>();
  if (!input.isAdmin) {
    const { data: assignments } = await admin
      .from("assignments")
      .select("industry_id")
      .eq("user_id", input.userId)
      .eq("active", true);
    for (const row of (assignments ?? []) as Array<{ industry_id: string }>) {
      allotted.add(row.industry_id);
    }
  }
  const mayTouch = (industryId: string): boolean => input.isAdmin || allotted.has(industryId);

  const referencedIds = new Set<string>();
  for (const row of input.rows) {
    const id = row.companyId;
    if (id && uuidSchema.safeParse(id).success) referencedIds.add(id);
  }
  const knownCompanies = await loadCompanies(admin, [...referencedIds]);

  // Pass 1 — resolve every row to a company without writing anything.
  interface Resolution {
    rowNumber: number;
    row: WorkbookRow;
    company: RowCompanyPlan;
    warnings: string[];
    error: string | null;
  }
  const resolutions: Resolution[] = [];
  const planned = new Map<string, PlannedCompany>();
  const fileWarnings: string[] = [];

  for (const [index, row] of input.rows.entries()) {
    if (isBlankRow(row)) continue;
    const rowNumber = index + 2;
    const warnings: string[] = [];
    const fail = (error: string): void => {
      resolutions.push({ rowNumber, row, company: { action: "skip" }, warnings, error });
    };

    const rawId = row.companyId;
    if (rawId) {
      if (!uuidSchema.safeParse(rawId).success) {
        fail(`Company ID "${rawId}" is not a valid ID — leave it blank to create a new company.`);
        continue;
      }
      const company = knownCompanies.get(rawId);
      if (!company) {
        fail(`Company ID "${rawId}" was not found — it may have been deleted.`);
        continue;
      }
      const industry = industries.get(company.industryId);
      if (!mayTouch(company.industryId)) {
        fail(`You are not assigned to ${industry?.name ?? "that industry"} — ask an admin for access.`);
        continue;
      }
      resolutions.push({
        rowNumber,
        row,
        company: {
          action: "existing",
          companyId: company.id,
          name: company.name,
          industryId: company.industryId,
          industryName: industry?.name ?? "",
        },
        warnings,
        error: null,
      });
      continue;
    }

    // Blank Company ID = a company the tool never found; the person is adding it.
    const name = row.company;
    if (!name) {
      fail("Company is required when Company ID is blank (a new company needs a name).");
      continue;
    }
    const code = row.industryCode;
    if (!code) {
      fail("Industry Code is required for a new company (e.g. ML, PF, HS).");
      continue;
    }
    const industry = industriesByCode.get(code.trim().toUpperCase());
    if (!industry) {
      fail(`Industry Code "${code}" is not one we know.`);
      continue;
    }
    if (!mayTouch(industry.id)) {
      fail(`You are not assigned to ${industry.name} — ask an admin for access.`);
      continue;
    }

    let domain = normalizeDomain(row.website);
    if (domain && !looksLikeDomain(domain)) {
      warnings.push(`Website "${row.website ?? ""}" does not look like a domain — ignored.`);
      domain = null;
    }
    const instagram = normalizeIgHandle(row.instagram);

    // Rows repeat company fields (one row per contact), so a second row for the
    // same new company must join it, not create a twin.
    const key = domain
      ? `d:${domain}`
      : instagram
        ? `i:${instagram}`
        : `n:${industry.id}:${normalizeName(name) ?? name.toLowerCase()}`;

    const already = planned.get(key);
    if (already) {
      already.rowNumbers.push(rowNumber);
      resolutions.push({
        rowNumber,
        row,
        company: {
          action: "create",
          key,
          name: already.name,
          industryId: already.industryId,
          industryName: already.industryName,
        },
        warnings,
        error: null,
      });
      continue;
    }

    const duplicate = await probeDuplicate(admin, {
      name,
      domain,
      instagram,
      city: row.city ?? null,
    });

    // PRD §7: an exact domain/instagram hit means the company already exists.
    // Never a second row for the same company — the contacts join the original.
    const exact = duplicate.domain_match ?? duplicate.instagram_match;
    if (exact) {
      const matchedOn = duplicate.domain_match ? "domain" : "instagram";
      const existing =
        (await loadCompanies(admin, [exact.id])).get(exact.id) ?? null;
      if (!existing) {
        fail(`"${name}" matches an existing company that could not be loaded — try again.`);
        continue;
      }
      if (!mayTouch(existing.industryId)) {
        const owningIndustry = industries.get(existing.industryId);
        fail(
          `"${name}" already exists under ${owningIndustry?.name ?? "another industry"}, which you are not assigned to.`
        );
        continue;
      }
      warnings.push(
        `"${name}" already exists (same ${matchedOn}) — contacts will be added to the existing company.`
      );
      if (existing.status === "rejected") {
        warnings.push(`${existing.name} is marked rejected — check with an admin before working it.`);
      }
      resolutions.push({
        rowNumber,
        row,
        company: {
          action: "link",
          companyId: existing.id,
          name: existing.name,
          industryId: existing.industryId,
          industryName: industries.get(existing.industryId)?.name ?? "",
          matchedOn,
        },
        warnings,
        error: null,
      });
      continue;
    }

    // Fuzzy hits are flagged for a human, never auto-merged (PRD §7).
    if (duplicate.fuzzy_matches.length > 0) {
      const names = duplicate.fuzzy_matches.map((m) => m.name).join(", ");
      warnings.push(`Similar to existing ${names} — confirm this is a different company.`);
    }

    planned.set(key, {
      key,
      name,
      industryId: industry.id,
      industryName: industry.name,
      domain,
      instagramHandle: instagram,
      city: row.city ?? null,
      revenueEstimate: row.revenueEstimate ?? null,
      fundingStage: row.fundingStage ?? null,
      sharkTankStatus: row.sharkTank ?? null,
      rowNumbers: [rowNumber],
    });
    resolutions.push({
      rowNumber,
      row,
      company: {
        action: "create",
        key,
        name,
        industryId: industry.id,
        industryName: industry.name,
      },
      warnings,
      error: null,
    });
  }

  // Pass 2 — contacts, now that every target company is known.
  const targetIds = [
    ...new Set(
      resolutions.flatMap((r) =>
        r.company.action === "existing" || r.company.action === "link"
          ? [r.company.companyId]
          : []
      )
    ),
  ];
  const contactsByCompany = await loadContacts(admin, targetIds);

  const seenEmails = new Set<string>();
  const rows: PlannedRow[] = [];
  let contactsToCreate = 0;
  let contactsToUpdate = 0;

  for (const resolution of resolutions) {
    const { row, company } = resolution;
    const warnings = [...resolution.warnings];
    let error = resolution.error;
    let contact: RowContactPlan = { action: "none" };

    if (!error && company.action !== "skip" && hasContactFields(row)) {
      const email = row.email ?? null;
      if (email && !emailSchema.safeParse(email).success) {
        error = `"${email}" is not a valid email address.`;
      } else {
        const role = parseRole(row.role);
        if (role.warning) warnings.push(role.warning);
        const values: ContactValues = {
          fullName: row.contactPerson ?? null,
          designation: row.designation ?? null,
          roleType: role.roleType,
          email,
          phone: row.phone ?? null,
        };

        const targetKey = company.action === "create" ? company.key : company.companyId;
        const emailKey = email ? `${targetKey}|${email.toLowerCase()}` : null;

        if (emailKey && seenEmails.has(emailKey)) {
          contact = {
            action: "skip",
            reason: "Same email appears earlier in this file — only the first row is applied.",
          };
        } else {
          if (emailKey) seenEmails.add(emailKey);
          const existing =
            company.action === "create" || !email
              ? undefined
              : (contactsByCompany.get(company.companyId) ?? []).find(
                  (c) => (c.email ?? "").toLowerCase() === email.toLowerCase()
                );
          if (existing) {
            contact = {
              action: "update",
              contactId: existing.id,
              values,
              existingName: existing.fullName,
            };
            contactsToUpdate += 1;
          } else {
            if (!email) {
              // Re-uploads match on email; without one this row adds a person
              // every single time it is uploaded.
              warnings.push("No email — a re-upload of this row will add another contact.");
            }
            contact = { action: "create", values };
            contactsToCreate += 1;
          }
        }
      }
    }

    rows.push({
      rowNumber: resolution.rowNumber,
      company: error ? { action: "skip" } : company,
      contact: error ? { action: "none" } : contact,
      warnings,
      error,
    });
  }

  const linkedIds = new Set(
    rows.flatMap((r) => (r.company.action === "link" ? [r.company.companyId] : []))
  );
  const rowsWithErrors = rows.filter((r) => r.error !== null).length;
  if (rowsWithErrors > 0) {
    fileWarnings.push(`${rowsWithErrors} row(s) will be skipped — fix them and re-upload.`);
  }

  return {
    counts: {
      rows: rows.length,
      companiesToCreate: planned.size,
      companiesLinked: linkedIds.size,
      contactsToCreate,
      contactsToUpdate,
      rowsWithErrors,
    },
    companies: [...planned.values()],
    rows,
    errors: [],
    warnings: fileWarnings,
  };
}

// ── apply ───────────────────────────────────────────────────────────────────

export interface ImportResult {
  companiesCreated: number;
  companiesLinked: number;
  contactsCreated: number;
  contactsUpdated: number;
  rowsSkipped: number;
  errors: string[];
  /** Sheet refresh is best-effort — a failure here never fails the import. */
  sheetSyncWarning: string | null;
}

/**
 * A contact typed by a human can never claim `verified` — that status belongs
 * to enrichment APIs alone (PRD §6.1 guardrail, CLAUDE.md). The return type has
 * no `verified` arm, so it is literally unreachable from this file.
 */
function manualChannelStatus(value: string | null): Exclude<ContactChannelStatus, "verified"> {
  return value === null ? "unknown" : "public_generic";
}

function orNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The row that won a 23505 race, found on the same keys the index enforces. */
async function findByUniqueKeys(
  admin: AdminClient,
  domain: string | null,
  instagram: string | null
): Promise<string | null> {
  const keys: Array<[string, string]> = [];
  if (domain) keys.push(["domain_normalized", domain]);
  if (instagram) keys.push(["instagram_handle_normalized", instagram]);
  for (const [column, value] of keys) {
    const { data } = await admin.from("companies").select("id").eq(column, value).limit(1);
    const hit = (data ?? [])[0] as { id: string } | undefined;
    if (hit) return hit.id;
  }
  return null;
}

export async function applyImport(plan: ImportPlan, userId: string): Promise<ImportResult> {
  const admin = createAdminClient();
  const errors: string[] = [];
  const touchedIndustries = new Set<string>();
  const keyToCompanyId = new Map<string, string>();
  let companiesCreated = 0;
  let companiesLinked = 0;

  for (const company of plan.companies) {
    const { data: created, error } = await admin
      .from("companies")
      .insert({
        industry_id: company.industryId,
        name: company.name,
        domain: company.domain,
        instagram_handle: company.instagramHandle,
        city: company.city,
        revenue_estimate: company.revenueEstimate,
        funding_stage: company.fundingStage,
        shark_tank_status: company.sharkTankStatus,
        // A human-added company may be approved with no sources: the "no
        // sources, no approval" rule exists to stop the AI inventing companies,
        // not to stop the team adding ones they know (CLAUDE.md).
        sources: [],
        status: "draft",
        owner_id: userId,
      })
      .select("id")
      .single();

    if (error || !created) {
      // 23505 = a teammate (or a concurrent run) saved this company between the
      // preview and now. Same handling as createCompany, minus the abort: the
      // contacts join the winning row instead of being lost.
      if (error?.code === "23505") {
        const existingId = await findByUniqueKeys(admin, company.domain, company.instagramHandle);
        if (existingId) {
          keyToCompanyId.set(company.key, existingId);
          companiesLinked += 1;
          touchedIndustries.add(company.industryId);
          continue;
        }
      }
      errors.push(
        `Row ${company.rowNumbers[0] ?? "?"}: could not create "${company.name}" — ${
          error?.message ?? "no row returned"
        }`
      );
      continue;
    }

    const companyId = created.id as string;
    keyToCompanyId.set(company.key, companyId);
    companiesCreated += 1;
    touchedIndustries.add(company.industryId);

    await logAudit(admin, {
      userId,
      action: "company.import_create",
      entity: "company",
      entityId: companyId,
      after: {
        name: company.name,
        industry_id: company.industryId,
        domain: company.domain,
        instagram_handle: company.instagramHandle,
        status: "draft",
        rows: company.rowNumbers,
      },
    });
  }

  const resolveCompanyId = (row: PlannedRow): string | null => {
    switch (row.company.action) {
      case "existing":
      case "link":
        return row.company.companyId;
      case "create":
        return keyToCompanyId.get(row.company.key) ?? null;
      case "skip":
        return null;
    }
  };

  for (const row of plan.rows) {
    if (row.company.action === "existing" || row.company.action === "link") {
      touchedIndustries.add(row.company.industryId);
    }
  }

  // Which companies already have a primary contact — read now, not at plan
  // time, so a teammate's edit in between is respected.
  const contactTargets = [
    ...new Set(plan.rows.map(resolveCompanyId).filter((id): id is string => id !== null)),
  ];
  const hasPrimary = new Set<string>();
  if (contactTargets.length > 0) {
    const { data } = await admin
      .from("contacts")
      .select("company_id")
      .eq("is_primary", true)
      .in("company_id", contactTargets);
    for (const entry of (data ?? []) as Array<{ company_id: string }>) {
      hasPrimary.add(entry.company_id);
    }
  }

  let contactsCreated = 0;
  let contactsUpdated = 0;
  let rowsSkipped = 0;

  for (const row of plan.rows) {
    if (row.error !== null || row.contact.action === "none" || row.contact.action === "skip") {
      if (row.error !== null || row.contact.action === "skip") rowsSkipped += 1;
      continue;
    }
    const companyId = resolveCompanyId(row);
    if (!companyId) {
      rowsSkipped += 1; // its company failed to insert; the error is already recorded
      continue;
    }

    const values = row.contact.values;
    const email = orNull(values.email);
    const phone = orNull(values.phone);
    // First founder wins the primary slot, and only when nobody holds it.
    const takePrimary = values.roleType === "founder" && !hasPrimary.has(companyId);
    const fields = {
      full_name: orNull(values.fullName),
      designation: orNull(values.designation),
      role_type: values.roleType,
      email,
      email_status: manualChannelStatus(email),
      phone,
      phone_status: manualChannelStatus(phone),
    };

    if (row.contact.action === "update") {
      const { data: updated, error } = await admin
        .from("contacts")
        .update(takePrimary ? { ...fields, is_primary: true } : fields)
        .eq("id", row.contact.contactId)
        .select("id")
        .maybeSingle();
      if (error || !updated) {
        errors.push(`Row ${row.rowNumber}: could not update contact — ${error?.message ?? "not found"}`);
        rowsSkipped += 1;
        continue;
      }
      if (takePrimary) hasPrimary.add(companyId);
      contactsUpdated += 1;
      await logAudit(admin, {
        userId,
        action: "contact.import_update",
        entity: "contact",
        entityId: row.contact.contactId,
        before: { full_name: row.contact.existingName },
        after: { ...fields, company_id: companyId, row: row.rowNumber },
      });
      continue;
    }

    const insertRow = {
      company_id: companyId,
      ...fields,
      source: "manual" as const,
      is_primary: takePrimary,
    };
    let { data: created, error } = await admin
      .from("contacts")
      .insert(insertRow)
      .select("id")
      .single();

    // contacts_one_primary_per_company is a unique partial index; if someone
    // claimed the slot since the read above, keep the contact and drop the flag.
    if (error?.code === "23505" && takePrimary) {
      hasPrimary.add(companyId);
      ({ data: created, error } = await admin
        .from("contacts")
        .insert({ ...insertRow, is_primary: false })
        .select("id")
        .single());
    }

    if (error || !created) {
      errors.push(
        `Row ${row.rowNumber}: could not add contact — ${error?.message ?? "no row returned"}`
      );
      rowsSkipped += 1;
      continue;
    }
    if (takePrimary) hasPrimary.add(companyId);
    contactsCreated += 1;
    await logAudit(admin, {
      userId,
      action: "contact.import_create",
      entity: "contact",
      entityId: created.id as string,
      after: { ...fields, company_id: companyId, row: row.rowNumber },
    });
  }

  let sheetSyncWarning: string | null = null;
  if (!isSheetsConfigured()) {
    sheetSyncWarning = "Sheets sync not configured — the sheet was not refreshed.";
  } else {
    const failed: string[] = [];
    for (const industryId of touchedIndustries) {
      try {
        const result = await syncIndustry(industryId);
        if (!result.ok) failed.push(result.error ?? "unknown error");
      } catch (e) {
        failed.push(e instanceof Error ? e.message : "unknown error");
      }
    }
    if (failed.length > 0) {
      sheetSyncWarning = `Import saved, but the sheet refresh failed: ${failed[0]}`;
    }
  }

  return {
    companiesCreated,
    companiesLinked,
    contactsCreated,
    contactsUpdated,
    rowsSkipped,
    errors,
    sheetSyncWarning,
  };
}

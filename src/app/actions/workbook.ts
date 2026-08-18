"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  isSheetsConfigured,
  pullContactsFromSheet,
  type PullResult,
} from "@/lib/sheets";
import {
  applyImport,
  parseWorkbook,
  planImport,
  type ImportCounts,
  type ImportPlan,
  type ImportResult,
  type PlannedRow,
} from "@/lib/workbook/import";
import type { WorkbookRow } from "@/lib/workbook/columns";
import type { ActionResult } from "@/app/actions/companies";

// Upload half of the manual enrichment loop (CLAUDE.md, 18 Aug 2026).
//
// Two round trips on purpose: previewUpload never writes, confirmUpload writes
// what the preview described. One upload can create companies and rewrite
// contacts across a whole industry, and the only real defence against a
// mis-filled column is showing a person the outcome first.

/** exceljs cannot read the old binary .xls, and a CSV loses the text columns. */
const ACCEPTED_EXTENSION = ".xlsx";

/**
 * Mirrors Next's default server-action body cap (1 MB). A filled workbook is
 * far smaller — a few hundred KB at a few thousand rows — and refusing an
 * oversized one with a sentence beats the framework's opaque 413. Raising this
 * alone does nothing; `serverActions.bodySizeLimit` in next.config.ts has to
 * move with it.
 */
const MAX_UPLOAD_BYTES = 1_000_000;

/**
 * Preview rows shown before the fold. A 5000-row plan serialised whole is
 * megabytes of JSON crossing the wire for nothing: the client cannot be trusted
 * with a plan anyway (confirm re-plans from the bytes), so only what a person
 * has to act on is sent.
 */
const MAX_ISSUES_SHOWN = 100;

// ── shapes the screen renders ───────────────────────────────────────────────

export interface UploadIssue {
  /** 1-based worksheet row, so the message points at the file they are looking at. */
  rowNumber: number;
  /** Which company the row is about, for finding it without scrolling to the row. */
  company: string;
  /** Non-null means the row will be skipped. */
  error: string | null;
  warnings: string[];
}

export interface NewCompanyPreview {
  name: string;
  industryName: string;
  rows: number[];
}

export interface UploadPreview {
  fileName: string;
  /** Ties a Confirm back to the exact bytes that were previewed. */
  fingerprint: string;
  counts: ImportCounts;
  warnings: string[];
  newCompanies: NewCompanyPreview[];
  issues: UploadIssue[];
  /** Issues past the cap — counted, never silently dropped. */
  moreIssues: number;
}

export type UploadSummary = ImportResult;

// ── shared upload handling ──────────────────────────────────────────────────

interface UploadBytes {
  fileName: string;
  buffer: Buffer;
  fingerprint: string;
}

async function readUpload(
  formData: FormData
): Promise<ActionResult<UploadBytes>> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose the filled-in workbook first." };
  }
  if (!file.name.toLowerCase().endsWith(ACCEPTED_EXTENSION)) {
    return {
      ok: false,
      error: `"${file.name}" is not an Excel workbook. Open it and use File → Save As → Excel Workbook (.xlsx), then upload that.`,
    };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `"${file.name}" is ${Math.round(
        file.size / 1000
      )} KB, over the ${Math.round(
        MAX_UPLOAD_BYTES / 1000
      )} KB upload limit. Split it into two files and upload them one after the other.`,
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return {
    ok: true,
    data: {
      fileName: file.name,
      buffer,
      fingerprint: createHash("sha256").update(buffer).digest("hex"),
    },
  };
}

/** Parse + plan, with the file-level failures turned into one readable line. */
async function parseAndPlan(
  buffer: Buffer,
  userId: string,
  isAdmin: boolean
): Promise<ActionResult<{ rows: WorkbookRow[]; plan: ImportPlan }>> {
  const parsed = await parseWorkbook(buffer);
  if (parsed.errors.length > 0) {
    return { ok: false, error: parsed.errors.join(" ") };
  }
  if (parsed.rows.length === 0) {
    return {
      ok: false,
      error:
        "There are no rows under the header in this workbook — nothing to import.",
    };
  }

  const plan = await planImport({ rows: parsed.rows, userId, isAdmin });
  if (plan.errors.length > 0) {
    return { ok: false, error: plan.errors.join(" ") };
  }
  return { ok: true, data: { rows: parsed.rows, plan } };
}

/** The company a row is about — the plan knows it unless the row failed to resolve. */
function rowLabel(planned: PlannedRow, raw: WorkbookRow | undefined): string {
  if (planned.company.action !== "skip") return planned.company.name;
  return raw?.company?.trim() || "(no company name in this row)";
}

function toPreview(
  upload: UploadBytes,
  rows: WorkbookRow[],
  plan: ImportPlan
): UploadPreview {
  const noteworthy = plan.rows.filter(
    (row) => row.error !== null || row.warnings.length > 0
  );
  return {
    fileName: upload.fileName,
    fingerprint: upload.fingerprint,
    counts: plan.counts,
    warnings: plan.warnings,
    newCompanies: plan.companies.map((company) => ({
      name: company.name,
      industryName: company.industryName,
      rows: company.rowNumbers,
    })),
    issues: noteworthy.slice(0, MAX_ISSUES_SHOWN).map((row) => ({
      rowNumber: row.rowNumber,
      // rows[i] is worksheet row i + 2, which is what planImport reports.
      company: rowLabel(row, rows[row.rowNumber - 2]),
      error: row.error,
      warnings: row.warnings,
    })),
    moreIssues: Math.max(0, noteworthy.length - MAX_ISSUES_SHOWN),
  };
}

// ── actions ─────────────────────────────────────────────────────────────────

/** Reads the uploaded workbook and reports what an import WOULD do. Writes nothing. */
export async function previewUpload(
  formData: FormData
): Promise<ActionResult<UploadPreview>> {
  const user = await requireAppUser();

  const upload = await readUpload(formData);
  if (!upload.ok) return upload;

  const planned = await parseAndPlan(
    upload.data.buffer,
    user.id,
    user.role === "admin"
  );
  if (!planned.ok) return planned;

  return {
    ok: true,
    data: toPreview(upload.data, planned.data.rows, planned.data.plan),
  };
}

/**
 * Applies what the preview showed.
 *
 * A server action holds nothing between calls, so the plan cannot simply be
 * kept from previewUpload — and it must NOT be posted back by the browser
 * either: applyImport deliberately trusts its plan (it re-checks unique-index
 * races, not permissions), so a client that edited the plan JSON could write
 * companies and contacts into industries the preview never showed. The file is
 * therefore re-uploaded and re-planned here, server-side, in this request.
 *
 * The fingerprint is what makes that honest: it proves the bytes being applied
 * are the bytes the person looked at, not a second file swapped in after the
 * preview.
 */
export async function confirmUpload(
  formData: FormData
): Promise<ActionResult<UploadSummary>> {
  const user = await requireAppUser();

  const upload = await readUpload(formData);
  if (!upload.ok) return upload;

  const previewed = formData.get("fingerprint");
  if (typeof previewed !== "string" || previewed !== upload.data.fingerprint) {
    return {
      ok: false,
      error:
        "This is not the file you previewed. Preview it again so you can see what will change.",
    };
  }

  const planned = await parseAndPlan(
    upload.data.buffer,
    user.id,
    user.role === "admin"
  );
  if (!planned.ok) return planned;

  const result = await applyImport(planned.data.plan, user.id);

  const supabase = await createClient();
  await logAudit(supabase, {
    userId: user.id,
    action: "workbook.import",
    entity: "workbook",
    after: {
      file: upload.data.fileName,
      fingerprint: upload.data.fingerprint,
      ...result,
    },
  });

  revalidatePath("/");
  revalidatePath("/today");
  revalidatePath("/pipeline");
  revalidatePath("/enrich");
  revalidatePath("/dashboard");

  const parts: string[] = [];
  if (result.companiesCreated > 0) {
    parts.push(`${result.companiesCreated} new compan${result.companiesCreated === 1 ? "y" : "ies"}`);
  }
  if (result.contactsCreated > 0) {
    parts.push(`${result.contactsCreated} contact${result.contactsCreated === 1 ? "" : "s"} added`);
  }
  if (result.contactsUpdated > 0) {
    parts.push(`${result.contactsUpdated} contact${result.contactsUpdated === 1 ? "" : "s"} updated`);
  }

  return {
    ok: true,
    data: result,
    message:
      parts.length > 0
        ? `Imported: ${parts.join(", ")}.`
        : "Nothing changed — every row was already up to date.",
  };
}

/**
 * Reads contact columns typed straight into the Google Sheet back into the DB.
 * Admin-only because it touches every industry's tab at once, not just the
 * caller's allotment.
 */
export async function pullSheetContacts(): Promise<ActionResult<PullResult>> {
  const user = await requireAppUser();
  if (user.role !== "admin") {
    return { ok: false, error: "Only admins can pull the whole sheet." };
  }
  if (!isSheetsConfigured()) {
    return {
      ok: false,
      error:
        "Sheets sync not configured — add GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 and GOOGLE_SHEET_ID first.",
    };
  }

  const result = await pullContactsFromSheet();
  if (!result.ok) {
    return { ok: false, error: result.error ?? "Sheet pull failed." };
  }

  // pullContactsFromSheet logs its own run with user_id null (it also runs from
  // cron); this second row is the "who pressed the button" half.
  const supabase = await createClient();
  await logAudit(supabase, {
    userId: user.id,
    action: "sheets.pull_manual",
    entity: "sheet",
    after: {
      scanned: result.scanned,
      created: result.created,
      updated: result.updated,
      unmatched: result.unmatched.length,
    },
  });

  revalidatePath("/");
  revalidatePath("/today");
  revalidatePath("/pipeline");
  revalidatePath("/enrich");

  const unmatched =
    result.unmatched.length > 0
      ? ` ${result.unmatched.length} row${result.unmatched.length === 1 ? "" : "s"} could not be matched to a company.`
      : "";
  return {
    ok: true,
    data: result,
    message: `Read ${result.scanned} sheet row${result.scanned === 1 ? "" : "s"}: ${result.created} contact${result.created === 1 ? "" : "s"} added, ${result.updated} updated.${unmatched}`,
  };
}

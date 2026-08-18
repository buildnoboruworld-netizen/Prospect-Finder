// The single column contract for the enrichment workbook.
//
// Export and import both read this file, so a column can never mean one thing
// on the way out and another on the way back. Row shape deliberately matches
// the Google Sheet (PRD §9): ONE ROW PER CONTACT, company fields repeated —
// the team already reads that layout, and it is what lets a person add a
// second founder by duplicating a row.

export type ColumnKey =
  | "companyId"
  | "industryCode"
  | "industry"
  | "company"
  | "contactPerson"
  | "designation"
  | "role"
  | "email"
  | "phone"
  | "website"
  | "instagram"
  | "city"
  | "revenueEstimate"
  | "fundingStage"
  | "sharkTank"
  | "fit"
  | "digitalPresence"
  | "hook"
  | "confidence"
  | "owner"
  | "status"
  | "sources";

export interface ColumnSpec {
  key: ColumnKey;
  /** Header text written to, and matched from, the file. */
  header: string;
  width: number;
  /** The team fills these in; everything else is reference data. */
  editable: boolean;
  /**
   * Forced to text in the workbook. Without this Excel turns +919876543210
   * into 9.19877E+11 and silently destroys the phone number — the single most
   * likely way this whole workflow corrupts data.
   */
  text?: boolean;
  note?: string;
}

export const COLUMNS: readonly ColumnSpec[] = [
  {
    key: "companyId",
    header: "Company ID",
    width: 38,
    editable: false,
    text: true,
    note: "Leave BLANK to create a new company. Do not edit or delete this column.",
  },
  {
    key: "industryCode",
    header: "Industry Code",
    width: 14,
    editable: true,
    text: true,
    note: "Required for new companies (e.g. ML, PF, HS). Ignored for existing rows.",
  },
  { key: "industry", header: "Industry", width: 26, editable: false },
  { key: "company", header: "Company", width: 30, editable: true },
  { key: "contactPerson", header: "Contact Person", width: 24, editable: true },
  { key: "designation", header: "Designation", width: 24, editable: true },
  {
    key: "role",
    header: "Role",
    width: 12,
    editable: true,
    note: "founder | marketing | other. Blank defaults to other.",
  },
  { key: "email", header: "Email", width: 32, editable: true },
  {
    key: "phone",
    header: "Phone",
    width: 20,
    editable: true,
    text: true,
    note: "Kept as text so leading + and zeros survive.",
  },
  { key: "website", header: "Website", width: 28, editable: true },
  { key: "instagram", header: "Instagram", width: 22, editable: true },
  { key: "city", header: "City", width: 18, editable: true },
  // Two columns, not the Sheet's single "Revenue/Stage". The Sheet joins them
  // for reading; the workbook must not, because it round-trips: joining on the
  // way out and splitting on the way back needs a separator that never appears
  // in real data, and "₹87 lakh FY23-24 · seed" re-imported as one string
  // silently destroys funding_stage.
  { key: "revenueEstimate", header: "Revenue Estimate", width: 22, editable: true },
  { key: "fundingStage", header: "Funding Stage", width: 18, editable: true },
  { key: "sharkTank", header: "Shark Tank", width: 18, editable: true },
  { key: "fit", header: "Fit", width: 8, editable: false },
  { key: "digitalPresence", header: "Digital Presence", width: 18, editable: false },
  { key: "hook", header: "Hook", width: 60, editable: false },
  { key: "confidence", header: "Confidence", width: 12, editable: false },
  { key: "owner", header: "Owner", width: 20, editable: false },
  { key: "status", header: "Status", width: 12, editable: false },
  { key: "sources", header: "Sources", width: 50, editable: false },
] as const;

export const HEADERS: readonly string[] = COLUMNS.map((c) => c.header);

/** Contact columns — the ones enrichment actually fills. */
export const CONTACT_KEYS: readonly ColumnKey[] = [
  "contactPerson",
  "designation",
  "role",
  "email",
  "phone",
] as const;

/**
 * Header → key, matched case- and space-insensitively. People reorder columns,
 * change capitalisation, and paste through Google Sheets; none of that should
 * break an import, so position is never trusted — only the header text.
 */
export function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

const HEADER_TO_KEY = new Map<string, ColumnKey>(
  COLUMNS.map((c) => [normalizeHeader(c.header), c.key])
);

export function keyForHeader(raw: string): ColumnKey | null {
  return HEADER_TO_KEY.get(normalizeHeader(raw)) ?? null;
}

/** A parsed row, before any validation. Every field is raw text. */
export type WorkbookRow = Partial<Record<ColumnKey, string>>;

export const SHEET_NAME = "Leads";
export const INSTRUCTIONS_SHEET_NAME = "How to use";

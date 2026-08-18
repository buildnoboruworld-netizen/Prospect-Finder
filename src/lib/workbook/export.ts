import "server-only";

// Export side of the manual enrichment loop (CLAUDE.md, 18 Aug 2026): the team
// downloads a workbook, looks people up in RocketReach by hand, and uploads it
// back. Order, header text, widths and which columns are typed into all come
// from columns.ts, so the file that leaves here and the parser that reads it
// back can never disagree about what a column means.

import ExcelJS from "exceljs";
import type { FillPattern, Workbook } from "exceljs";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  COLUMNS,
  CONTACT_KEYS,
  INSTRUCTIONS_SHEET_NAME,
  SHEET_NAME,
  type WorkbookRow,
} from "@/lib/workbook/columns";
import type { Company, Contact } from "@/lib/types";

/**
 * Excel's "Text" number format. Applied at COLUMN level, not just to the cells
 * we write: the team types into blank Phone cells after opening the file, and
 * without a column format Excel silently turns +919876543210 into 9.19877E+11.
 */
const TEXT_FORMAT = "@";

// Brand lime marks the columns the team fills in; grey marks reference data.
// Header text stays near-black on both — white on lime fails contrast.
const FILL_EDITABLE_HEADER = "FF8CD056";
const FILL_REFERENCE_HEADER = "FFD6D3D1";
const FILL_REFERENCE_CELL = "FFF5F5F4";

const INSTRUCTIONS_MERGE_TO_COLUMN = 6;
// Merged cells never auto-fit their height in Excel, so wrapped paragraphs have
// to be measured. ~135 characters fit across the merged span at these widths.
const INSTRUCTIONS_CHARS_PER_LINE = 135;
const INSTRUCTIONS_LINE_HEIGHT = 15;

function solidFill(argb: string): FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

type CompanyWithJoins = Company & {
  contacts: Contact[];
  owner: { name: string | null; email: string } | null;
  industry: { name: string; code: string | null } | null;
};

interface IndustryCode {
  code: string;
  name: string;
}

// Written as empty strings rather than left absent, so a company with nobody
// attached still occupies a full-width row. That blank row IS the instruction:
// this company is waiting for a person.
const BLANK_CONTACT: WorkbookRow = {};
for (const key of CONTACT_KEYS) BLANK_CONTACT[key] = "";

function companyFields(c: CompanyWithJoins): WorkbookRow {
  return {
    companyId: c.id,
    // Filled even though the importer ignores it on rows that already have a
    // Company ID — it gives the team the exact code to copy down when they
    // append a new company at the bottom.
    industryCode: c.industry?.code ?? "",
    industry: c.industry?.name ?? "",
    company: c.name,
    website: c.domain ?? "",
    instagram: c.instagram_handle_normalized
      ? `@${c.instagram_handle_normalized}`
      : "",
    city: c.city ?? "",
    revenueEstimate: c.revenue_estimate ?? "",
    fundingStage: c.funding_stage ?? "",
    sharkTank: c.shark_tank_status ?? "",
    fit: c.fit_score?.toString() ?? "",
    digitalPresence: c.digital_presence ?? "",
    hook: c.hook ?? "",
    confidence: c.confidence ?? "",
    owner: c.owner?.name ?? c.owner?.email ?? "",
    status: c.status,
    sources: (c.sources ?? []).map((s) => s.url).join("\n"),
  };
}

function contactFields(contact: Contact): WorkbookRow {
  return {
    contactPerson: contact.full_name ?? "",
    designation: contact.designation ?? "",
    role: contact.role_type,
    email: contact.email ?? "",
    phone: contact.phone ?? "",
  };
}

function companyRows(c: CompanyWithJoins): WorkbookRow[] {
  const base = companyFields(c);
  // Same order the team already reads on the Sheet: primary first, then oldest.
  const contacts = [...(c.contacts ?? [])].sort(
    (a, b) =>
      Number(b.is_primary) - Number(a.is_primary) ||
      a.created_at.localeCompare(b.created_at)
  );
  if (contacts.length === 0) return [{ ...base, ...BLANK_CONTACT }];
  return contacts.map((contact) => ({ ...base, ...contactFields(contact) }));
}

function addLeadsSheet(workbook: Workbook, rows: readonly WorkbookRow[]): void {
  const sheet = workbook.addWorksheet(SHEET_NAME, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = COLUMNS.map((spec) => ({
    key: spec.key,
    header: spec.header,
    width: spec.width,
    style: spec.text ? { numFmt: TEXT_FORMAT } : undefined,
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 24;
  COLUMNS.forEach((spec, index) => {
    header.getCell(index + 1).fill = solidFill(
      spec.editable ? FILL_EDITABLE_HEADER : FILL_REFERENCE_HEADER
    );
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: COLUMNS.length },
  };

  const roleColumn = COLUMNS.findIndex((spec) => spec.key === "role") + 1;

  for (const row of rows) {
    const added = sheet.addRow(row);
    // Shading every reference cell (not just its header) is what makes the
    // white gaps read as "type here" at a glance, three screens down.
    COLUMNS.forEach((spec, index) => {
      if (!spec.editable) {
        added.getCell(index + 1).fill = solidFill(FILL_REFERENCE_CELL);
      }
    });
    if (roleColumn > 0) {
      added.getCell(roleColumn).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"founder,marketing,other"'],
        showErrorMessage: true,
        errorTitle: "Pick a role",
        error: "Role must be founder, marketing or other (or left blank).",
      };
    }
  }
}

interface Instruction {
  heading: string;
  body: string;
}

// Written for a teammate who has never seen the database. Every rule here is a
// way this workflow has a real chance of losing data.
const INSTRUCTIONS: readonly Instruction[] = [
  {
    heading: "Leave the Company ID column alone",
    body:
      "Company ID is the only thing that tells us which company a row belongs to. Do not type in it, do not clear it, do not delete or hide the column. If a Company ID goes missing we will create a second copy of that company instead of updating the one you already have.",
  },
  {
    heading: "A blank Company ID means a brand-new company",
    body:
      "If you know a company the tool never found, add it as a new row at the bottom, leave Company ID empty, and fill in the Industry Code (the list is at the end of this page) along with the company name. A new row without an Industry Code cannot be saved, because nothing tells us which industry it belongs to.",
  },
  {
    heading: "One row is one person",
    body:
      "To add a second person at the same company, copy the whole row, paste it directly underneath, and change only the five contact columns: Contact Person, Designation, Role, Email, Phone. Leave the Company ID exactly as it is — that is what keeps both people attached to the same company.",
  },
  {
    heading: "A row with blank contact columns is a company still waiting for a person",
    body:
      "Fill that row in rather than adding a new one underneath it. The company is already in the system; it just has nobody attached yet.",
  },
  {
    heading: "Role is one of three words",
    body:
      "founder, marketing, or other. Nothing else. Leave it blank and we will record it as other.",
  },
  {
    heading: "Green headings are yours; grey ones are reference",
    body:
      "The white cells under the green headings are what we read back. The shaded columns are research output shown so you know who you are looking at — anything typed into them is ignored, so there is no point correcting them here.",
  },
  {
    heading: "Do not rename or delete columns",
    body:
      "We find each column by the exact words in its heading, never by its position, so you are free to drag columns around if that helps you work. But rename \"Contact Person\" to \"Name\" and that column stops existing as far as the upload is concerned, and everything in it is lost.",
  },
  {
    heading: "Phone numbers have to stay text",
    body:
      "Company ID and Phone are formatted as text on purpose. If Excel ever shows a phone number as something like 9.19877E+11, the real number is already gone — press Ctrl+Z and paste it again as text. Keep the leading + and any leading zeros.",
  },
  {
    heading: "Re-uploading a corrected file updates, it does not duplicate",
    body:
      "Upload a fixed copy of the same file as often as you need to. Inside each company we match people by email address: the same email updates that person, a new email adds one. Fix a typo in a phone number, upload again, and nothing is duplicated. A person with no email cannot be matched, so add an email wherever you can.",
  },
  {
    heading: "You can upload for your own industries",
    body:
      "Uploads are accepted for the industries allotted to you; admins can upload for any industry. If a row is rejected for the wrong industry, that company belongs to a teammate's list.",
  },
];

function addInstructionsSheet(
  workbook: Workbook,
  codes: readonly IndustryCode[]
): void {
  const sheet = workbook.addWorksheet(INSTRUCTIONS_SHEET_NAME);
  sheet.columns = [
    { width: 16 },
    { width: 46 },
    { width: 20 },
    { width: 20 },
    { width: 18 },
    { width: 15 },
  ];

  let rowNumber = 0;

  const skip = (): void => {
    rowNumber += 1;
  };

  const paragraph = (text: string, bold: boolean, size: number): void => {
    rowNumber += 1;
    sheet.mergeCells(rowNumber, 1, rowNumber, INSTRUCTIONS_MERGE_TO_COLUMN);
    const row = sheet.getRow(rowNumber);
    const cell = row.getCell(1);
    cell.value = text;
    cell.font = { bold, size };
    cell.alignment = { vertical: "top", wrapText: true };
    row.height =
      Math.max(1, Math.ceil(text.length / INSTRUCTIONS_CHARS_PER_LINE)) *
      INSTRUCTIONS_LINE_HEIGHT;
  };

  paragraph("How to fill in this workbook", true, 16);
  paragraph(
    `The "${SHEET_NAME}" tab is the one we read back. Two minutes here saves an afternoon of untangling.`,
    false,
    11
  );
  skip();

  for (const instruction of INSTRUCTIONS) {
    paragraph(instruction.heading, true, 12);
    paragraph(instruction.body, false, 11);
    skip();
  }

  paragraph("Industry codes", true, 14);
  paragraph(
    "Put one of these in the Industry Code column when you add a brand-new company. The code is what tells us which industry that company belongs to.",
    false,
    11
  );
  skip();

  rowNumber += 1;
  const tableHeader = sheet.getRow(rowNumber);
  tableHeader.getCell(1).value = "Code";
  tableHeader.getCell(2).value = "Industry";
  tableHeader.font = { bold: true };
  tableHeader.getCell(1).fill = solidFill(FILL_EDITABLE_HEADER);
  tableHeader.getCell(2).fill = solidFill(FILL_EDITABLE_HEADER);

  for (const industry of codes) {
    rowNumber += 1;
    const row = sheet.getRow(rowNumber);
    // Codes are text: a hypothetical all-digit code must not become a number.
    const codeCell = row.getCell(1);
    codeCell.value = industry.code;
    codeCell.numFmt = TEXT_FORMAT;
    row.getCell(2).value = industry.name;
  }
}

async function fetchIndustryCodes(): Promise<IndustryCode[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("industries")
    .select("code, name")
    .not("code", "is", null)
    .order("code");
  if (error) {
    throw new Error(`Failed to load industry codes: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{ code: string | null; name: string }>;
  return rows.filter((row): row is IndustryCode => row.code !== null);
}

async function buildWorkbook(rows: readonly WorkbookRow[]): Promise<Buffer> {
  const codes = await fetchIndustryCodes();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Noboru Prospector";
  workbook.created = new Date();

  addLeadsSheet(workbook, rows);
  addInstructionsSheet(workbook, codes);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * Every company in the industry that has not been rejected, one row per
 * contact, plus one blank-contact row for companies with nobody attached yet.
 *
 * Sample companies are excluded: they are fabricated demo rows (they can never
 * leave draft, see migration 20260811120001), and sending them out would burn
 * hand-bought RocketReach lookups on brands that do not exist.
 */
export async function buildEnrichmentWorkbook(
  industryId: string
): Promise<Buffer> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("companies")
    .select("*, contacts(*), owner:users(name, email), industry:industries(name, code)")
    .eq("industry_id", industryId)
    .eq("is_sample", false)
    .neq("status", "rejected")
    .order("name");
  if (error) {
    throw new Error(`Failed to load companies for export: ${error.message}`);
  }

  const companies = (data ?? []) as unknown as CompanyWithJoins[];
  return buildWorkbook(companies.flatMap(companyRows));
}

/** Headers only — for companies the tool never found, typed in from scratch. */
export async function buildBlankTemplate(): Promise<Buffer> {
  return buildWorkbook([]);
}

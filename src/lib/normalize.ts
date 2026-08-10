// Client-side mirror of the SQL normalizers in
// supabase/migrations/20260811090001_extensions_types_helpers.sql.
// Keep both in sync — the DB generated columns are the source of truth.

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const out = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
  return out === "" ? null : out;
}

export function normalizeIgHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const out = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/\s/g, "");
  return out === "" ? null : out;
}

export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const out = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out === "" ? null : out;
}

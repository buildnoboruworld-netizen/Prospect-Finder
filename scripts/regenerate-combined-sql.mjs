// Regenerates scripts/apply-all-migrations.generated.sql from
// supabase/migrations/*.sql (filename order). UTF-8-safe — always use this,
// never a PowerShell pipeline (PS 5.1 reads BOM-less UTF-8 as ANSI and once
// shipped mojibake industry names to the live DB).
// Run from repo root: node scripts/regenerate-combined-sql.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = "supabase/migrations";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const combined =
  "-- GENERATED from supabase/migrations (do not edit — regenerate with scripts/regenerate-combined-sql.mjs)\n" +
  `-- Run once in the Supabase SQL editor. Order: ${files.join(", ")}\n\n` +
  files
    .map((f) => `-- ═══ ${f} ═══\n` + readFileSync(join(dir, f), "utf8"))
    .join("\n\n");

writeFileSync("scripts/apply-all-migrations.generated.sql", combined);
console.log(`combined ${files.length} migrations (${(combined.length / 1024).toFixed(1)} KB)`);

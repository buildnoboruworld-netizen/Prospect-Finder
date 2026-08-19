// Applies per-industry fit criteria from scripts/icp-criteria.json to the
// live industries.icp_config. Node on purpose — CLAUDE.md: PS 5.1 once
// shipped mojibake to this DB, and these strings are full of ₹ and em-dashes.
//
// Merge rules (deliberately conservative):
//   replace  revenue_band, follower_band, fit_criteria
//   union    exclusions, seed_queries (existing kept, upgrades appended)
//   keep     ticket_context, notes
//
// Run from repo root:  node scripts/apply-icp-criteria.mjs
// Add --dry to print the would-be changes without writing.

import { readFileSync } from "node:fs";

const dry = process.argv.includes("--dry");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) throw new Error("Supabase env missing from .env.local");

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

const criteria = JSON.parse(readFileSync("scripts/icp-criteria.json", "utf8"));

const res = await fetch(`${URL}/rest/v1/industries?select=id,slug,name,icp_config`, { headers });
if (!res.ok) throw new Error(`fetch industries: ${res.status}`);
const industries = await res.json();
const bySlug = new Map(industries.map((i) => [i.slug, i]));

const unionCI = (base, add) => {
  const seen = new Set(base.map((s) => s.trim().toLowerCase()));
  const out = [...base];
  for (const s of add ?? []) {
    const k = s.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(s.trim());
    }
  }
  return out;
};

let applied = 0;
for (const c of criteria.industries) {
  const row = bySlug.get(c.slug);
  if (!row) {
    console.log(`SKIP ${c.slug}: no such industry`);
    continue;
  }
  const cfg = row.icp_config ?? {};
  const next = {
    ...cfg,
    revenue_band: c.revenue_band,
    follower_band: c.follower_band,
    fit_criteria: c.scoring_notes,
    exclusions: unionCI(cfg.exclusions ?? [], c.exclusions_add),
    seed_queries: unionCI(cfg.seed_queries ?? [], c.seed_query_upgrades),
  };

  console.log(`${dry ? "DRY " : ""}${c.slug}`);
  console.log(`  revenue: ${cfg.revenue_band ?? "-"}  ->  ${next.revenue_band}`);
  console.log(`  follower: ${cfg.follower_band ?? "-"}  ->  ${next.follower_band}`);
  console.log(
    `  exclusions: ${cfg.exclusions?.length ?? 0} -> ${next.exclusions.length}, queries: ${cfg.seed_queries?.length ?? 0} -> ${next.seed_queries.length}, fit_criteria: ${next.fit_criteria.length} chars`
  );

  if (!dry) {
    const patch = await fetch(`${URL}/rest/v1/industries?id=eq.${row.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ icp_config: next }),
    });
    if (!patch.ok) throw new Error(`patch ${c.slug}: ${patch.status} ${await patch.text()}`);
    applied++;
  }
}
console.log(dry ? "\ndry run only — nothing written" : `\napplied to ${applied} industries`);

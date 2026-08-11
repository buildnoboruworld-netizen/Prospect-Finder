import "server-only";

// PRD §7 enforcement point 1 — the exclusion set that goes into the seed
// prompt. Naming everything the team has already seen up front is what stops
// the run spending qualify budget on companies we would throw away at save
// time. Runs server-side with the service-role client: a run must see every
// teammate's rows, not just the RLS-visible slice of one session.

import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeDomain, normalizeIgHandle, normalizeName } from "@/lib/normalize";
import type { IcpConfig } from "@/lib/types";

export interface ExclusionSet {
  brands: string[];
  domains: string[];
  handles: string[];
}

type AdminClient = ReturnType<typeof createAdminClient>;

// PostgREST caps rows per response, and a silently short exclusion list is
// exactly the failure this module exists to prevent — so page to exhaustion.
const PAGE_SIZE = 1000;

interface CompanyIdentity {
  name: string | null;
  domain: string | null;
  instagram_handle: string | null;
}

async function fetchIdentities(
  admin: AdminClient,
  column: "industry_id" | "status",
  value: string
): Promise<CompanyIdentity[]> {
  const rows: CompanyIdentity[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("companies")
      .select("name, domain, instagram_handle")
      .eq(column, value)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(
        `Exclusion list could not be built (${column}=${value}): ${error.message}`
      );
    }
    const page = (data ?? []) as CompanyIdentity[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

// ICP exclusions are hand-typed by whoever configured the industry, so an
// entry may be a brand name, a bare domain, or an @handle. Route each to the
// list the engine actually matches against.
function classifyExclusion(entry: string): "handle" | "domain" | "brand" {
  if (entry.startsWith("@") || /instagram\.com\//i.test(entry)) return "handle";
  if (!/\s/.test(entry) && /^(https?:\/\/)?[^\s/]+\.[a-z]{2,}/i.test(entry)) {
    return "domain";
  }
  return "brand";
}

export async function buildExclusions(industryId: string): Promise<ExclusionSet> {
  const admin = createAdminClient();

  const { data: industryRow, error: industryError } = await admin
    .from("industries")
    .select("icp_config")
    .eq("id", industryId)
    .maybeSingle();
  if (industryError) {
    throw new Error(`Exclusion list could not be built: ${industryError.message}`);
  }
  const icp = (industryRow?.icp_config ?? {}) as IcpConfig;

  const [inIndustry, rejectedAnywhere] = await Promise.all([
    // Any status: a draft a teammate is still reviewing is just as much a
    // duplicate as an approved one.
    fetchIdentities(admin, "industry_id", industryId),
    // PRD §7: a rejection is permanent, and it holds across industries —
    // the same brand resurfacing under a neighbouring ICP is still rejected.
    fetchIdentities(admin, "status", "rejected"),
  ]);

  // Keyed by normalized name so "Slurrp Farm" and "slurrp farm" collapse to
  // one entry; the value keeps the readable spelling for the prompt.
  const brands = new Map<string, string>();
  const domains = new Set<string>();
  const handles = new Set<string>();

  const addBrand = (raw: string | null): void => {
    const display = raw?.trim();
    if (!display) return;
    const key = normalizeName(display);
    if (key && !brands.has(key)) brands.set(key, display);
  };

  const configured: unknown[] = Array.isArray(icp.exclusions) ? icp.exclusions : [];
  for (const raw of configured) {
    if (typeof raw !== "string") continue; // jsonb carries no guarantees at rest
    const entry = raw.trim();
    if (!entry) continue;
    switch (classifyExclusion(entry)) {
      case "handle": {
        const handle = normalizeIgHandle(entry);
        if (handle) handles.add(handle);
        break;
      }
      case "domain": {
        const domain = normalizeDomain(entry);
        if (domain) domains.add(domain);
        break;
      }
      default:
        addBrand(entry);
    }
  }

  for (const row of [...inIndustry, ...rejectedAnywhere]) {
    addBrand(row.name);
    const domain = normalizeDomain(row.domain);
    if (domain) domains.add(domain);
    const handle = normalizeIgHandle(row.instagram_handle);
    if (handle) handles.add(handle);
  }

  // Sorted so the exclusion block renders byte-identically across every call
  // in a run — a stable prompt prefix is what makes provider caching hit.
  return {
    brands: [...brands.values()].sort(),
    domains: [...domains].sort(),
    handles: [...handles].sort(),
  };
}

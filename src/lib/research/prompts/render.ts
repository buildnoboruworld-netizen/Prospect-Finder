// Deterministic serialization for prompt bodies.
//
// Providers cache on byte-identical prefixes, so the same run state must render
// to the same bytes on every call. Nothing here may depend on object key
// insertion order, Set/Map iteration order, or the host locale — hence the
// explicit code-unit comparator instead of localeCompare.

import type { SeedPlan } from "../contracts";

// Rendering every exclusion would dominate the prompt on a mature industry
// (the list grows with every company the team saves). It is a hint to the
// model, not the enforcement point — guardrails re-filter deterministically
// after the answer — so truncating costs correctness nothing.
const MAX_RENDERED_EXCLUSIONS = 150;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cleaned(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

/**
 * Case-insensitive dedupe + stable sort, for lists whose order carries no
 * meaning (exclusions). Ties keep the smallest spelling rather than the
 * first-seen one, so a different input order can't shift the bytes.
 */
export function sortedUnique(
  values: readonly (string | null | undefined)[]
): string[] {
  const byKey = new Map<string, string>();
  for (const value of cleaned(values)) {
    const key = value.toLowerCase();
    const held = byKey.get(key);
    if (held === undefined || compareCodeUnits(value, held) < 0) {
      byKey.set(key, value);
    }
  }
  // Sorted on the lowercased key so "Zed" doesn't jump ahead of "alpha".
  return [...byKey.entries()]
    .sort((a, b) => compareCodeUnits(a[0], b[0]))
    .map(([, value]) => value);
}

/** Dedupe while preserving order, for lists where order is the payload (queries). */
export function orderedUnique(
  values: readonly (string | null | undefined)[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of cleaned(values)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareCodeUnits)) {
      const rendered = canonicalize(source[key]);
      if (rendered !== undefined) out[key] = rendered;
    }
    return out;
  }
  return value;
}

/** JSON with recursively sorted keys — the record format used for stage payloads. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}

export function clamp(
  text: string | null | undefined,
  maxChars: number
): string | null {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return null;
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

export function bulletList(items: readonly string[], empty = "(none)"): string {
  return items.length === 0 ? empty : items.map((i) => `- ${i}`).join("\n");
}

export function numberedList(items: readonly string[], empty = "(none)"): string {
  return items.length === 0
    ? empty
    : items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

/** Label: value lines, empties dropped. Key order is the caller's — it is a literal. */
export function fieldLines(
  fields: Record<string, string | number | boolean | null | undefined>,
  empty = "(not configured)"
): string {
  const lines: string[] = [];
  for (const [label, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const text = typeof value === "string" ? value.trim() : String(value);
    if (text === "") continue;
    lines.push(`${label}: ${text}`);
  }
  return lines.length === 0 ? empty : lines.join("\n");
}

export function section(heading: string, body: string): string {
  return `## ${heading}\n${body}`;
}

export function joinSections(parts: readonly (string | null)[]): string {
  return parts.filter((p): p is string => p !== null && p !== "").join("\n\n");
}

function inlineCapped(values: readonly (string | null | undefined)[]): string {
  const all = sortedUnique(values);
  if (all.length === 0) return "(none)";
  const shown = all.slice(0, MAX_RENDERED_EXCLUSIONS);
  const hidden = all.length - shown.length;
  const line = shown.join(" · ");
  return hidden > 0 ? `${line} … and ${hidden} more` : line;
}

/**
 * The ICP block for stages 2–4. Before this existed, only the seed stage ever
 * saw the bands: the score rubric said "inside the revenue and follower
 * bands" to a model that had never been told what they were. Null when the
 * plan predates the field (a resumed old run) — the section is simply
 * omitted and scoring falls back to the generic rubric.
 */
export function icpBlock(plan: SeedPlan): string | null {
  const icp = plan.icp;
  if (!icp) return null;
  const body = fieldLines(
    {
      "Revenue band (the ICP)": icp.revenueBand,
      "Follower band (the ICP)": icp.followerBand,
      "Why this size": icp.ticketContext,
      "Category fit criteria": icp.fitCriteria,
    },
    "(not set)"
  );
  return section("ICP — 'the band' in the rubric means exactly this", body);
}

/**
 * One renderer for the exclusion block so the three stages that inject it can
 * never drift apart in wording or ordering.
 */
export function exclusionBlock(plan: SeedPlan): string {
  return fieldLines(
    {
      "Brand names": inlineCapped(plan.exclusionBrands),
      Domains: inlineCapped(plan.exclusionDomains),
      "Instagram handles": inlineCapped(plan.exclusionHandles),
    },
    "(none)"
  );
}

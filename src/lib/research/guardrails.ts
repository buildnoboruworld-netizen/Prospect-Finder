// PRD §6.1 enforcement — pure functions over already-zod-parsed stage output.
//
// These live in the engine, not in a provider, because "non-negotiable" means
// "non-delegable": a vendor cannot opt out of them and adding a vendor cannot
// weaken them. If a provider adapter ever needs to touch this file, the port
// has failed (see the leak test in types.ts).
//
// Two of the seven design rules have no code here, on purpose:
//   • the contact clamp — ResearchContact has no status field at all, so
//     'verified' is unreachable from this code path by construction; the
//     insert site is the only place a channel status is chosen.
//   • no padding — that is an engine behaviour (never re-prompt with looser
//     criteria), and its honest report is buildShortfall() below.

import { normalizeDomain, normalizeIgHandle, normalizeName } from "@/lib/normalize";
import { confidenceValues, digitalPresenceValues } from "@/lib/schemas";
import type { CompanySource } from "@/lib/types";
import { urlKey } from "./citations";
import type {
  ExclusionReason,
  ResearchContact,
  ScoredLead,
  SeedPlan,
  ShortfallReport,
} from "./contracts";

export interface GuardrailInput {
  leads: ScoredLead[];
  /** From buildRetrievedUrlSet() — pages a search actually returned this run. */
  retrievedUrls: Set<string>;
  plan: SeedPlan;
  /** ProviderCapabilities.safeForContactData for the provider that produced these. */
  allowContactData: boolean;
}

export interface DroppedLead {
  name: string;
  /** Plain English — this reaches a salesperson via the shortfall report. */
  reason: string;
}

export interface GuardrailResult {
  leads: ScoredLead[];
  dropped: DroppedLead[];
}

export function applyGuardrails(input: GuardrailInput): GuardrailResult {
  const { leads, retrievedUrls, plan, allowContactData } = input;

  const excludedNames = normalizeAll(plan.exclusionBrands, normalizeName);
  const excludedDomains = normalizeAll(plan.exclusionDomains, normalizeDomain);
  const excludedHandles = normalizeAll(plan.exclusionHandles, normalizeIgHandle);

  const kept: ScoredLead[] = [];
  const dropped: DroppedLead[] = [];

  for (const lead of leads) {
    const domain = normalizeDomain(lead.domain);
    const name = normalizeName(lead.name);
    const handle = normalizeIgHandle(lead.instagram_handle);

    // Never trust the model to have honoured the exclusion list it was given.
    const excludedBy =
      name !== null && excludedNames.has(name)
        ? "name"
        : domain !== null && excludedDomains.has(domain)
          ? "website"
          : handle !== null && excludedHandles.has(handle)
            ? "Instagram handle"
            : null;
    if (excludedBy !== null) {
      dropped.push({
        name: lead.name,
        reason: `Its ${excludedBy} matches the exclusion list for this industry — already in the pipeline, previously rejected, or too big for the ICP.`,
      });
      continue;
    }

    // Reject the offending item, never the batch.
    const violation = findFieldViolation(lead);
    if (violation !== null) {
      dropped.push({ name: lead.name, reason: violation });
      continue;
    }

    if (lead.sources.length === 0) {
      dropped.push({
        name: lead.name,
        reason: "No source URL. Every claim needs at least one, so this cannot be drafted.",
      });
      continue;
    }

    // The fabricated-URL defence: a source is only a source if we retrieved it.
    const sources = lead.sources.filter((source) => {
      const key = urlKey(source.url);
      return key !== null && retrievedUrls.has(key);
    });
    if (sources.length === 0) {
      dropped.push({
        name: lead.name,
        reason:
          "None of its source links were pages this run actually opened — the model appears to have made them up.",
      });
      continue;
    }

    kept.push({
      ...lead,
      sources,
      // Losing some sources costs the lead its confidence, not its place in the
      // queue — a human reviewer still sees it, flagged as shakier.
      confidence: sources.length < lead.sources.length ? "low" : lead.confidence,
      // A provider whose terms allow human review of submitted data never gets
      // to hand us contact details back either; the lead goes to enrichment
      // with an empty contact list, which is a normal outcome, not an error.
      public_contacts: allowContactData
        ? filterContacts(lead.public_contacts, domain, sources, retrievedUrls)
        : [],
    });
  }

  return { leads: kept, dropped };
}

/**
 * PRD P0-4: under-delivery is reported, never padded away. The explanation is
 * written for the salesperson reading the run view, not for a developer.
 */
export function buildShortfall(
  target: number,
  delivered: number,
  excluded: ReadonlyArray<{ name: string; reason: ExclusionReason }>,
  droppedCount: number
): ShortfallReport {
  const excludedCounts: ShortfallReport["excludedCounts"] = {};
  for (const item of excluded) {
    excludedCounts[item.reason] = (excludedCounts[item.reason] ?? 0) + 1;
  }
  if (droppedCount > 0) excludedCounts.guardrail_dropped = droppedCount;

  return {
    target,
    delivered,
    excludedCounts,
    explanation: explain(target, delivered, excludedCounts),
  };
}

// ── internals ───────────────────────────────────────────────────────────────

function findFieldViolation(lead: ScoredLead): string | null {
  if (!includes(digitalPresenceValues, lead.digital_presence)) {
    return `Its digital presence came back as "${lead.digital_presence}", which is not one of the values we track.`;
  }
  if (!includes(confidenceValues, lead.confidence)) {
    return `Its confidence came back as "${lead.confidence}", which is not one of the values we track.`;
  }
  if (!Number.isInteger(lead.fit_score) || lead.fit_score < 1 || lead.fit_score > 5) {
    return `Its fit score of ${lead.fit_score} is outside the 1–5 scale.`;
  }
  const hook = lead.hook.trim();
  if (hook.length === 0) return "No hook — there is nothing for the salesperson to open with.";
  if (hook.length > 500) return `Its hook runs to ${hook.length} characters; the limit is 500.`;
  return null;
}

function filterContacts(
  contacts: ResearchContact[],
  leadDomain: string | null,
  sources: CompanySource[],
  retrievedUrls: Set<string>
): ResearchContact[] {
  // Only surviving sources authorise a contact domain — a fabricated URL must
  // not be able to launder an invented email address.
  const ownHosts = new Set<string>();
  if (leadDomain !== null) ownHosts.add(leadDomain);
  for (const source of sources) {
    const host = normalizeDomain(source.url);
    if (host !== null) ownHosts.add(host);
  }

  const kept: ResearchContact[] = [];
  for (const contact of contacts) {
    const key = urlKey(contact.sourceUrl);
    if (key === null || !retrievedUrls.has(key)) continue;

    const email =
      contact.email !== null && isOnOwnHost(contact.email, ownHosts) ? contact.email : null;

    // Stripped of everything identifying, a contact is noise. P0-8: we leave it
    // empty for enrichment rather than guess the missing address.
    if (email === null && contact.fullName === null && contact.phone === null) continue;

    kept.push({ ...contact, email });
  }
  return kept;
}

function isOnOwnHost(email: string, ownHosts: Set<string>): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const host = normalizeDomain(email.slice(at + 1));
  if (host === null) return false;
  // Subdomains count: hello@shop.brand.com is still the brand's own address.
  for (const own of ownHosts) {
    if (host === own || host.endsWith(`.${own}`)) return true;
  }
  return false;
}

type ShortfallKey = ExclusionReason | "guardrail_dropped";

// Fixed order so the same run always renders the same sentence.
const REASON_ORDER: readonly ShortfallKey[] = [
  "too_big",
  "duplicate",
  "rejected",
  "off_icp",
  "no_source",
  "guardrail_dropped",
];

const REASON_PHRASES: Record<ShortfallKey, string> = {
  too_big: "too big for the brief",
  duplicate: "already in the pipeline",
  rejected: "rejected by the team before",
  off_icp: "not a fit for this industry",
  no_source: "nothing public to back them up",
  guardrail_dropped: "sources we could not verify",
};

function explain(
  target: number,
  delivered: number,
  counts: ShortfallReport["excludedCounts"]
): string {
  const found = `Found ${count(delivered, "lead")} against a target of ${target}.`;
  if (delivered >= target) return `${found} Target met.`;

  const parts: string[] = [];
  for (const key of REASON_ORDER) {
    const n = counts[key];
    if (n !== undefined && n > 0) parts.push(`${n} ${REASON_PHRASES[key]}`);
  }

  const setAside =
    parts.length > 0
      ? `Companies checked and set aside: ${joinList(parts)}.`
      : "Not enough companies matching the brief turned up in this run.";

  return `${found} ${setAside} The list was not padded — anything else would have meant loosening the brief. To go deeper, add seed queries, widen the cities, or relax the revenue band, then run again.`;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function joinList(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function normalizeAll(
  values: string[],
  normalize: (raw: string | null | undefined) => string | null
): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized !== null) out.add(normalized);
  }
  return out;
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

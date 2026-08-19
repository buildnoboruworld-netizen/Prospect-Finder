// Stage contracts for the research engine (PRD §6.1).
//
// These four stages are the semantics of the pipeline and are 100%
// provider-independent: swapping Gemini for Claude must not change any type
// in this file. Everything is typed against src/lib/types.ts so a scored lead
// drops straight into the companies table.

import type {
  CompanySource,
  ConfidenceLevel,
  ContactRoleType,
  DigitalPresence,
  IcpConfig,
  Industry,
  RunStage,
} from "@/lib/types";

// runs.stage carries all six values; the engine only executes these four.
export type ResearchStage = Exclude<RunStage, "done" | "failed">;

export const RESEARCH_STAGES: readonly ResearchStage[] = [
  "seed",
  "discover",
  "qualify",
  "score",
] as const;

// ── Stage 1: seed ───────────────────────────────────────────────────────────

export interface SeedPlan {
  queries: string[];
  /** Big brands from icp_config ∪ every company already in this industry. */
  exclusionBrands: string[];
  exclusionDomains: string[];
  exclusionHandles: string[];
  /** PRD G1: 15–20 approved leads per run. */
  targetLeads: number;
  notes: string | null;
  /**
   * The ICP carried through to every later stage. Without this, only the
   * seed stage ever saw the bands — the score rubric said "inside the
   * revenue and follower bands" while the scoring model had never been told
   * what they were, so fit was judged from general vibes. Optional because
   * runs persisted before this field existed rehydrate without it.
   */
  icp?: {
    revenueBand: string | null;
    followerBand: string | null;
    ticketContext: string | null;
    fitCriteria: string | null;
  };
}

// ── Stage 2: discover ───────────────────────────────────────────────────────

export interface Candidate {
  name: string;
  domain: string | null;
  instagramHandle: string | null;
  city: string | null;
  /** One line on why this looks ICP-fit. */
  why: string;
  sources: CompanySource[];
}

export type ExclusionReason =
  | "too_big"
  | "duplicate"
  | "rejected"
  | "off_icp"
  | "no_source";

export interface DiscoverOutput {
  candidates: Candidate[];
  excluded: Array<{ name: string; reason: ExclusionReason }>;
}

// ── Stage 3: qualify ────────────────────────────────────────────────────────

/**
 * A contact found on the brand's OWN public pages.
 *
 * PRD §6.1 guardrail: research can NEVER produce a `verified` channel — that
 * status is reserved for enrichment APIs (Phase 3). There is deliberately no
 * status field here; the engine hardcodes `public_generic` on insert, so
 * `verified` is unreachable from this code path.
 */
export interface ResearchContact {
  fullName: string | null;
  designation: string | null;
  roleType: ContactRoleType;
  email: string | null;
  phone: string | null;
  /** Must be a URL actually retrieved this stage, on the brand's own host. */
  sourceUrl: string;
}

export interface QualifiedProfile extends Candidate {
  founderName: string | null;
  igFollowersBand: string | null;
  revenueEstimate: string | null;
  fundingStage: string | null;
  sharkTankStatus: string | null;
  hasOwnSite: boolean;
  siteContentDepth: "rich" | "thin" | "none";
  amazonPresence: boolean;
  publicContacts: ResearchContact[];
}

// ── Stage 4: score ──────────────────────────────────────────────────────────

export interface ScoredLead {
  name: string;
  domain: string | null;
  instagram_handle: string | null;
  ig_followers_band: string | null;
  city: string | null;
  revenue_estimate: string | null;
  funding_stage: string | null;
  shark_tank_status: string | null;
  digital_presence: DigitalPresence; // PRD §6.3
  fit_score: 1 | 2 | 3 | 4 | 5;
  hook: string;
  confidence: ConfidenceLevel;
  sources: CompanySource[];
  public_contacts: ResearchContact[];
}

/**
 * PRD P0-4: when a run finds fewer than the target, it says so honestly —
 * with what it excluded and why — rather than padding with bad fits.
 */
export interface ShortfallReport {
  target: number;
  delivered: number;
  excludedCounts: Partial<Record<ExclusionReason | "guardrail_dropped", number>>;
  explanation: string;
}

// ── The stage input/output map ──────────────────────────────────────────────

export interface StageIO {
  seed: {
    input: { industry: Industry; icp: IcpConfig };
    output: SeedPlan;
  };
  discover: {
    input: { plan: SeedPlan };
    output: DiscoverOutput;
  };
  qualify: {
    input: { batch: Candidate[]; plan: SeedPlan };
    output: { profiles: QualifiedProfile[] };
  };
  score: {
    input: { profiles: QualifiedProfile[]; plan: SeedPlan };
    output: { leads: ScoredLead[]; shortfall: ShortfallReport | null };
  };
}

// Database types — hand-written to mirror supabase/migrations.
// Once the Supabase project exists, generated types can replace this file:
//   npx supabase gen types typescript --linked > src/lib/database.types.ts

export type UserRole = "admin" | "member";

export type CompanyStatus =
  | "draft"
  | "approved"
  | "rejected"
  | "enriched"
  | "synced";

export type DigitalPresence =
  | "WEB_ACTIVE"
  | "WEB_THIN"
  | "AMAZON_ONLY"
  | "IG_ONLY"
  | "NONE";

export type ConfidenceLevel = "high" | "med" | "low";

export type ContactRoleType = "founder" | "marketing" | "other";

export type ContactChannelStatus = "verified" | "public_generic" | "unknown";

export type ContactSource = "research" | "lusha" | "apollo" | "manual";

export type RunStage =
  | "seed"
  | "discover"
  | "qualify"
  | "score"
  | "done"
  | "failed";

export type SyncStatus = "success" | "error";

export interface AppUser {
  id: string;
  auth_user_id: string | null;
  email: string;
  name: string | null;
  role: UserRole;
  active: boolean;
  created_at: string;
}

export interface IcpConfig {
  revenue_band?: string;
  follower_band?: string;
  ticket_context?: string;
  seed_queries?: string[];
  exclusions?: string[];
  notes?: string;
}

export interface Industry {
  id: string;
  name: string;
  slug: string;
  icp_config: IcpConfig;
  created_at: string;
}

export interface Assignment {
  id: string;
  industry_id: string;
  user_id: string;
  active: boolean;
  assigned_by: string | null;
  created_at: string;
}

export interface CompanySource {
  url: string;
  note?: string;
}

export interface Company {
  id: string;
  industry_id: string;
  name: string;
  name_normalized: string | null;
  domain: string | null;
  domain_normalized: string | null;
  instagram_handle: string | null;
  instagram_handle_normalized: string | null;
  ig_followers_band: string | null;
  city: string | null;
  revenue_estimate: string | null;
  funding_stage: string | null;
  shark_tank_status: string | null;
  digital_presence: DigitalPresence | null;
  fit_score: number | null;
  hook: string | null;
  confidence: ConfidenceLevel | null;
  sources: CompanySource[];
  status: CompanyStatus;
  owner_id: string;
  rejected_reason: string | null;
  created_by_run: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  company_id: string;
  full_name: string | null;
  designation: string | null;
  role_type: ContactRoleType;
  email: string | null;
  email_status: ContactChannelStatus;
  phone: string | null;
  phone_status: ContactChannelStatus;
  source: ContactSource;
  credits_spent: number;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  industry_id: string;
  user_id: string;
  stage: RunStage;
  stage_state: Record<string, unknown>;
  candidates_found: number;
  leads_drafted: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  searches: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SheetSyncLog {
  id: string;
  company_id: string;
  sheet_row: number | null;
  status: SyncStatus;
  error_message: string | null;
  synced_at: string;
}

export interface AuditLog {
  id: string;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: string;
}

// ── joined shapes used by the UI ────────────────────────────────────────────

export interface CompanyListRow extends Company {
  industry: Pick<Industry, "id" | "name" | "slug"> | null;
  owner: Pick<AppUser, "id" | "name" | "email"> | null;
  contacts: Contact[];
}

// result shape of the check_company_duplicate RPC
export interface DuplicateMatch {
  id: string;
  name: string;
  domain: string | null;
  instagram_handle: string | null;
  city: string | null;
  status: CompanyStatus;
  rejected_reason: string | null;
  owner_id: string;
  owner_name: string | null;
  industry_name: string | null;
  similarity?: number;
}

export interface DuplicateCheckResult {
  domain_match: DuplicateMatch | null;
  instagram_match: DuplicateMatch | null;
  fuzzy_matches: DuplicateMatch[];
}

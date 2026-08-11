-- ============================================================================
-- Noboru Prospector — Phase 2: research-run provenance
--
-- Records WHICH engine produced a lead, and hard-separates sample/demo data
-- from real research so it can never reach the team's Google Sheet or the
-- approved pipeline. (Free-tier providers are weaker than the PRD-specified
-- Claude path, so the provider is recorded per run for quality attribution.)
-- ============================================================================

-- ── runs: which provider/model produced this run ────────────────────────────
alter table public.runs
  add column if not exists provider   text,
  add column if not exists model_id   text,
  add column if not exists is_sample  boolean not null default false;

-- ── companies: sample rows are quarantined ──────────────────────────────────
alter table public.companies
  add column if not exists is_sample boolean not null default false;

comment on column public.companies.is_sample is
  'True = produced by the demo/fixture provider. Such rows can never be '
  'approved and are excluded from Google Sheets sync. Enforced in code '
  '(approveCompany, fetchSyncableCompanies) AND by the constraint below.';

-- A sample company can never sit in an outward-facing state. This is the
-- backstop for the application-level checks: even a direct SQL insert or a
-- future code path that forgets the guard cannot put demo data in front of
-- the team.
alter table public.companies
  drop constraint if exists sample_never_outward_facing;
alter table public.companies
  add constraint sample_never_outward_facing
  check (not is_sample or status in ('draft', 'rejected'));

create index if not exists companies_sample_idx
  on public.companies (is_sample) where is_sample;

-- ── research-quality bookkeeping on runs ────────────────────────────────────
-- PRD P0-4 (honest under-delivery): what the run excluded and why, so the
-- review queue can explain a short run instead of padding it.
alter table public.runs
  add column if not exists shortfall jsonb;

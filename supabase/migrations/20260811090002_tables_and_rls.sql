-- ============================================================================
-- Noboru Prospector — Migration 2: tables, indexes, RLS (PRD §8)
-- RLS rule: members read all, write only rows they own; admins write all.
-- ============================================================================

-- ── users ───────────────────────────────────────────────────────────────────
-- Doubles as the login allowlist: a row must exist (active=true) BEFORE a
-- Google account may use the app. auth_user_id links to auth.users on first
-- sign-in (done server-side in the auth callback).
create table public.users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  email         text not null unique check (email = lower(email)),
  name          text,
  role          public.user_role not null default 'member',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ── industries ──────────────────────────────────────────────────────────────
create table public.industries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  slug        text not null unique,
  -- { revenue_band, follower_band, ticket_context, seed_queries[], exclusions[], notes }
  icp_config  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ── assignments ─────────────────────────────────────────────────────────────
-- History-preserving: reassignment = deactivate old row + insert new row.
create table public.assignments (
  id           uuid primary key default gen_random_uuid(),
  industry_id  uuid not null references public.industries (id),
  user_id      uuid not null references public.users (id),
  active       boolean not null default true,
  assigned_by  uuid references public.users (id),
  created_at   timestamptz not null default now()
);

-- one ACTIVE assignment per (industry, user); history rows are active=false
create unique index assignments_active_unique
  on public.assignments (industry_id, user_id) where active;
create index assignments_user_idx on public.assignments (user_id) where active;

-- ── runs ────────────────────────────────────────────────────────────────────
-- Research-engine runs (populated in Phase 2; schema here so companies can
-- reference their originating run from day one).
create table public.runs (
  id                uuid primary key default gen_random_uuid(),
  industry_id       uuid not null references public.industries (id),
  user_id           uuid not null references public.users (id),
  stage             public.run_stage not null default 'seed',
  stage_state       jsonb not null default '{}'::jsonb,
  candidates_found  integer not null default 0,
  leads_drafted     integer not null default 0,
  cost_usd          numeric(10,4) not null default 0,
  tokens_in         bigint not null default 0,
  tokens_out        bigint not null default 0,
  searches          integer not null default 0,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index runs_industry_idx on public.runs (industry_id);
create index runs_user_idx on public.runs (user_id);

create trigger runs_set_updated_at
  before update on public.runs
  for each row execute function public.set_updated_at();

-- ── companies ───────────────────────────────────────────────────────────────
create table public.companies (
  id                            uuid primary key default gen_random_uuid(),
  industry_id                   uuid not null references public.industries (id),
  name                          text not null,
  name_normalized               text generated always as (public.normalize_name(name)) stored,
  domain                        text,
  domain_normalized             text generated always as (public.normalize_domain(domain)) stored,
  instagram_handle              text,
  instagram_handle_normalized   text generated always as (public.normalize_ig_handle(instagram_handle)) stored,
  ig_followers_band             text,
  city                          text,
  revenue_estimate              text,
  funding_stage                 text,
  shark_tank_status             text,
  digital_presence              public.digital_presence,
  fit_score                     integer check (fit_score between 1 and 5),
  hook                          text,
  confidence                    public.confidence_level,
  sources                       jsonb not null default '[]'::jsonb,  -- [{url, note?}]
  status                        public.company_status not null default 'draft',
  owner_id                      uuid not null references public.users (id),
  rejected_reason               text,
  created_by_run                uuid references public.runs (id),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  -- rejected rows must carry the reason they are excluded forever (PRD §7)
  constraint rejected_needs_reason
    check (status <> 'rejected' or rejected_reason is not null)
);

-- PRD §7 dedup keys 1 & 2 — hard unique, race-safe at save time
create unique index companies_domain_normalized_key
  on public.companies (domain_normalized) where domain_normalized is not null;
create unique index companies_ig_handle_normalized_key
  on public.companies (instagram_handle_normalized) where instagram_handle_normalized is not null;

-- PRD §7 dedup key 3 — trigram fuzzy on normalized name
create index companies_name_trgm_idx
  on public.companies using gin (name_normalized gin_trgm_ops);

create index companies_industry_idx on public.companies (industry_id);
create index companies_owner_idx on public.companies (owner_id);
create index companies_status_idx on public.companies (status);

create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

-- ── contacts ────────────────────────────────────────────────────────────────
-- Multiple contacts per company (PRD user story 7); new contacts for an
-- existing company ATTACH to it — never a new company row.
create table public.contacts (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  full_name      text,
  designation    text,
  role_type      public.contact_role_type not null default 'other',
  email          text,
  email_status   public.contact_channel_status not null default 'unknown',
  phone          text,
  phone_status   public.contact_channel_status not null default 'unknown',
  source         public.contact_source not null default 'manual',
  credits_spent  numeric(10,2) not null default 0,
  is_primary     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index contacts_company_idx on public.contacts (company_id);
-- at most one primary contact per company
create unique index contacts_one_primary_per_company
  on public.contacts (company_id) where is_primary;

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- ── sheet_sync_log ──────────────────────────────────────────────────────────
create table public.sheet_sync_log (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  sheet_row      integer,
  status         public.sync_status not null,
  error_message  text,
  synced_at      timestamptz not null default now()
);

create index sheet_sync_log_company_idx on public.sheet_sync_log (company_id);

-- ── audit_log ───────────────────────────────────────────────────────────────
create table public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.users (id),  -- null = system action
  action     text not null,                      -- e.g. company.approve
  entity     text not null,                      -- e.g. company
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);

create index audit_log_entity_idx on public.audit_log (entity, entity_id);

-- ============================================================================
-- RLS helpers — SECURITY DEFINER so policies on `users` don't recurse.
-- ============================================================================

-- internal users.id of the calling session, only if allowlisted + active
create or replace function public.app_current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users
  where auth_user_id = (select auth.uid()) and active
$$;

create or replace function public.app_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where auth_user_id = (select auth.uid()) and active
  )
$$;

create or replace function public.app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where auth_user_id = (select auth.uid()) and active and role = 'admin'
  )
$$;

revoke all on function public.app_current_user_id() from anon;
revoke all on function public.app_is_active() from anon;
revoke all on function public.app_is_admin() from anon;

-- ============================================================================
-- Row Level Security — enabled from day one on every table.
-- ============================================================================

alter table public.users          enable row level security;
alter table public.industries     enable row level security;
alter table public.assignments    enable row level security;
alter table public.runs           enable row level security;
alter table public.companies      enable row level security;
alter table public.contacts       enable row level security;
alter table public.sheet_sync_log enable row level security;
alter table public.audit_log      enable row level security;

-- users: own row always visible (needed for the allowlist check before the
-- roster is readable); full roster for active users; writes admin-only.
create policy users_select on public.users for select
  using (
    auth_user_id = (select auth.uid())
    or email = lower(coalesce((select auth.jwt() ->> 'email'), ''))
    or public.app_is_active()
  );
create policy users_insert on public.users for insert
  with check (public.app_is_admin());
create policy users_update on public.users for update
  using (public.app_is_admin()) with check (public.app_is_admin());
create policy users_delete on public.users for delete
  using (public.app_is_admin());

-- industries: read team-wide, write admin
create policy industries_select on public.industries for select
  using (public.app_is_active());
create policy industries_write on public.industries for all
  using (public.app_is_admin()) with check (public.app_is_admin());

-- assignments: read team-wide, write admin
create policy assignments_select on public.assignments for select
  using (public.app_is_active());
create policy assignments_write on public.assignments for all
  using (public.app_is_admin()) with check (public.app_is_admin());

-- runs: read team-wide; members create/update their own
create policy runs_select on public.runs for select
  using (public.app_is_active());
create policy runs_insert on public.runs for insert
  with check (user_id = public.app_current_user_id() or public.app_is_admin());
create policy runs_update on public.runs for update
  using (user_id = public.app_current_user_id() or public.app_is_admin())
  with check (user_id = public.app_current_user_id() or public.app_is_admin());
create policy runs_delete on public.runs for delete
  using (public.app_is_admin());

-- companies: read team-wide (cross-reachout awareness); write own; admin all
create policy companies_select on public.companies for select
  using (public.app_is_active());
create policy companies_insert on public.companies for insert
  with check (owner_id = public.app_current_user_id() or public.app_is_admin());
create policy companies_update on public.companies for update
  using (owner_id = public.app_current_user_id() or public.app_is_admin())
  with check (owner_id = public.app_current_user_id() or public.app_is_admin());
create policy companies_delete on public.companies for delete
  using (public.app_is_admin());

-- contacts: read team-wide; write if you own the parent company; admin all
create policy contacts_select on public.contacts for select
  using (public.app_is_active());
create policy contacts_write on public.contacts for all
  using (
    public.app_is_admin() or exists (
      select 1 from public.companies c
      where c.id = contacts.company_id
        and c.owner_id = public.app_current_user_id()
    )
  )
  with check (
    public.app_is_admin() or exists (
      select 1 from public.companies c
      where c.id = contacts.company_id
        and c.owner_id = public.app_current_user_id()
    )
  );

-- sheet_sync_log: read team-wide; written only by the server (service role)
create policy sheet_sync_log_select on public.sheet_sync_log for select
  using (public.app_is_active());

-- audit_log: read team-wide (internal transparency); members insert own rows
create policy audit_log_select on public.audit_log for select
  using (public.app_is_active());
create policy audit_log_insert on public.audit_log for insert
  with check (user_id = public.app_current_user_id() or public.app_is_admin());

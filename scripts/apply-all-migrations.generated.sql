-- GENERATED from supabase/migrations (do not edit — regenerate instead)
-- Run once in the Supabase SQL editor. Order: 20260811090001_extensions_types_helpers.sql, 20260811090002_tables_and_rls.sql, 20260811090003_dedup_check.sql, 20260811090004_seed_industries_admin.sql

-- ═══ 20260811090001_extensions_types_helpers.sql ═══
-- ============================================================================
-- Noboru Prospector â€” Migration 1: extensions, enum types, normalizers
-- PRD Â§7 (dedup keys), Â§8 (data model)
-- ============================================================================

-- Trigram similarity for fuzzy name matching (PRD Â§7 key 3)
create extension if not exists pg_trgm;

-- â”€â”€ Enum types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

create type public.user_role as enum ('admin', 'member');

create type public.company_status as enum
  ('draft', 'approved', 'rejected', 'enriched', 'synced');

-- PRD Â§6.3 Digital-Presence Classifier
create type public.digital_presence as enum
  ('WEB_ACTIVE', 'WEB_THIN', 'AMAZON_ONLY', 'IG_ONLY', 'NONE');

create type public.confidence_level as enum ('high', 'med', 'low');

create type public.contact_role_type as enum ('founder', 'marketing', 'other');

-- Contact channels are 'verified' only when they come from an enrichment API;
-- 'public_generic' when lifted from the brand's own public pages (PRD Â§6.1).
create type public.contact_channel_status as enum
  ('verified', 'public_generic', 'unknown');

create type public.contact_source as enum ('research', 'lusha', 'apollo', 'manual');

create type public.run_stage as enum
  ('seed', 'discover', 'qualify', 'score', 'done', 'failed');

create type public.sync_status as enum ('success', 'error');

-- â”€â”€ Normalizers (PRD Â§7 â€” dedup keys) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Immutable so they can back generated columns; duplicated in
-- src/lib/normalize.ts for the live check-as-you-type UI. Keep both in sync.

-- strip protocol, www., path/query/fragment, lowercase; empty â†’ null
create or replace function public.normalize_domain(raw text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(trim(coalesce(raw, ''))), '^https?://', ''),
        '^www\.', ''),
      '[/?#].*$', ''),
    '')
$$;

-- accept "@handle", "handle", or a full instagram.com URL; lowercase; empty â†’ null
create or replace function public.normalize_ig_handle(raw text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(trim(coalesce(raw, ''))), '^https?://(www\.)?instagram\.com/', ''),
          '^@', ''),
        '[/?#].*$', ''),
      '\s', '', 'g'),
    '')
$$;

-- lowercase, strip punctuation, collapse whitespace; empty â†’ null
create or replace function public.normalize_name(raw text)
returns text
language sql
immutable
as $$
  select nullif(
    trim(
      regexp_replace(
        regexp_replace(lower(coalesce(raw, '')), '[^a-z0-9\s]', ' ', 'g'),
        '\s+', ' ', 'g')),
    '')
$$;

-- â”€â”€ updated_at maintenance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ═══ 20260811090002_tables_and_rls.sql ═══
-- ============================================================================
-- Noboru Prospector â€” Migration 2: tables, indexes, RLS (PRD Â§8)
-- RLS rule: members read all, write only rows they own; admins write all.
-- ============================================================================

-- â”€â”€ users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

-- â”€â”€ industries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
create table public.industries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  slug        text not null unique,
  code        text unique,        -- team shorthand from the allotment sheet (PF, ML, HSâ€¦)
  -- { revenue_band, follower_band, ticket_context, seed_queries[], exclusions[], notes }
  icp_config  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- â”€â”€ assignments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

-- â”€â”€ runs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

-- â”€â”€ companies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  -- rejected rows must carry the reason they are excluded forever (PRD Â§7)
  constraint rejected_needs_reason
    check (status <> 'rejected' or rejected_reason is not null)
);

-- PRD Â§7 dedup keys 1 & 2 â€” hard unique, race-safe at save time
create unique index companies_domain_normalized_key
  on public.companies (domain_normalized) where domain_normalized is not null;
create unique index companies_ig_handle_normalized_key
  on public.companies (instagram_handle_normalized) where instagram_handle_normalized is not null;

-- PRD Â§7 dedup key 3 â€” trigram fuzzy on normalized name
create index companies_name_trgm_idx
  on public.companies using gin (name_normalized gin_trgm_ops);

create index companies_industry_idx on public.companies (industry_id);
create index companies_owner_idx on public.companies (owner_id);
create index companies_status_idx on public.companies (status);

create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

-- â”€â”€ contacts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Multiple contacts per company (PRD user story 7); new contacts for an
-- existing company ATTACH to it â€” never a new company row.
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

-- â”€â”€ sheet_sync_log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
create table public.sheet_sync_log (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  sheet_row      integer,
  status         public.sync_status not null,
  error_message  text,
  synced_at      timestamptz not null default now()
);

create index sheet_sync_log_company_idx on public.sheet_sync_log (company_id);

-- â”€â”€ audit_log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
-- RLS helpers â€” SECURITY DEFINER so policies on `users` don't recurse.
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
-- Row Level Security â€” enabled from day one on every table.
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


-- ═══ 20260811090003_dedup_check.sql ═══
-- ============================================================================
-- Noboru Prospector â€” Migration 3: dedup check RPC (PRD Â§7)
-- Used by manual-add live check-as-you-type and re-checked at save time.
-- Exact domain / instagram matches BLOCK; fuzzy name+city matches FLAG for
-- human confirmation â€” never auto-merge.
-- ============================================================================

-- compact json view of a company for dedup UI (includes owner + industry)
create or replace function public._company_match_json(c public.companies)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'domain', c.domain,
    'instagram_handle', c.instagram_handle,
    'city', c.city,
    'status', c.status,
    'rejected_reason', c.rejected_reason,
    'owner_id', c.owner_id,
    'owner_name', (select coalesce(u.name, u.email) from public.users u where u.id = c.owner_id),
    'industry_name', (select i.name from public.industries i where i.id = c.industry_id)
  )
$$;

create or replace function public.check_company_duplicate(
  p_name text default null,
  p_domain text default null,
  p_instagram text default null,
  p_city text default null,
  p_exclude_id uuid default null   -- when editing an existing company
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_domain text := public.normalize_domain(p_domain);
  v_ig     text := public.normalize_ig_handle(p_instagram);
  v_name   text := public.normalize_name(p_name);
  v_domain_match jsonb;
  v_ig_match     jsonb;
  v_fuzzy        jsonb;
begin
  -- only allowlisted active users may probe the database
  if not public.app_is_active() then
    raise exception 'not authorized';
  end if;

  if v_domain is not null then
    select public._company_match_json(c) into v_domain_match
    from public.companies c
    where c.domain_normalized = v_domain
      and (p_exclude_id is null or c.id <> p_exclude_id)
    limit 1;
  end if;

  if v_ig is not null then
    select public._company_match_json(c) into v_ig_match
    from public.companies c
    where c.instagram_handle_normalized = v_ig
      and (p_exclude_id is null or c.id <> p_exclude_id)
    limit 1;
  end if;

  -- fuzzy name (+ city when both known) â€” trigram similarity â‰¥ 0.85 (PRD Â§7)
  if v_name is not null then
    select coalesce(jsonb_agg(m.match), '[]'::jsonb) into v_fuzzy
    from (
      select public._company_match_json(c)
               || jsonb_build_object('similarity', round(similarity(c.name_normalized, v_name)::numeric, 2))
             as match
      from public.companies c
      where c.name_normalized is not null
        and similarity(c.name_normalized, v_name) >= 0.85
        and (p_exclude_id is null or c.id <> p_exclude_id)
        and (v_domain is null or c.domain_normalized is distinct from v_domain)
        and (v_ig is null or c.instagram_handle_normalized is distinct from v_ig)
        and (
          p_city is null or c.city is null
          or lower(trim(c.city)) = lower(trim(p_city))
        )
      order by similarity(c.name_normalized, v_name) desc
      limit 5
    ) m;
  end if;

  return jsonb_build_object(
    'domain_match', v_domain_match,
    'instagram_match', v_ig_match,
    'fuzzy_matches', coalesce(v_fuzzy, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.check_company_duplicate(text, text, text, text, uuid) from anon;
revoke all on function public._company_match_json(public.companies) from anon;


-- ═══ 20260811090004_seed_industries_admin.sql ═══
-- ============================================================================
-- Noboru Prospector â€” Migration 4: seed data
-- Full 26-industry allotment sheet (11 Aug 2026) + admin user + admin's
-- assignments. Sub-industries (Clothing, Personal Care) are flattened into
-- their own rows since each is separately assignable and researchable.
-- Exclusion lists = brands too big for the â‚¹40â€“50K retainer ICP; starter
-- lists only â€” admin refines them over time (ICP Studio, Phase 4).
--
-- Teammates (Neha, Sharmila, Aryan) are seeded later when their Google
-- emails exist â€” template in scripts/seed-teammates.sql.
-- ============================================================================

-- â”€â”€ admin (Pragaman) â€” the login allowlist seed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
insert into public.users (email, name, role, active)
values ('build.noboruworld@gmail.com', 'Pragaman', 'admin', true)
on conflict (email) do update set role = 'admin', active = true;

-- â”€â”€ industries (shared starter bands) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- jsonb shape: revenue_band, follower_band, ticket_context, seed_queries[],
-- exclusions[], notes
with base as (
  select
    'â‚¹50Lâ€“â‚¹10Cr annual'::text as revenue_band,
    '2kâ€“100k'::text as follower_band,
    'can afford â‚¹40â€“50K/month organic-growth retainer'::text as ticket_context
)
insert into public.industries (name, slug, code, icp_config)
select x.name, x.slug, x.code,
  jsonb_build_object(
    'revenue_band', b.revenue_band,
    'follower_band', b.follower_band,
    'ticket_context', b.ticket_context,
    'seed_queries', x.seed_queries,
    'exclusions', x.exclusions,
    'notes', x.notes
  )
from base b,
(values
  ('Pet Food', 'pet-food', 'PF',
    to_jsonb(array[
      'pet food D2C brand India',
      'fresh pet food startup India',
      'Shark Tank India pet food brand',
      'dog treats brand India Instagram',
      'emerging pet nutrition brands India site:yourstory.com']),
    to_jsonb(array['Heads Up For Tails','Supertails','Drools','Pedigree','Royal Canin','Farmina']),
    'Starter config â€” refine per run learnings.'),

  ('Pet Care', 'pet-care', 'PC',
    to_jsonb(array[
      'pet grooming products brand India D2C',
      'pet care startup India small',
      'pet accessories brand India Instagram',
      'Shark Tank India pet care brand',
      'pet wellness brand India site:yourstory.com']),
    to_jsonb(array['Heads Up For Tails','Supertails','Wiggles','Zigly']),
    'Starter config â€” refine per run learnings.'),

  ('Organic Food', 'organic-food', 'OF',
    to_jsonb(array[
      'organic food D2C brand India',
      'organic staples startup India',
      'cold pressed oil small brand India',
      'farm to home organic brand India Instagram',
      'organic food brand India site:yourstory.com']),
    to_jsonb(array['24 Mantra','Organic India','Conscious Food','Pro Nature','Organic Tattva']),
    'Starter config â€” refine per run learnings.'),

  ('Millets', 'millets', 'ML',
    to_jsonb(array[
      'best millet snack D2C brands India',
      'millet breakfast brand startup India',
      'Shark Tank India millet brand',
      'emerging millet brands India site:yourstory.com',
      'ragi jowar snacks small brand India',
      'millet cookies brand India Instagram']),
    to_jsonb(array['Tata Soulfull','Slurrp Farm','Troo Good','True Elements','24 Mantra','Manna','Nourish You']),
    'August 2026 manual millet run is the reference method (PRD Â§1).'),

  ('Snacks', 'snacks', 'SN',
    to_jsonb(array[
      'healthy snacks D2C brand India',
      'makhana snacks brand India',
      'Shark Tank India snacks brand',
      'protein snacks startup India Instagram',
      'clean label snacks brand India site:yourstory.com']),
    to_jsonb(array['Haldiram''s','Too Yumm','Farmley','Happilo','The Whole Truth','Yoga Bar','Open Secret']),
    'Starter config â€” refine per run learnings.'),

  ('Agritech', 'agritech', 'AT',
    to_jsonb(array[
      'agritech D2C startup India',
      'hydroponics brand India small',
      'urban gardening brand India Instagram',
      'farm inputs startup India',
      'agritech brand India site:yourstory.com']),
    to_jsonb(array['DeHaat','Ninjacart','BigHaat','AgroStar']),
    'Starter config â€” refine per run learnings.'),

  ('Healthy Supplements', 'healthy-supplements', 'HS',
    to_jsonb(array[
      'new ayurvedic supplement D2C brand India',
      'protein supplement startup India Shark Tank',
      'wellness gummies brand India D2C',
      'gut health supplement brand India',
      'emerging nutraceutical brands India site:yourstory.com']),
    to_jsonb(array['HealthKart','MuscleBlaze','Oziva','Wellbeing Nutrition','Plix','Kapiva','The Whole Truth','Man Matters']),
    'Sub-categories per allotment sheet: Multivitamins, Gummies, Gut health, Protein.'),

  ('Silver Jewellery', 'silver-jewellery', 'SJ',
    to_jsonb(array[
      'silver jewellery D2C brand India',
      '925 silver jewellery startup India Instagram',
      'handcrafted silver jewellery brand India',
      'Shark Tank India jewellery brand',
      'silver jewellery brand India site:yourstory.com']),
    to_jsonb(array['GIVA','CaratLane','BlueStone','Tanishq','Shaya','Palmonas']),
    'Starter config â€” refine per run learnings.'),

  ('Jewellery (excl. Silver)', 'jewellery', 'JW',
    to_jsonb(array[
      'demi-fine jewellery brand India D2C',
      'gold plated jewellery brand India Instagram',
      'anti tarnish jewellery startup India',
      'artificial jewellery small brand India',
      'jewellery brand India Shark Tank']),
    to_jsonb(array['Tanishq','CaratLane','BlueStone','GIVA','Melorra','Salty']),
    'Everything except silver (silver is its own industry, code SJ).'),

  ('Fast Fashion', 'fast-fashion', 'FF',
    to_jsonb(array[
      'fast fashion D2C brand India',
      'gen z fashion brand India Instagram',
      'trendy womenswear startup India',
      'streetwear small brand India',
      'fashion brand India Shark Tank']),
    to_jsonb(array['Urbanic','NEWME','Snitch','Bewakoof','The Souled Store','Zudio','Shein']),
    'Starter config â€” refine per run learnings.'),

  ('Clothing â€” Athleisure', 'clothing-athleisure', 'AL',
    to_jsonb(array[
      'athleisure brand India D2C',
      'activewear startup India Instagram',
      'gym wear small brand India',
      'yoga wear brand India',
      'athleisure brand India Shark Tank']),
    to_jsonb(array['HRX','Cultsport','BlissClub','Kica','Technosport']),
    'Parent: Clothing (Men/Women).'),

  ('Clothing â€” Formal', 'clothing-formal', 'FR',
    to_jsonb(array[
      'formal wear D2C brand India',
      'men''s formal shirts startup India',
      'workwear clothing brand India Instagram',
      'premium formal wear small brand India']),
    to_jsonb(array['Louis Philippe','Van Heusen','Arrow','Peter England','FableStreet']),
    'Parent: Clothing (Men/Women).'),

  ('Clothing â€” Party', 'clothing-party', 'PY',
    to_jsonb(array[
      'party wear brand India D2C',
      'occasion wear startup India Instagram',
      'sequin dresses brand India',
      'party wear small brand India site:yourstory.com']),
    to_jsonb(array['FabAlley','RSVP by Nykaa','Ritu Kumar']),
    'Parent: Clothing (Men/Women).'),

  ('Clothing â€” Casual', 'clothing-casual', 'CS',
    to_jsonb(array[
      'casual wear D2C brand India',
      'everyday essentials clothing brand India',
      't-shirt small brand India Instagram',
      'casual clothing brand India Shark Tank']),
    to_jsonb(array['Bewakoof','The Souled Store','XYXX','DaMENSCH','The Pant Project']),
    'Parent: Clothing (Men/Women).'),

  ('Clothing â€” Accessories', 'clothing-accessories', 'AC',
    to_jsonb(array[
      'fashion accessories brand India D2C',
      'bags small brand India Instagram',
      'scarves accessories startup India',
      'belts wallets D2C brand India']),
    to_jsonb(array['Zouk','Lavie','Hidesign','DailyObjects','Mokobara']),
    'Parent: Clothing (Men/Women).'),

  ('Bamboo', 'bamboo', 'BM',
    to_jsonb(array[
      'bamboo products D2C brand India',
      'sustainable bamboo startup India',
      'bamboo home products brand India Shark Tank',
      'eco friendly bamboo brand India Instagram',
      'bamboo lifestyle brand India site:yourstory.com']),
    to_jsonb(array['Beco','Bamboo India']),
    'Starter config â€” refine per run learnings.'),

  ('FinTech', 'fintech', 'FT',
    to_jsonb(array[
      'fintech startup India early stage',
      'personal finance app India small',
      'SME fintech tools India',
      'fintech brand India site:yourstory.com',
      'fintech startup India Shark Tank']),
    to_jsonb(array['Paytm','PhonePe','Groww','Zerodha','CRED','Jupiter','Fi Money']),
    'Starter config â€” refine per run learnings.'),

  ('Personal Care â€” Hair Care', 'hair-care', 'HC',
    to_jsonb(array[
      'new hair care D2C brand India',
      'ayurvedic hair oil startup brand India',
      'sulphate free hair care small brand India Instagram',
      'emerging shampoo brand India site:yourstory.com',
      'hair care brand India Shark Tank']),
    to_jsonb(array['Mamaearth','WOW Skin Science','Traya','Bare Anatomy','Arata','Pilgrim']),
    'Parent: Personal Care.'),

  ('Personal Care â€” Skin Care', 'skin-care', 'SC',
    to_jsonb(array[
      'skincare D2C small brand India',
      'ayurvedic skincare startup India',
      'clean beauty brand India Instagram',
      'skincare brand India Shark Tank',
      'dermocosmetics small brand India']),
    to_jsonb(array['Mamaearth','Minimalist','Plum','Dot & Key','Foxtale','mCaffeine','The Derma Co']),
    'Parent: Personal Care.'),

  ('Personal Care â€” Intimate Care/FemTech', 'intimate-care-femtech', 'IC',
    to_jsonb(array[
      'femtech brand India',
      'intimate hygiene brand India D2C',
      'period care startup India Instagram',
      'menstrual products small brand India']),
    to_jsonb(array['Sirona','Pee Safe','Nua','Carmesi','Plush']),
    'Parent: Personal Care.'),

  ('EV Brands', 'ev-brands', 'EV',
    to_jsonb(array[
      'EV accessories startup India D2C',
      'electric scooter small brand India',
      'EV charging accessories brand India',
      'electric mobility startup India Shark Tank',
      'e-bike D2C brand India site:yourstory.com']),
    to_jsonb(array['Ola Electric','Ather','TVS','Bajaj','Hero Electric','Ultraviolette','Simple Energy']),
    'Starter config â€” refine per run learnings.'),

  ('Health & Wellness Clinics', 'health-wellness-clinics', 'HW',
    to_jsonb(array[
      'wellness clinic chain India small',
      'ayurveda clinic brand India',
      'physiotherapy clinic brand India',
      'skin clinic brand India Instagram',
      'wellness centre India site:yourstory.com']),
    to_jsonb(array['Kaya Clinic','VLCC','Dr Batra''s','Apollo Clinics','Ujala Cygnus']),
    'Starter config â€” refine per run learnings.'),

  ('Footwear', 'footwear', 'FW',
    to_jsonb(array[
      'footwear D2C small brand India',
      'sneaker brand India Instagram',
      'sustainable footwear startup India',
      'footwear brand India Shark Tank']),
    to_jsonb(array['Bata','Relaxo','Campus','Neeman''s','Yoho','Comet']),
    'Starter config â€” refine per run learnings.'),

  ('Home Decor & Furnishing', 'home-decor-furnishing', 'DF',
    to_jsonb(array[
      'home decor D2C small brand India',
      'handcrafted furnishing brand startup India',
      'new home textile brand India site:yourstory.com',
      'decor brand India Shark Tank',
      'artisanal home decor brand India Instagram']),
    to_jsonb(array['Pepperfry','Urban Ladder','Wakefit','HomeTown','Nestasia','Chumbak','Ellementry']),
    'Starter config â€” refine per run learnings.'),

  ('Toys & Games', 'toys-games', 'TG',
    to_jsonb(array[
      'toys D2C brand India',
      'educational toys startup India',
      'board games brand India Instagram',
      'STEM toys small brand India',
      'kids toys brand India Shark Tank']),
    to_jsonb(array['Funskool','LEGO','Hamleys','Smartivity','Skillmatics','PlayShifu']),
    'Starter config â€” refine per run learnings.'),

  ('CleanTech & Environment', 'cleantech-environment', 'CE',
    to_jsonb(array[
      'cleantech D2C startup India',
      'zero waste brand India D2C',
      'upcycled products startup India Shark Tank',
      'compostable products brand India',
      'sustainable living brand India site:yourstory.com']),
    to_jsonb(array['Beco','Bare Necessities','EcoSoul Home']),
    'Starter config â€” refine per run learnings.')
) as x(name, slug, code, seed_queries, exclusions, notes)
on conflict (slug) do nothing;

-- â”€â”€ admin's own assignments (allotment sheet: Pragaman) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- ML, HS, BM, HC, EV, DF, CE
insert into public.assignments (industry_id, user_id, assigned_by)
select i.id, u.id, u.id
from public.industries i
join public.users u on u.email = 'build.noboruworld@gmail.com'
where i.slug in (
  'millets', 'healthy-supplements', 'bamboo', 'hair-care',
  'ev-brands', 'home-decor-furnishing', 'cleantech-environment'
)
on conflict do nothing;

-- ============================================================================
-- Noboru Prospector — Migration 1: extensions, enum types, normalizers
-- PRD §7 (dedup keys), §8 (data model)
-- ============================================================================

-- Trigram similarity for fuzzy name matching (PRD §7 key 3)
create extension if not exists pg_trgm;

-- ── Enum types ──────────────────────────────────────────────────────────────

create type public.user_role as enum ('admin', 'member');

create type public.company_status as enum
  ('draft', 'approved', 'rejected', 'enriched', 'synced');

-- PRD §6.3 Digital-Presence Classifier
create type public.digital_presence as enum
  ('WEB_ACTIVE', 'WEB_THIN', 'AMAZON_ONLY', 'IG_ONLY', 'NONE');

create type public.confidence_level as enum ('high', 'med', 'low');

create type public.contact_role_type as enum ('founder', 'marketing', 'other');

-- Contact channels are 'verified' only when they come from an enrichment API;
-- 'public_generic' when lifted from the brand's own public pages (PRD §6.1).
create type public.contact_channel_status as enum
  ('verified', 'public_generic', 'unknown');

create type public.contact_source as enum ('research', 'lusha', 'apollo', 'manual');

create type public.run_stage as enum
  ('seed', 'discover', 'qualify', 'score', 'done', 'failed');

create type public.sync_status as enum ('success', 'error');

-- ── Normalizers (PRD §7 — dedup keys) ───────────────────────────────────────
-- Immutable so they can back generated columns; duplicated in
-- src/lib/normalize.ts for the live check-as-you-type UI. Keep both in sync.

-- strip protocol, www., path/query/fragment, lowercase; empty → null
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

-- accept "@handle", "handle", or a full instagram.com URL; lowercase; empty → null
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

-- lowercase, strip punctuation, collapse whitespace; empty → null
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

-- ── updated_at maintenance ──────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

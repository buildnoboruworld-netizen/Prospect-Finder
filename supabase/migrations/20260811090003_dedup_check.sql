-- ============================================================================
-- Noboru Prospector — Migration 3: dedup check RPC (PRD §7)
-- Used by manual-add live check-as-you-type and re-checked at save time.
-- Exact domain / instagram matches BLOCK; fuzzy name+city matches FLAG for
-- human confirmation — never auto-merge.
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

  -- fuzzy name (+ city when both known) — trigram similarity ≥ 0.85 (PRD §7)
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

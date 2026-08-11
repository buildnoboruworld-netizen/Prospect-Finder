-- ============================================================================
-- Teammate allowlist + industry assignments (allotment sheet, 11 Aug 2026).
-- RUN THIS ONLY AFTER replacing the placeholder emails with each teammate's
-- real Google email. Run in the Supabase SQL editor (or turn into a
-- migration). Safe to re-run — everything is upsert/no-op on conflict.
--
-- Allotment:
--   Neha     → Pet Food, Pet Care, Organic Food, Snacks, Agritech,
--              Jewellery (excl. Silver)
--   Sharmila → Silver Jewellery, Fast Fashion, Clothing—Athleisure,
--              Clothing—Casual, Clothing—Accessories, Skin Care,
--              Intimate Care/FemTech
--   Aryan    → Clothing—Formal, Clothing—Party, FinTech,
--              Health & Wellness Clinics, Footwear, Toys & Games
--   (Pragaman's 7 are already seeded by migration 0004.)
-- ============================================================================

-- 1) Teammate emails (supplied 11 Aug 2026; APPLIED to the live DB the same
--    day via the service API — keep this file as the canonical record).
insert into public.users (email, name, role, active) values
  ('nehasree@noboruworld.com',    'Neha',     'member', true),
  ('performance@noboruworld.com', 'Sharmila', 'member', true),
  ('aryan@noboruworld.com',       'Aryan',    'member', true)
on conflict (email) do nothing;

-- 2) Assignments (keyed by name → industry slugs; assigned_by = Pragaman).
with allot(user_name, slug) as (
  values
    ('Neha', 'pet-food'),
    ('Neha', 'pet-care'),
    ('Neha', 'organic-food'),
    ('Neha', 'snacks'),
    ('Neha', 'agritech'),
    ('Neha', 'jewellery'),
    ('Sharmila', 'silver-jewellery'),
    ('Sharmila', 'fast-fashion'),
    ('Sharmila', 'clothing-athleisure'),
    ('Sharmila', 'clothing-casual'),
    ('Sharmila', 'clothing-accessories'),
    ('Sharmila', 'skin-care'),
    ('Sharmila', 'intimate-care-femtech'),
    ('Aryan', 'clothing-formal'),
    ('Aryan', 'clothing-party'),
    ('Aryan', 'fintech'),
    ('Aryan', 'health-wellness-clinics'),
    ('Aryan', 'footwear'),
    ('Aryan', 'toys-games')
)
insert into public.assignments (industry_id, user_id, assigned_by)
select i.id, u.id, admin.id
from allot a
join public.industries i on i.slug = a.slug
join public.users u on u.name = a.user_name and u.role = 'member'
join public.users admin on admin.email = 'build.noboruworld@gmail.com'
on conflict do nothing;

-- 3) Verify:
-- select u.name, i.code, i.name from public.assignments s
-- join public.users u on u.id = s.user_id
-- join public.industries i on i.id = s.industry_id
-- where s.active order by u.name, i.code;

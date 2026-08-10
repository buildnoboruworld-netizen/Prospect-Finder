-- ============================================================================
-- Noboru Prospector — Migration 4: seed data
-- 7 industries with starter icp_config (PRD §6.1 pattern) + admin user.
-- Exclusion lists = brands too big for the ₹40–50K retainer ICP; starter
-- lists only — admin refines them over time (ICP Studio, Phase 4).
-- ============================================================================

-- ── admin (Pragaman) — the login allowlist seed ─────────────────────────────
insert into public.users (email, name, role, active)
values ('build.noboruworld@gmail.com', 'Pragaman', 'admin', true)
on conflict (email) do update set role = 'admin', active = true;

-- ── industries ──────────────────────────────────────────────────────────────
insert into public.industries (name, slug, icp_config) values
(
  'Millets', 'millets',
  jsonb_build_object(
    'revenue_band', '₹50L–₹10Cr annual',
    'follower_band', '2k–100k',
    'ticket_context', 'can afford ₹40–50K/month organic-growth retainer',
    'seed_queries', to_jsonb(array[
      'best millet snack D2C brands India',
      'millet breakfast brand startup India',
      'Shark Tank India millet brand',
      'emerging millet brands India site:yourstory.com',
      'ragi jowar snacks small brand India',
      'millet cookies brand India Instagram'
    ]),
    'exclusions', to_jsonb(array[
      'Tata Soulfull', 'Slurrp Farm', 'Troo Good', 'True Elements',
      '24 Mantra', 'Manna', 'Nourish You'
    ]),
    'notes', 'August 2026 manual millet run is the reference method (PRD §1). Starter config — refine per run learnings.'
  )
),
(
  'Healthy Supplements', 'healthy-supplements',
  jsonb_build_object(
    'revenue_band', '₹50L–₹10Cr annual',
    'follower_band', '2k–100k',
    'ticket_context', 'can afford ₹40–50K/month organic-growth retainer',
    'seed_queries', to_jsonb(array[
      'new ayurvedic supplement D2C brand India',
      'protein supplement startup India Shark Tank',
      'wellness gummies brand India D2C',
      'emerging nutraceutical brands India site:yourstory.com',
      'plant protein small brand India Instagram'
    ]),
    'exclusions', to_jsonb(array[
      'HealthKart', 'MuscleBlaze', 'Oziva', 'Wellbeing Nutrition',
      'Plix', 'Kapiva', 'The Whole Truth', 'Man Matters'
    ]),
    'notes', 'Starter config — refine in ICP Studio.'
  )
),
(
  'Bamboo', 'bamboo',
  jsonb_build_object(
    'revenue_band', '₹50L–₹10Cr annual',
    'follower_band', '2k–100k',
    'ticket_context', 'can afford ₹40–50K/month organic-growth retainer',
    'seed_queries', to_jsonb(array[
      'bamboo products D2C brand India',
      'sustainable bamboo startup India',
      'bamboo home products brand India Shark Tank',
      'eco friendly bamboo brand India Instagram',
      'bamboo lifestyle brand India site:yourstory.com'
    ]),
    'exclusions', to_jsonb(array['Beco', 'Bamboo India']),
    'notes', 'Starter config — refine in ICP Studio.'
  )
),
(
  'Personal Care / Hair Care', 'personal-care-hair-care',
  jsonb_build_object(
    'revenue_band', '₹50L–₹10Cr annual',
    'follower_band', '2k–100k',
    'ticket_context', 'can afford ₹40–50K/month organic-growth retainer',
    'seed_queries', to_jsonb(array[
      'new hair care D2C brand India',
      'ayurvedic hair oil startup brand India',
      'clean beauty personal care brand India Shark Tank',
      'emerging shampoo brand India site:yourstory.com',
      'sulphate free hair care small brand India Instagram'
    ]),
    'exclusions', to_jsonb(array[
      'Mamaearth', 'WOW Skin Science', 'mCaffeine', 'Plum', 'Pilgrim',
      'Bare Anatomy', 'Traya', 'Minimalist'
    ]),
    'notes', 'Starter config — refine in ICP Studio.'
  )
),
(
  'EV Brands', 'ev-brands',
  jsonb_build_object(
    'revenue_band', '₹50L–₹20Cr annual',
    'follower_band', '2k–100k',
    'ticket_context', 'can afford ₹40–50K/month organic-growth retainer',
    'seed_queries', to_jsonb(array[
      'EV accessories startup India D2C',
      'electric scooter small brand India',
      'EV charging accessories brand India',
      'electric mobility startup India Shark Tank',
      'e-bike D2C brand India site:yourstory.com'
    ]),
    'exclusions', to_jsonb(array[
      'Ola Electric', 'Ather', 'TVS', 'Bajaj', 'Hero Electric',
      'Ultraviolette', 'Simple Energy'
    ]),
    'notes', 'Starter config — refine in ICP Studio.'
  )
),
(
  'Home Decor & Furnishing', 'home-decor-furnishing',
  jsonb_build_object(
    'revenue_band', '₹50L–₹10Cr annual',
    'follower_band', '2k–100k',
    'ticket_context', 'can afford ₹40–50K/month organic-growth retainer',
    'seed_queries', to_jsonb(array[
      'home decor D2C small brand India',
      'handcrafted furnishing brand startup India',
      'new home textile brand India site:yourstory.com',
      'decor brand India Shark Tank',
      'artisanal home decor brand India Instagram'
    ]),
    'exclusions', to_jsonb(array[
      'Pepperfry', 'Urban Ladder', 'Wakefit', 'HomeTown',
      'Nestasia', 'Chumbak', 'Ellementry'
    ]),
    'notes', 'Starter config — refine in ICP Studio.'
  )
),
(
  'CleanTech & Environment', 'cleantech-environment',
  jsonb_build_object(
    'revenue_band', '₹50L–₹10Cr annual',
    'follower_band', '2k–100k',
    'ticket_context', 'can afford ₹40–50K/month organic-growth retainer',
    'seed_queries', to_jsonb(array[
      'cleantech D2C startup India',
      'zero waste brand India D2C',
      'upcycled products startup India Shark Tank',
      'compostable products brand India',
      'sustainable living brand India site:yourstory.com'
    ]),
    'exclusions', to_jsonb(array['Beco', 'Bare Necessities', 'EcoSoul Home']),
    'notes', 'Starter config — refine in ICP Studio.'
  )
)
on conflict (slug) do nothing;

-- ── assignments ─────────────────────────────────────────────────────────────
-- Seeded once Pragaman supplies the teammate ⇄ industry allotment list.
-- Template (also usable from the admin UI later):
--
-- insert into public.users (email, name, role) values
--   ('teammate@gmail.com', 'Teammate Name', 'member')
-- on conflict (email) do nothing;
--
-- insert into public.assignments (industry_id, user_id, assigned_by)
-- select i.id, u.id, a.id
-- from public.industries i,
--      public.users u,
--      public.users a
-- where i.slug = 'millets'
--   and u.email = 'teammate@gmail.com'
--   and a.email = 'build.noboruworld@gmail.com'
-- on conflict do nothing;

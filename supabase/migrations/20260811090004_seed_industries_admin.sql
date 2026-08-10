-- ============================================================================
-- Noboru Prospector — Migration 4: seed data
-- Full 26-industry allotment sheet (11 Aug 2026) + admin user + admin's
-- assignments. Sub-industries (Clothing, Personal Care) are flattened into
-- their own rows since each is separately assignable and researchable.
-- Exclusion lists = brands too big for the ₹40–50K retainer ICP; starter
-- lists only — admin refines them over time (ICP Studio, Phase 4).
--
-- Teammates (Neha, Sharmila, Aryan) are seeded later when their Google
-- emails exist — template in scripts/seed-teammates.sql.
-- ============================================================================

-- ── admin (Pragaman) — the login allowlist seed ─────────────────────────────
insert into public.users (email, name, role, active)
values ('build.noboruworld@gmail.com', 'Pragaman', 'admin', true)
on conflict (email) do update set role = 'admin', active = true;

-- ── industries (shared starter bands) ───────────────────────────────────────
-- jsonb shape: revenue_band, follower_band, ticket_context, seed_queries[],
-- exclusions[], notes
with base as (
  select
    '₹50L–₹10Cr annual'::text as revenue_band,
    '2k–100k'::text as follower_band,
    'can afford ₹40–50K/month organic-growth retainer'::text as ticket_context
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
    'Starter config — refine per run learnings.'),

  ('Pet Care', 'pet-care', 'PC',
    to_jsonb(array[
      'pet grooming products brand India D2C',
      'pet care startup India small',
      'pet accessories brand India Instagram',
      'Shark Tank India pet care brand',
      'pet wellness brand India site:yourstory.com']),
    to_jsonb(array['Heads Up For Tails','Supertails','Wiggles','Zigly']),
    'Starter config — refine per run learnings.'),

  ('Organic Food', 'organic-food', 'OF',
    to_jsonb(array[
      'organic food D2C brand India',
      'organic staples startup India',
      'cold pressed oil small brand India',
      'farm to home organic brand India Instagram',
      'organic food brand India site:yourstory.com']),
    to_jsonb(array['24 Mantra','Organic India','Conscious Food','Pro Nature','Organic Tattva']),
    'Starter config — refine per run learnings.'),

  ('Millets', 'millets', 'ML',
    to_jsonb(array[
      'best millet snack D2C brands India',
      'millet breakfast brand startup India',
      'Shark Tank India millet brand',
      'emerging millet brands India site:yourstory.com',
      'ragi jowar snacks small brand India',
      'millet cookies brand India Instagram']),
    to_jsonb(array['Tata Soulfull','Slurrp Farm','Troo Good','True Elements','24 Mantra','Manna','Nourish You']),
    'August 2026 manual millet run is the reference method (PRD §1).'),

  ('Snacks', 'snacks', 'SN',
    to_jsonb(array[
      'healthy snacks D2C brand India',
      'makhana snacks brand India',
      'Shark Tank India snacks brand',
      'protein snacks startup India Instagram',
      'clean label snacks brand India site:yourstory.com']),
    to_jsonb(array['Haldiram''s','Too Yumm','Farmley','Happilo','The Whole Truth','Yoga Bar','Open Secret']),
    'Starter config — refine per run learnings.'),

  ('Agritech', 'agritech', 'AT',
    to_jsonb(array[
      'agritech D2C startup India',
      'hydroponics brand India small',
      'urban gardening brand India Instagram',
      'farm inputs startup India',
      'agritech brand India site:yourstory.com']),
    to_jsonb(array['DeHaat','Ninjacart','BigHaat','AgroStar']),
    'Starter config — refine per run learnings.'),

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
    'Starter config — refine per run learnings.'),

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
    'Starter config — refine per run learnings.'),

  ('Clothing — Athleisure', 'clothing-athleisure', 'AL',
    to_jsonb(array[
      'athleisure brand India D2C',
      'activewear startup India Instagram',
      'gym wear small brand India',
      'yoga wear brand India',
      'athleisure brand India Shark Tank']),
    to_jsonb(array['HRX','Cultsport','BlissClub','Kica','Technosport']),
    'Parent: Clothing (Men/Women).'),

  ('Clothing — Formal', 'clothing-formal', 'FR',
    to_jsonb(array[
      'formal wear D2C brand India',
      'men''s formal shirts startup India',
      'workwear clothing brand India Instagram',
      'premium formal wear small brand India']),
    to_jsonb(array['Louis Philippe','Van Heusen','Arrow','Peter England','FableStreet']),
    'Parent: Clothing (Men/Women).'),

  ('Clothing — Party', 'clothing-party', 'PY',
    to_jsonb(array[
      'party wear brand India D2C',
      'occasion wear startup India Instagram',
      'sequin dresses brand India',
      'party wear small brand India site:yourstory.com']),
    to_jsonb(array['FabAlley','RSVP by Nykaa','Ritu Kumar']),
    'Parent: Clothing (Men/Women).'),

  ('Clothing — Casual', 'clothing-casual', 'CS',
    to_jsonb(array[
      'casual wear D2C brand India',
      'everyday essentials clothing brand India',
      't-shirt small brand India Instagram',
      'casual clothing brand India Shark Tank']),
    to_jsonb(array['Bewakoof','The Souled Store','XYXX','DaMENSCH','The Pant Project']),
    'Parent: Clothing (Men/Women).'),

  ('Clothing — Accessories', 'clothing-accessories', 'AC',
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
    'Starter config — refine per run learnings.'),

  ('FinTech', 'fintech', 'FT',
    to_jsonb(array[
      'fintech startup India early stage',
      'personal finance app India small',
      'SME fintech tools India',
      'fintech brand India site:yourstory.com',
      'fintech startup India Shark Tank']),
    to_jsonb(array['Paytm','PhonePe','Groww','Zerodha','CRED','Jupiter','Fi Money']),
    'Starter config — refine per run learnings.'),

  ('Personal Care — Hair Care', 'hair-care', 'HC',
    to_jsonb(array[
      'new hair care D2C brand India',
      'ayurvedic hair oil startup brand India',
      'sulphate free hair care small brand India Instagram',
      'emerging shampoo brand India site:yourstory.com',
      'hair care brand India Shark Tank']),
    to_jsonb(array['Mamaearth','WOW Skin Science','Traya','Bare Anatomy','Arata','Pilgrim']),
    'Parent: Personal Care.'),

  ('Personal Care — Skin Care', 'skin-care', 'SC',
    to_jsonb(array[
      'skincare D2C small brand India',
      'ayurvedic skincare startup India',
      'clean beauty brand India Instagram',
      'skincare brand India Shark Tank',
      'dermocosmetics small brand India']),
    to_jsonb(array['Mamaearth','Minimalist','Plum','Dot & Key','Foxtale','mCaffeine','The Derma Co']),
    'Parent: Personal Care.'),

  ('Personal Care — Intimate Care/FemTech', 'intimate-care-femtech', 'IC',
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
    'Starter config — refine per run learnings.'),

  ('Health & Wellness Clinics', 'health-wellness-clinics', 'HW',
    to_jsonb(array[
      'wellness clinic chain India small',
      'ayurveda clinic brand India',
      'physiotherapy clinic brand India',
      'skin clinic brand India Instagram',
      'wellness centre India site:yourstory.com']),
    to_jsonb(array['Kaya Clinic','VLCC','Dr Batra''s','Apollo Clinics','Ujala Cygnus']),
    'Starter config — refine per run learnings.'),

  ('Footwear', 'footwear', 'FW',
    to_jsonb(array[
      'footwear D2C small brand India',
      'sneaker brand India Instagram',
      'sustainable footwear startup India',
      'footwear brand India Shark Tank']),
    to_jsonb(array['Bata','Relaxo','Campus','Neeman''s','Yoho','Comet']),
    'Starter config — refine per run learnings.'),

  ('Home Decor & Furnishing', 'home-decor-furnishing', 'DF',
    to_jsonb(array[
      'home decor D2C small brand India',
      'handcrafted furnishing brand startup India',
      'new home textile brand India site:yourstory.com',
      'decor brand India Shark Tank',
      'artisanal home decor brand India Instagram']),
    to_jsonb(array['Pepperfry','Urban Ladder','Wakefit','HomeTown','Nestasia','Chumbak','Ellementry']),
    'Starter config — refine per run learnings.'),

  ('Toys & Games', 'toys-games', 'TG',
    to_jsonb(array[
      'toys D2C brand India',
      'educational toys startup India',
      'board games brand India Instagram',
      'STEM toys small brand India',
      'kids toys brand India Shark Tank']),
    to_jsonb(array['Funskool','LEGO','Hamleys','Smartivity','Skillmatics','PlayShifu']),
    'Starter config — refine per run learnings.'),

  ('CleanTech & Environment', 'cleantech-environment', 'CE',
    to_jsonb(array[
      'cleantech D2C startup India',
      'zero waste brand India D2C',
      'upcycled products startup India Shark Tank',
      'compostable products brand India',
      'sustainable living brand India site:yourstory.com']),
    to_jsonb(array['Beco','Bare Necessities','EcoSoul Home']),
    'Starter config — refine per run learnings.')
) as x(name, slug, code, seed_queries, exclusions, notes)
on conflict (slug) do nothing;

-- ── admin's own assignments (allotment sheet: Pragaman) ─────────────────────
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

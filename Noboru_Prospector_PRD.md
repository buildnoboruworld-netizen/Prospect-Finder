# Noboru Prospector — Product Requirements Document

**Version 1.0 · 10 Aug 2026 · Owner: Pragaman (Product & Growth, Noboru World)**
**Status: Draft for team review**

* * *

## 1\. Problem Statement

Noboru World sells organic \+ AI\-search discovery (SEO · content · GEO · AEO) to small D2C brands at a \~₹40–50K/month retainer. Winning clients requires a steady pipeline of qualified prospects — small brands, per industry, that can afford the retainer and have an obvious discovery gap. Today that research is manual, slow (\~half a day per industry when done well), inconsistent across teammates, and produces duplicate or unverified leads. The August millet run proved the method works; this product makes it repeatable by anyone on the team in minutes, not hours.

**Cost of not solving:** teammates burn selling hours on research, outreach quality varies by who researched, duplicate outreach to the same brand damages Noboru's credibility, and the prospect database rots in ad\-hoc sheets.

## 2\. Goals

| \# | Goal | Target |
| --- | --- | --- |
| G1 | A teammate turns an industry input into a reviewed, ICP\-fit prospect list | 15–20 approved leads in ≤ 30 min (incl. human review) |
| G2 | Zero duplicate outreach | 100% of saves pass dedup check; 0 repeated companies across the team |
| G3 | Contactability | ≥ 80% of approved leads have ≥ 1 usable contact channel; ≥ 50% have a named founder or marketing contact after enrichment |
| G4 | Cost discipline | ≤ ₹25 average cost per approved lead (research \+ enrichment credits) |
| G5 | Team adoption | All teammates run their allotted industries weekly by week 2 post\-launch |

## 3\. Non\-Goals (v1)

- **Not an outreach/sequencing tool.** No email sending, DM automation, or cadences — outreach stays in existing channels. (Future: outreach status tracking only.)
- **Not a CRM.** No deal stages, notes threads, or revenue tracking. The Google Sheet \+ this app's statuses are enough for v1.
- **No LinkedIn scraping.** Founder names come from public press, registries, and brand sites; verified contact data comes from enrichment APIs. This keeps us compliant with platform ToS.
- **No auto\-send of anything.** Every lead is human\-approved before it exists in the master list.
- **Not multi\-tenant.** Internal Noboru tool only; no client access.

## 4\. Users & Roles

| Role | Who | Can do |
| --- | --- | --- |
| **Admin** | Pragaman | Everything: manage teammates, assign/reassign industries, edit ICP configs & exclusion lists, view all pipelines, manage API keys, force sheet re\-sync |
| **Member** | Teammates | Run research on their allotted industries, review/approve/reject leads, trigger enrichment, add manual leads, view own pipeline \+ read\-only view of others (for cross\-reachout awareness) |

Auth: Google sign\-in (Supabase Auth) restricted to an admin\-managed email allowlist.

## 5\. User Stories (priority order)

**Member**

1. As a member, I want to enter/select my allotted industry and hit **Run** so that the system researches 15–20 ICP\-fit companies for me automatically.
2. As a member, I want to watch run progress live (stage \+ companies found so far) so that I know it's working and can review early results immediately.
3. As a member, I want each drafted lead to show its **sources** (URLs), fit score, and digital\-presence flag so that I can verify before approving.
4. As a member, I want to **approve / edit / reject** each drafted lead so that only verified leads reach the master list.
5. As a member, I want to click **Enrich** on an approved lead so that founder \+ marketing contacts (email, phone) are fetched via Lusha/Apollo without me leaving the app.
6. As a member, I want to add a company manually (found on Instagram/Amazon) and have the app instantly tell me if it already exists so that I never duplicate a teammate's lead.
7. As a member, I want multiple contacts per company (founder \+ marketing head) so that outreach can go to the right person per message.
8. As a member, I want rejected companies remembered so that future runs never surface them again.

**Admin**
9\. As an admin, I want to assign industries to teammates and **reassign them later** so that cross\-reachout is controlled, not chaotic.
10\. As an admin, I want a dashboard (leads by industry, by owner, by status, enrichment hit\-rate, spend) so that I can steer the prospecting effort.
11\. As an admin, I want to edit each industry's **ICP config** (revenue band, follower band, exclusion list of big brands, seed queries) so that research quality improves over time without code changes.
12\. As an admin, I want every approved/enriched lead to auto\-appear in our Google Sheet so that the team's existing workflow keeps working.

**Edge cases**
13\. As a member, when a run finds \< 15 ICP\-fit companies, I want the run to say so honestly (with what it excluded and why) rather than pad the list with bad fits.
14\. As a member, when enrichment finds no verified contact, I want the lead kept with its public/generic contact \+ Instagram channel flagged as the outreach path.
15\. As a member, when two brands share a name, I want dedup keyed on domain/handle so that distinct companies aren't wrongly merged.

## 6\. System Architecture

```
┌──────────────────────────── Next.js app on Vercel ───────────────────────────┐
│  UI: Run · Review Queue · Pipeline · Admin (assignments, ICP, dashboard)     │
│  API routes:                                                                 │
│   /api/runs/*        → Layer 1: Research Engine (Claude API + web search)    │
│   /api/enrich/*      → Layer 2: Enrichment Adapter (Lusha ⇄ Apollo)          │
│   /api/sheets/sync   → Google Sheets one-way sync                            │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │  Supabase (Postgres + Auth + RLS)  ←— source of truth
               │  Google Sheet  ←— team-facing mirror (one-way DB → Sheet)
```

**Layer 1 — Research Engine (find \+ qualify).** Claude API (Sonnet 5) with the web\-search tool replicates the manual millet\-run method. It CANNOT verify emails/phones — it never invents them.
**Layer 2 — Enrichment Adapter (contact reveal).** A vendor\-agnostic interface with two implementations. Whichever subscription lands, it plugs in via env config; both can run in "waterfall" (try A, fall back to B).

### 6\.1 Research Engine pipeline (stage\-based, Vercel\-safe)

Each run is a row in `runs`; each stage is a separate ≤60s API call; state persists between stages so runs are resumable and progress is visible live.

| Stage | What happens | Output |
| --- | --- | --- |
| 1\. Seed | Build search plan from ICP config (seed queries \+ exclusion list \+ all existing company names/domains in this industry) | Query plan |
| 2\. Discover | Web searches across Google/press/lists/Shark\-Tank sources; extract candidate brands; drop exclusions \+ dedup vs existing DB **inside the prompt context** | 30–50 candidates |
| 3\. Qualify (per company, parallel batches) | Deep\-dive each candidate: founder name, city, revenue/funding signals, website check, Instagram handle \+ follower band, Amazon presence | Qualified profiles with source URLs |
| 4\. Classify \+ Score | Digital\-presence class, ICP fit score 1–5, one\-line discovery\-gap hook per brand | 15–20 drafted leads → Review Queue |

**Guardrails (non\-negotiable):**

- Emails/phones only from the brand's own public pages (marked `public/generic`) or from the enrichment API (marked `verified`). The model is instructed to output `null` otherwise — never guessed contacts.
- Every factual claim carries ≥ 1 source URL; leads without sources cannot be approved.
- Per\-run budget cap (default $3) enforced via token/search accounting; the run halts gracefully at the cap.
- Exclusion lists per industry (e.g. Millets: Tata Soulfull, Slurrp Farm, Troo Good, True Elements, 24 Mantra…) editable by admin.

### 6\.2 Enrichment Adapter

```ts
interface EnrichmentProvider {
  enrichPerson(input: { name?: string; companyDomain?: string; companyName?: string; title?: string }):
    Promise<{ contacts: Array<{ name, title, email?, emailStatus?, phone?, phoneType?, confidence, source }> , creditsUsed: number }>
  findPeople(input: { companyDomain: string; roles: ('founder'|'marketing')[] }): Promise<PersonStub[]>
}
```

|  | **Lusha** (v3 API) | **Apollo** |
| --- | --- | --- |
| Find people at company | `POST api.lusha.com/v3/contacts/prospecting` (filter search) | `POST api.apollo.io/api/v1/mixed_people/api_search` — **0 credits**, filters incl. `person_seniorities[]` (founder, c\_suite), `q_organization_domains_list[]` |
| Reveal email/phone | `POST v3/contacts/enrich` (reveal `emails` / `phones`; charged **per revealed datapoint**; phone \= 5 credits) | People Enrichment `people/match` (\+bulk); 1 credit per reveal |
| Auth | `api_key` header | `X-Api-Key` header |
| Plan gate | API from **Pro** plan up | API on paid plans (verify reveal limits on Basic during trial) |

Flow per company: `findPeople(domain, [founder, marketing])` → present stubs → user (or auto\-rule) picks which to reveal → `enrichPerson` → contacts saved with `verified` status \+ credits logged. **Credits are only spent on approved leads, never on drafts.**

### 6\.3 Digital\-Presence Classifier (per company, from Stage 4)

| Class | Meaning | Sales meaning |
| --- | --- | --- |
| `WEB_ACTIVE` | Own site, maintained, some content | Standard pitch |
| `WEB_THIN` | Site exists, thin/stale content | Strong pitch: foundation exists, discovery missing |
| `AMAZON_ONLY` | Sells only via Amazon/marketplaces | **Strongest pitch**\: zero owned demand |
| `IG_ONLY` | Instagram storefront only | Strong pitch: social ≠ search |
| `NONE` | No findable digital presence | Usually reject (too early) |

## 7\. Deduplication System (G2)

**Keys, in matching order:**

1. `domain_normalized` (strip protocol/www, lowercase) — unique index
2. `instagram_handle_normalized` — unique index
3. `(name_normalized, city)` fuzzy fallback (trigram similarity ≥ 0.85 → flag for human confirm, don't auto\-merge)

**Enforced at three points:**

1. **Research time** — existing \+ rejected companies for that industry are injected into the Discover prompt as exclusions (prevents wasted qualification spend).
2. **Save time** — DB unique constraints; violation surfaces as "already exists → view owner" (handles races between teammates).
3. **Manual\-add time** — live check\-as\-you\-type on domain/handle/name.

Rejected companies persist with `status=rejected` \+ reason, so they are excluded forever (unless admin un\-rejects). New contacts for an existing company **attach to it** — never a new company row.

## 8\. Data Model (Supabase)

```
users          id, email, name, role(admin|member), active
industries     id, name, slug, icp_config(jsonb: revenue_band, follower_band,
               ticket_context, seed_queries[], exclusions[], notes)
assignments    id, industry_id, user_id, active, assigned_by, created_at   -- history kept, reassignment = new row
companies      id, industry_id, name, name_normalized, domain, domain_normalized,
               instagram_handle, ig_followers_band, city, revenue_estimate,
               funding_stage, shark_tank_status, digital_presence(enum §6.3),
               fit_score(1-5), hook, confidence(high|med|low), sources(jsonb[]),
               status(draft|approved|rejected|enriched|synced), owner_id,
               rejected_reason, created_by_run, timestamps
contacts       id, company_id, full_name, designation, role_type(founder|marketing|other),
               email, email_status(verified|public_generic|unknown),
               phone, phone_status, source(research|lusha|apollo|manual),
               credits_spent, is_primary, timestamps
runs           id, industry_id, user_id, stage(seed|discover|qualify|score|done|failed),
               stage_state(jsonb), candidates_found, leads_drafted, cost_usd,
               tokens_in, tokens_out, searches, error, timestamps
sheet_sync_log id, company_id, sheet_row, synced_at, status
audit_log      id, user_id, action, entity, before, after, at
```

RLS: members read all, write only rows they own; admin writes all. API keys live in Vercel env vars only — never in client code or DB.

## 9\. Google Sheets Sync

- **One\-way: DB → Sheet** (Sheet is the mirror, DB is truth). Two\-way sync is a v2 consideration; it invites conflicts.
- Service\-account credential; Pragaman shares the Sheet with the service\-account email.
- One tab per industry \+ one **Master** tab. Columns \= Pragaman's six core fields first — `Industry, Company, Contact Person, Designation, Email, Phone` — then `Website, Instagram, City, Revenue/Stage, Shark Tank, Fit, Digital Presence, Hook, Confidence, Owner, Status, Sources`.
- Multiple contacts → one row per contact, company fields repeated (flat, filter\-friendly), `is_primary` flagged.
- Sync triggers: on approve, on enrich, nightly full re\-sync, admin "Sync now".

## 10\. Screens (v1)

1. **Login** — Google sign\-in, allowlist gate.
2. **Home / My Industries** — allotted industries, last\-run stats, "Run research" CTA, pipeline counts.
3. **Run view** — live stage progress, candidates streaming in, cost meter, cancel.
4. **Review Queue** — card per drafted lead: all fields, sources as links, fit \+ presence badges; Approve / Edit / Reject(reason). Keyboard\-first.
5. **Pipeline** — table of approved/enriched leads (own \+ read\-only all), filters, "Enrich" action, per\-contact rows.
6. **Company detail** — profile, contacts list, add\-contact, enrichment history, sheet\-sync status, audit trail.
7. **Manual add** — form with live dedup check.
8. **Admin — Assignments** — user ⇄ industry matrix, reassign (history preserved), cross\-reachout grants.
9. **Admin — ICP Studio** — per\-industry config editor (seed queries, exclusions, bands).
10. **Admin — Dashboard** — leads by industry/owner/status, enrichment hit\-rate, spend per lead, credits remaining.

## 11\. Requirements

### P0 — Must\-have (cannot ship without)

| ID | Requirement | Acceptance criteria (Given/When/Then, abridged) |
| --- | --- | --- |
| P0\-1 | Google\-auth login with allowlist \+ roles | Given a non\-allowlisted Google account, when they sign in, then access is denied with a friendly message. |
| P0\-2 | Industry allotment shown per member | Given a member with 2 industries, when they open Home, then exactly those industries show with Run CTAs. |
| P0\-3 | Stage\-based research run producing 15–20 drafted leads with sources, fit, presence class, hook | Given a member hits Run on "Hair Care", when the run completes, then ≥ 15 drafted leads exist, each with ≥ 1 source URL, fit 1–5, presence class, hook; and no drafted lead matches an existing/rejected company. |
| P0\-4 | Honest under\-delivery | Given the ICP yields only 9 fits, when the run completes, then 9 leads \+ an explanation render — no padding. |
| P0\-5 | Review queue (approve/edit/reject with reason) | Given a drafted lead, when rejected with reason, then it never reappears in future runs for that industry. |
| P0\-6 | Dedup at research, save, and manual\-add time (§7) | Given company X exists under teammate A, when teammate B's run or manual add encounters X, then it is blocked and shows A as owner. |
| P0\-7 | Multiple contacts per company with role\_type | Given an approved company, when a founder and a marketing contact are added, then both persist and both sync as separate sheet rows. |
| P0\-8 | No invented contact data | Given research finds no public email, when the lead drafts, then email is empty \+ flagged `→ enrich`, never guessed. |
| P0\-9 | One\-way Sheet sync with 6 core columns first | Given a lead is approved, when sync runs, then it appears in the correct industry tab within 60s in the specified column order. |
| P0\-10 | Per\-run cost cap \+ run cost logging | Given a run hits the $ cap, when the cap triggers, then the run stops gracefully, partial results save, and cost shows on the run row. |

### P1 — Nice\-to\-have (fast follows)

| ID | Requirement |
| --- | --- |
| P1\-1 | Enrichment adapter live with first vendor (Lusha or Apollo) incl. `findPeople` stubs \+ selective reveal \+ credit logging *(P0 the week a subscription exists)* |
| P1\-2 | Admin reassignment UI with history \+ cross\-reachout read\-grants |
| P1\-3 | Admin dashboard (spend, hit\-rates, leads by owner) |
| P1\-4 | ICP Studio (editable configs; v1 can ship configs as seeded rows edited via Supabase) |
| P1\-5 | Waterfall enrichment (Lusha → Apollo fallback) \+ provider hit\-rate comparison |
| P1\-6 | Outreach status field (contacted / replied / meeting / dead) synced to sheet |
| P1\-7 | Re\-run freshness mode ("find 10 more, excluding everything we have") |

### P2 — Future considerations (design for, don't build)

- Email verification layer (ZeroBounce/NeverBounce) before outreach.
- AI\-search visibility snapshot per brand (screenshot of ChatGPT/Perplexity answers — the brief's "live snapshot" section) auto\-generated per approved lead.
- Instagram/Amazon\-first discovery modes as dedicated stage variants.
- Slack/WhatsApp notify on run completion.
- Per\-brand founder\-specific PDF brief generation (extend the millet brief pattern to any industry).

## 12\. Cost Model (verified 10 Aug 2026)

| Item | Rate | Monthly estimate |
| --- | --- | --- |
| Claude Sonnet 5 | $2/M in · $10/M out (promo to 31 Aug; then $3/$15) | \~30 runs ≈ **$45–90 (₹4–8k)** |
| Web search tool | $10 / 1,000 searches | included above (\~$0.30–0.40/run) |
| Per industry run | \~300–600k in \+ 20–30k out tokens \+ 25–40 searches | **$1.5–3 → ₹10–15 per drafted lead** |
| Lusha Pro (if chosen) | $29.90/user/mo · 250 credits · email 1cr / phone 5cr | 1 seat ≈ ₹2.6k |
| Apollo Basic (if chosen) | $49/user/mo annual · large credit pool · 1cr per reveal | 1 seat ≈ ₹4.3k |
| Vercel \+ Supabase | Hobby/free tiers sufficient for v1 | ₹0 |
| **Total** |  | **≈ ₹7–12k/month** — one closed ₹40–50k retainer covers 6\+ months |

Cost per approved lead target (G4): research ₹10–15 \+ enrichment ₹5–10 → **≤ ₹25** ✅

## 13\. Build Phases

| Phase | Scope | Effort |
| --- | --- | --- |
| **1 — Foundation** | Supabase schema \+ RLS, Google auth \+ allowlist, industries/assignments seeded from Pragaman's list, manual add with dedup, pipeline table, Sheet sync | 2–3 days |
| **2 — Research Engine** | Stage pipeline, Claude \+ web\-search integration, ICP configs, review queue, cost caps, run view | 3–5 days |
| **3 — Enrichment** | Adapter \+ first provider, selective reveal UI, credit logging *(starts the day API key exists)* | 1–2 days |
| **4 — Admin & polish** | Dashboard, reassignment UI, ICP Studio, outreach status, waterfall | 3–4 days |

Total: **\~2 weeks** part\-time. Phase 1\+2 alone already replaces the manual workflow.

## 14\. Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Enrichment hit\-rate on tiny Indian D2C founders is below vendor averages | Waterfall across both providers; keep `public_generic` email \+ Instagram as fallback channels; measure hit\-rate in dashboard before scaling credits |
| Vercel function timeouts on long agentic runs | Stage\-based pipeline (§6.1), each stage ≤ 60s, resumable |
| Research quality drifts per industry | ICP config \+ exclusion lists editable without code; review queue keeps humans as the quality gate |
| Duplicate near\-miss companies (same brand, two domains) | Fuzzy name\+city flagging for human confirm; never auto\-merge |
| Credit burn on bad leads | Credits spendable only on approved leads; per\-user monthly credit budget (admin\-set) |
| Compliance (India DPDP / platform ToS) | B2B business\-contact data via licensed APIs only; no LinkedIn scraping; delete\-on\-request honored in DB \+ Sheet |

## 15\. Open Questions

| \# | Question | Who | Blocking? |
| --- | --- | --- | --- |
| 1 | Google Sheet link (and confirm team uses one master sheet, tab\-per\-industry) | Pragaman | Phase 1 |
| 2 | Allotted\-industry list (teammate ⇄ industries) \+ teammate Google emails for the allowlist | Pragaman | Phase 1 |
| 3 | Who owns Anthropic API billing (org account vs personal)? | Pragaman | Phase 2 |
| 4 | Lusha vs Apollo final purchase (adapter supports both; trial both on 20 Indian founders and compare hit\-rate?) | Pragaman | Phase 3 |
| 5 | Vercel account/team to deploy under; custom domain (prospector.noboruworld.com)? | Pragaman | Phase 1 |
| 6 | Product name confirmation — "Noboru Prospector"? | Team | No |
| 7 | Per\-user monthly credit budget for enrichment | Pragaman | Phase 3 |

* * *

*Prepared by Claude for Noboru World · Sources: Anthropic pricing (benchlm.ai, websearchapi.ai), Lusha docs (docs.lusha.com), Apollo docs (docs.apollo.io), Lusha/Apollo plan pricing (fullenrich.com, salesmotion.io) — all fetched 10 Aug 2026.*

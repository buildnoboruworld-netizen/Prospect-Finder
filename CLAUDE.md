@AGENTS.md

# Noboru Prospector — project rules for Claude sessions

Internal lead-gen web app for Noboru World (D2C organic-growth agency).

## Source of truth

- **PRD:** `Noboru_Prospector_PRD.md` at repo root. Read it before product
  decisions. If code and PRD conflict, **the PRD wins**.
- Build phases (PRD §13): **Phase 1 Foundation (done in initial session)** →
  Phase 2 Research Engine (Claude API + web search) → Phase 3 Enrichment
  (Lusha/Apollo adapter) → Phase 4 Admin & polish.

## Stack (locked by PRD — do not substitute)

Next.js App Router + TypeScript strict (currently Next 16, Tailwind v4,
shadcn/ui radix preset) on Vercel · Supabase (Postgres + Auth + RLS) ·
Google Sheets one-way sync via service account · Phase 2 adds Anthropic API ·
Phase 3 adds a vendor-agnostic Lusha/Apollo enrichment adapter.

Package manager: **npm** (pnpm not installed on this machine).

## Git identity — IMPORTANT

This repo belongs to the **buildnoboruworld-netizen** GitHub account, NOT the
other accounts on this laptop (global git config is a different identity).

- Repo-local identity is set: `Noboru World <build.noboruworld@gmail.com>` —
  never use `--global` from this repo.
- `credential.useHttpPath=true` (repo-local) + username pinned in the remote
  URL, so pushes prompt/store credentials for this repo separately from other
  projects. First push must be authorized as **buildnoboruworld-netizen** in
  the browser window Git Credential Manager opens.
- Remote: `https://buildnoboruworld-netizen@github.com/buildnoboruworld-netizen/Prospect-Finder`
- **Never push without telling the user first.**

## Secrets

Secrets live ONLY in `.env.local` (never committed) and Vercel env vars.
Names (see `.env.example`): `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only),
`GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, `GOOGLE_SHEET_ID`, `CRON_SECRET`;
Phase 2+: `ANTHROPIC_API_KEY`, `ENRICHMENT_PROVIDER`, `LUSHA_API_KEY`,
`APOLLO_API_KEY`.

## Brand

Colors: black · lime green `#8CD056` ≈ `oklch(0.77 0.17 131)` · white — all
shadcn tokens in `src/app/globals.css` (primary = lime with near-black text;
white-on-lime fails contrast, don't do it). Fonts: Poppins (headings, via
`--font-heading`/h1-h6 base rule) + Space Grotesk (body). Logo: inline
2-polygon mark in `src/components/logo.tsx` (dark triangle = currentColor);
original traced asset kept at `public/noboru-world-logo.svg`; favicon
`src/app/icon.svg`.

## Database & migrations

- Migrations are plain SQL in `supabase/migrations/` (timestamp-prefixed).
  Never edit an applied migration — add a new file.
- Apply order matters: 0001 extensions/types/normalizers → 0002 tables+RLS →
  0003 dedup RPC → 0004 seeds.
- Apply via Supabase Dashboard SQL editor (paste files in order), or CLI:
  `npx supabase link --project-ref <ref>` then `npx supabase db push`.
- RLS model: allowlisted active users read everything; members write only
  rows they own; admins write all; service role (server) bypasses RLS.
- The `users` table IS the login allowlist (row must exist + active=true).
- 26 industries seeded from the 11 Aug 2026 allotment sheet (codes PF…CE;
  Clothing/Personal Care sub-industries flattened into own rows). Pragaman's
  7 assignments seed in migration 0004; Neha/Sharmila/Aryan via
  `scripts/seed-teammates.sql` once their Google emails exist (replace the
  REPLACE_ME placeholders, run in SQL editor).
- Dedup (PRD §7): generated normalized columns + unique indexes on
  `domain_normalized` / `instagram_handle_normalized`; fuzzy name+city via
  pg_trgm `check_company_duplicate` RPC at ≥0.85 — flags for human confirm,
  never auto-merges. Keep `src/lib/normalize.ts` in sync with the SQL
  normalizers in migration 0001.
- Hand-written DB types in `src/lib/types.ts`; consider
  `npx supabase gen types typescript --linked` once the project is linked.

## Working rules

- TypeScript strict; `npm run build` must pass before every commit.
- Small commits, conventional messages (`feat:`, `fix:`, `chore:`, `docs:`).
- Lint with `npm run lint` (react-hooks rules are strict — no synchronous
  setState in effect bodies).
- Next 16 notes: `src/proxy.ts` (not middleware.ts); `params`/`searchParams`
  are Promises; auth-gated group `(app)` is `force-dynamic`.
- Contact channel statuses: `verified` is RESERVED for enrichment-API
  results; manual/human entries are clamped to `public_generic` (PRD §6.1
  guardrail — never invent or upgrade contact data).
- Sheet sync is one-way DB → Sheet, full-tab rewrite, six core columns first:
  Industry, Company, Contact Person, Designation, Email, Phone (PRD §9).

## Phase 1 status & what's next

See README section "Setup" for the credential checklist (Supabase project,
Google OAuth client, service account, sheet ID, teammate allowlist +
industry assignments). Phase 2 session should start from PRD §6.1 (research
engine stage pipeline: seed → discover → qualify → score, runs table already
exists, per-run cost cap $3 default).

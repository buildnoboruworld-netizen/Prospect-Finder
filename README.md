# Noboru Prospector

Internal lead-generation app for Noboru World — turns an industry into a
reviewed, ICP-fit, deduplicated prospect list synced to the team Google Sheet.
Full product spec: [`Noboru_Prospector_PRD.md`](./Noboru_Prospector_PRD.md).

**Stack:** Next.js (App Router, TS strict) · Supabase (Postgres + Auth + RLS) ·
Tailwind + shadcn/ui · Google Sheets sync · Vercel. Phase 2 adds the Claude
research engine; Phase 3 adds Lusha/Apollo enrichment.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # must pass before every commit
npm run lint
```

## Setup (one-time)

1. **Env vars** — copy `.env.example` → `.env.local`, fill as you complete the
   steps below. Secrets never leave `.env.local` / Vercel env settings.

2. **Supabase project**
   - supabase.com → New project `noboru-prospector`, region Mumbai
     (`ap-south-1`).
   - Project Settings → API: copy Project URL, anon key, service_role key
     into `.env.local`.
   - SQL Editor: run each file in `supabase/migrations/` **in filename
     order** (or `npx supabase link --project-ref <ref> && npx supabase db push`).

3. **Sign-in.** Two options; both end at the same allowlist gate:
   - **Quick start (no Google Cloud needed):** email + password is enabled
     out of the box. For instant sign-ins during testing, turn OFF
     Supabase → Authentication → Sign In / Providers → Email →
     "Confirm email". Create your account on /login with your allowlisted
     email.
   - **Google sign-in (before rolling out to the team):**
   - Supabase Dashboard → Authentication → Providers → Google: copy the
     **Callback URL** shown there.
   - console.cloud.google.com → APIs & Services → Credentials → Create
     OAuth client ID (Web application) → add that callback URL under
     Authorized redirect URIs.
   - Paste the client ID + secret back into the Supabase Google provider and
     enable it.
   - Supabase → Authentication → URL Configuration: Site URL
     `http://localhost:3000` (add the Vercel URL after first deploy) and add
     `http://localhost:3000/auth/callback` to Redirect URLs.

4. **Google Sheets sync**
   - Google Cloud Console → enable **Google Sheets API**.
   - IAM & Admin → Service Accounts → create `noboru-prospector-sheets` →
     Keys → Add key → JSON (downloads a file).
   - Base64-encode the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
     (PowerShell:
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json"))`).
   - Share the team Google Sheet with the service account's email as
     **Editor**; put the sheet ID in `GOOGLE_SHEET_ID`.
   - Delete the downloaded JSON key file after encoding.

5. **Team allowlist** — the admin (seeded: build.noboruworld@gmail.com) signs
   in, then adds teammates at **/admin/users** — or run
   `scripts/seed-teammates.sql` (fill in Neha/Sharmila/Aryan's real Google
   emails first) to create their allowlist rows AND their industry
   assignments from the allotment sheet in one go.

## How it works (Phase 1)

- **Login** is Google-only, gated by the `users` table allowlist (RLS keeps
  non-allowlisted sessions data-blind even if they authenticate).
- **Manual add** live-checks duplicates 3 ways (PRD §7): normalized domain and
  Instagram handle (hard block, shows existing owner), fuzzy name+city at
  ≥0.85 trigram similarity (requires explicit "not a duplicate" confirmation —
  never auto-merges).
- **Rejected companies persist** with a reason and stay excluded unless an
  admin un-rejects.
- **Pipeline** shows your leads (editable) and teammates' (read-only, for
  cross-reachout awareness). Company detail has contacts CRUD (multiple per
  company, one primary, founder/marketing/other roles).
- **Sheet sync** is one-way DB → Sheet on approve, plus admin "Sync now" and a
  nightly Vercel cron (`vercel.json`, guarded by `CRON_SECRET`). Tab per
  industry + Master tab; columns: Industry, Company, Contact Person,
  Designation, Email, Phone, then detail columns; one row per contact with the
  primary flagged.

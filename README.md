# Distro

Distribution copilot for early-stage startups. A founder pastes their URL; Distro builds a product
profile, finds small/mid creators who reach their ICP, drafts outreach for human approval, and tracks
replies and signups. See [CLAUDE.md](CLAUDE.md) for the product spec and hard rules.

**Status: Milestone 1** — auth, onboarding, and the AI-built product profile.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Supabase (Postgres, Auth, RLS) ·
Inngest (background jobs) · LLM: Google Gemini (free tier, default) or Anthropic Claude · Jina Reader (page → markdown).

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local
```

### 2. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → API Keys**: copy the project URL, the **publishable** key and the **secret** key
   into `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
   `SUPABASE_SECRET_KEY`). The legacy `anon` / `service_role` keys also work.
3. Apply the schema. Either paste [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql)
   into **SQL Editor** and run it, or with the Supabase CLI:
   ```bash
   npx supabase link --project-ref <your-ref>
   npx supabase db push
   ```
4. **Authentication → URL Configuration**:
   - Site URL: `http://localhost:3000`
   - Redirect URLs: add `http://localhost:3000/auth/callback`
5. **Authentication → Sign In / Providers → Email**: make sure Email is enabled.
   The built-in mailer is rate-limited (a few emails/hour) — fine for testing; configure SMTP for real use.

### 3. LLM provider

The app talks to the LLM through one function, `generateJson()` in `lib/llm/client.ts`. Pick a provider:

- **Gemini (default, free tier):** get a key at [aistudio.google.com](https://aistudio.google.com) → *Get API key*.
  Set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY`. Models default to Google's `gemini-flash-latest` /
  `gemini-flash-lite-latest` aliases; override with `GEMINI_MODEL` / `GEMINI_FAST_MODEL`.
  On the free tier Google may use prompts to improve its products, and rate limits are low
  (fine for development — Inngest retries rate-limited steps).
- **Anthropic:** set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Uses `claude-sonnet-5-5` with
  structured outputs and server-side refusal fallback.

Only the chosen provider's key is required.

### 4. Jina Reader (optional key)

Page fetching goes through `https://r.jina.ai/` and works without a key. Set `JINA_API_KEY` for higher
rate limits.

### 5. Run

Two terminals:

```bash
npm run dev       # Next.js on http://localhost:3000
npm run inngest   # Inngest dev server on http://localhost:8288 (keep INNGEST_DEV=1 in .env.local)
```

The Inngest dev server discovers functions at `http://localhost:3000/api/inngest`.

## Scripts

| Script              | What it does                          |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Next.js dev server                    |
| `npm run inngest`   | Local Inngest dev server + dashboard  |
| `npm run dev:login -- you@x.com` | Print a sign-in link without sending email (local dev only; dodges Supabase's email rate limit) |
| `npm run typecheck` | Generate route types, run `tsc`       |
| `npm run lint`      | ESLint                                |
| `npm run build`     | Production build                      |

## How M1 works

```
/login ── magic link ──▶ /auth/callback ──▶ /onboarding
                                               │ POST /api/startups   (insert row, status=pending)
                                               ▼
                                     inngest: "startup.created"
                                               │
                              jobs/build-profile.ts
                              ├─ fetch homepage (required, retried)
                              ├─ fetch /pricing, /about (skipped if 404)
                              ├─ lib/llm/profile.ts → Gemini/Claude → zod-validated JSON (1 retry on bad output)
                              └─ save startups.profile_json, status=ready   (or failed + profile_error)
                                               │
/startups/:id/profile ◀── polls GET /api/startups/:id every 2s
   │ edit form
   ├─ Save draft → PUT  /api/startups/:id/profile
   └─ Confirm    → POST /api/startups/:id/profile → status=confirmed, audit_log row,
                                                    inngest: "profile.confirmed" (no handler yet)
```

### Security notes

- Every table has RLS. Founders only see rows for startups they own (`owns_startup()`).
- `creators` is a shared pool: readable by signed-in users, writable only by jobs (service role).
- `audit_log` and `conversions` are read-only to clients.
- `connected_accounts.refresh_token_enc` is not selectable by clients at all (column grants).
- A database trigger enforces the approval rule: a message cannot be `approved` without
  `approved_by`/`approved_at`; founders can only set `draft`/`approved` (as themselves); only the server can
  move an approved message to `queued`/`sent`.
- `SUPABASE_SECRET_KEY` is only used in `lib/supabase/admin.ts` (marked `server-only`).

## Project layout

```
app/                  pages + API routes (app/(app)/* requires auth)
proxy.ts              session refresh + auth redirect (Next 16's renamed middleware)
inngest/client.ts     Inngest client + typed events
jobs/                 Inngest functions
lib/llm/              generateJson + prompts + zod schemas; providers/ = gemini, anthropic
lib/fetch/reader.ts   Jina Reader fetch
lib/supabase/         browser / server / admin / proxy clients
supabase/migrations/  SQL migrations
```

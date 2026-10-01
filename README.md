# Distro

Distribution copilot for early-stage startups. A founder pastes their URL; Distro builds a product
profile, finds small/mid creators who reach their ICP, drafts outreach for human approval, and tracks
replies and signups. See [CLAUDE.md](CLAUDE.md) for the product spec and hard rules.

**Status: Milestone 2** — M1 (auth, onboarding, AI product profile) + YouTube discovery: audience estimate per niche and the top 30 small creators.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Supabase (Postgres, Auth, RLS) ·
Inngest (background jobs) · LLM: Google Gemini (free tier, default) or Anthropic Claude · embeddings (local bge-base via Transformers.js, or Gemini) + pgvector ·
YouTube Data API v3 · Jina Reader (page → markdown) · Vitest.

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
3. Apply the schema: run each file in [supabase/migrations/](supabase/migrations/) **once, in order**
   (`0001_init.sql`, `0002_youtube_discovery.sql`, `0003_embedding_model.sql`) in the **SQL Editor**, or with the Supabase CLI:
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

### 4. YouTube Data API key (Milestone 2)

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **Credentials → Create credentials → API key**; restrict it to the YouTube Data API.
4. Put it in `.env.local` as `YOUTUBE_API_KEY`.

The free quota is 10,000 units/day (a search costs 100, a stats lookup 1). The app stops at 9,000 and resumes
after midnight Pacific time. Usage per day is in the `quota_usage` table and on the creators page.

### 5. Embeddings (no key needed)

By default (`EMBED_PROVIDER=local`) embeddings run on your machine with the open-source
`Xenova/bge-base-en-v1.5` model (768 dims, 8-bit quantized) through Transformers.js: free, no quota,
~10 videos/second on a laptop CPU. The model (~100 MB) downloads on first use into `.cache/transformers`
(git-ignored). Set `EMBED_PROVIDER=gemini` to use Gemini's API instead (free tier: 1,000 texts/day).
Every vector stores the model that made it (`embedding_model`), so switching re-embeds automatically.
Re-measure `relevanceThreshold` in `lib/config.ts` after switching: score ranges differ per model.

### 6. Jina Reader (optional key)

Page fetching goes through `https://r.jina.ai/` and works without a key. Set `JINA_API_KEY` for higher
rate limits.

### 7. Run

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
| `npm test`          | Unit tests (Vitest) in `tests/`       |
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
                                                    inngest: "profile.confirmed"
```

## How M2 works (YouTube discovery)

```
profile.confirmed → build-context      embed profile → startup_context (pgvector)
  context.built   → generate-queries   LLM writes viewer-style queries → search_queries (pending)
"Find creators" (profile page) → campaign → /campaigns/:id/creators → founder edits queries
"Start search" → queries.confirmed
  → youtube-search     search.list per query (100 units, 7-day cache) + videos.list stats → content_items
  → score-relevance    embed each video (local model by default); relevance = cosine similarity in SQL
  → estimate-demand    Σ views × relevance per niche → demand_estimates
  → build-creators     channels.list + recent uploads → creators; filters; rank_score → matches
  → score-creators     LLM fit in batches of 20 until 30 scored; final_score; progress on the page
```

All tunable numbers (threshold, subscriber range, batch size, weights, quota stop) live in
[lib/config.ts](lib/config.ts). If the daily quota runs out mid-run, the job sleeps until midnight Pacific
and continues; finished steps are never repeated.

### Security notes

- Every table has RLS. Founders only see rows for startups they own (`owns_startup()`).
- `creators` is a shared pool: readable by signed-in users, writable only by jobs (service role).
- `audit_log` and `conversions` are read-only to clients.
- `connected_accounts.refresh_token_enc` is not selectable by clients at all (column grants).
- A database trigger enforces the approval rule: a message cannot be `approved` without
  `approved_by`/`approved_at`; founders can only set `draft`/`approved` (as themselves); only the server can
  move an approved message to `queued`/`sent`.
- `SUPABASE_SECRET_KEY` is only used in `lib/supabase/admin.ts` (marked `server-only`).
- M2 tables (`startup_context`, `content_items`, `demand_estimates`) are read-only to founders; `search_queries`
  is editable by its owner; `quota_usage` and the quota/embedding SQL functions are server-only.
  The `campaign_creators` view uses `security_invoker`, so RLS still applies through it.

## Project layout

```
app/                  pages + API routes (app/(app)/* requires auth)
proxy.ts              session refresh + auth redirect (Next 16's renamed middleware)
inngest/client.ts     Inngest client + typed events
jobs/                 Inngest functions (M1: build-profile; M2: discovery chain)
lib/llm/              generateJson + prompts + zod schemas; providers/ = gemini, anthropic
lib/fetch/reader.ts   Jina Reader fetch
lib/discovery/        one module per platform (youtube.ts) + shared http retry, quota, types, email-extract
lib/analysis/         pure scoring maths: context text, demand estimate, rank/final score
lib/config.ts         every tunable number for discovery
tests/                Vitest unit tests
lib/supabase/         browser / server / admin / proxy clients
supabase/migrations/  SQL migrations
```

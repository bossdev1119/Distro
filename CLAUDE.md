# Distro — distribution copilot for early-stage startups

## Product
A founder pastes their startup URL. The app:
1. Builds a product profile (what it does, ICP, keywords, offer for creators).
2. Maps where the ICP lives (YouTube niches, newsletters, Instagram, X).
3. Discovers small/mid creators (5k–200k audience, active in last 60 days) and scores fit.
4. Drafts a personalized outreach message per creator (2 variants).
5. Founder batch-approves messages. NOTHING is sent without approval.
6. Email: sent from the founder's own Gmail via OAuth, throttled.
   Instagram/X: "Send Assist" — app copies the message and opens the creator's DM;
   the founder presses send themselves and clicks "Sent ✓".
7. Tracks replies (auto for Gmail, manual paste for DMs), classifies them with an LLM.
8. Tracks clicks/signups per creator via unique links /c/:slug and a signup webhook.
9. Dashboard shows funnel and surfaces only positive leads.

## Hard rules (never violate)
- Never automate sending on Instagram, X, TikTok, WhatsApp, or any social platform.
  Never store social media passwords or session cookies. Never scrape Instagram directly.
- No message is sent unless its status is "approved" by a human.
- Respect the suppression list always; "no" replies and opt-outs are added automatically.
- Daily send caps per connected account (default 30), random 4–12 min spacing,
  pause the campaign if bounce rate > 5%.
- OAuth refresh tokens are encrypted at rest (AES-256-GCM, key from TOKEN_ENC_KEY).
- Every approval and send is written to audit_log.
- Emails include sender's real name and an opt-out line.

## Stack
- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- Supabase (Postgres, Auth, Row Level Security) — migrations in supabase/migrations
- Inngest for background jobs (event-driven, retryable)
- LLM behind one interface (lib/llm/client.ts → generateJson), provider chosen by LLM_PROVIDER:
  - gemini (default, free tier, @google/genai): GEMINI_MODEL for profile + drafts,
    GEMINI_FAST_MODEL for scoring + reply classification
  - anthropic (@anthropic-ai/sdk): claude-sonnet-5-5 for profile + drafts,
    claude-haiku-4-5 for scoring + reply classification
  - Callers pass a task ("profile" | "drafts" | "scoring" | "classify"), never a model id.
  - All LLM outputs are strict JSON validated with zod; retry once on validation failure.
- Embeddings via embedMany() in lib/llm/client.ts, provider chosen by EMBED_PROVIDER:
  local (default: Xenova/bge-base-en-v1.5 q8 via @huggingface/transformers, 768 dims, no quota)
  or gemini (GEMINI_MODEL_EMBED). Vectors store embedding_model; never compare across models.
- YouTube Data API v3, a web search API (Tavily or Serper), Firecrawl or Jina Reader for page fetching
- Gmail API (scopes: gmail.send, gmail.readonly)

## Structure
- app/            pages + api routes; app/c/[slug]/route.ts is the tracking redirect
- lib/llm/        profile.ts, channels.ts, score.ts, draft.ts, classify.ts (+ zod schemas)
- lib/discovery/  one module per platform (youtube.ts now; search.ts etc. later) + http.ts (retries),
                  quota.ts, types.ts, email-extract.ts
- lib/analysis/   pure scoring functions (demand.ts, score.ts, context.ts); unit-tested in tests/
- lib/config.ts   every tunable number for discovery (thresholds, filters, weights, quota stop)
- lib/gmail/      send, poll threads, token refresh
- lib/crypto.ts, lib/limits.ts, lib/db/
- jobs/           Inngest functions: build-profile, build-context, generate-queries, youtube-search,
                  score-relevance, estimate-demand, build-creators, score-creators;
                  later: generate-drafts, send-email, poll-replies, classify-reply

## Data model
startups, campaigns, creators (shared pool, unique platform+handle), matches,
messages (status: draft|approved|queued|sent|replied|failed), replies, links,
conversions, suppression, connected_accounts, audit_log.
RLS: founders only see rows for their own startups.

## Conventions
- Keep secrets in .env.local; maintain .env.example with every variable.
- Small, typed functions; no `any`.
- After each milestone: run typecheck + lint, and list how to test it manually.
- Ask before adding a paid third-party service not listed above.

@AGENTS.md

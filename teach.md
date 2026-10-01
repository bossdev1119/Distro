# Learning Distro: what we built, and why

This guide explains every piece of Milestone 1 (M1, sections 0–16) and Milestone 2 (M2, sections 17–29): what it does, **why** it's built that way, and which
file to open to see it. Read it with the code open next to it. Every section ends with a
**"Try it"** exercise. Do them, because typing and breaking things is how this actually sticks.

> How to read: go top to bottom the first time. Later, use it as a map. Links like
> [lib/llm/client.ts](lib/llm/client.ts) open the real file.

---

## Table of contents

0. [The big picture](#0-the-big-picture)
1. [The stack: one mental model per tool](#1-the-stack-one-mental-model-per-tool)
2. [Project layout](#2-project-layout)
3. [Next.js App Router](#3-nextjs-app-router)
4. [Supabase: three clients, three trust levels](#4-supabase-three-clients-three-trust-levels)
5. [The database migration](#5-the-database-migration)
6. [Row Level Security (RLS)](#6-row-level-security-rls)
7. [Magic-link auth, step by step](#7-magic-link-auth-step-by-step)
8. [Onboarding: form → API → event](#8-onboarding-form--api--event)
9. [Inngest: background jobs that survive failure](#9-inngest-background-jobs-that-survive-failure)
10. [Calling the LLM: structured, validated JSON](#10-calling-the-llm-structured-validated-json)
11. [The profile editor: polling and forms](#11-the-profile-editor-polling-and-forms)
12. [TypeScript and zod patterns used everywhere](#12-typescript-and-zod-patterns-used-everywhere)
13. [Tooling: typecheck, lint, build, and testing SQL](#13-tooling-typecheck-lint-build-and-testing-sql)
14. [Mistakes made along the way (and lessons)](#14-mistakes-made-along-the-way-and-lessons)
15. [Exercises to cement it](#15-exercises-to-cement-it)
16. [Glossary](#16-glossary)

**Part 2: Milestone 2 (YouTube discovery)**

17. [The M2 picture: from profile to top 30 creators](#17-the-m2-picture-from-profile-to-top-30-creators)
18. [Embeddings and cosine similarity](#18-embeddings-and-cosine-similarity)
19. [pgvector: vectors inside Postgres](#19-pgvector-vectors-inside-postgres)
20. [Search queries in the viewer's words](#20-search-queries-in-the-viewers-words)
21. [API quotas, pagination, batching ids, caching](#21-api-quotas-pagination-batching-ids-caching)
22. [Retries, backoff, and typed errors](#22-retries-backoff-and-typed-errors)
23. [Upserts and unique constraints](#23-upserts-and-unique-constraints)
24. [Estimating demand (and why it's only an estimate)](#24-estimating-demand-and-why-its-only-an-estimate)
25. [Building and ranking creators](#25-building-and-ranking-creators)
26. [Batches of 20, idempotency, and sleeping until tomorrow](#26-batches-of-20-idempotency-and-sleeping-until-tomorrow)
27. [The Audience & Creators page: data fetching](#27-the-audience--creators-page-data-fetching)
28. [Unit tests with Vitest](#28-unit-tests-with-vitest)
29. [M2 lessons and exercises](#29-m2-lessons-and-exercises)

---

## 0. The big picture

M1 does one job: **turn a startup's URL into a structured product profile the founder can edit.**

```
Browser                         Next.js server                      Background (Inngest)
───────                         ──────────────                      ────────────────────
/login  ── email ──▶ server action → Supabase sends magic link
(click link in email)
/auth/callback ◀────────────── exchanges code for a session cookie
/onboarding  ── POST /api/startups ──▶ insert row (status=pending)
                                      send event "startup.created" ──▶ build-profile job
                                                                       ├ fetch homepage
                                                                       ├ fetch /pricing, /about
                                                                       ├ ask the LLM for JSON
                                                                       └ save profile, status=ready
/startups/:id/profile
   polls GET /api/startups/:id every 2s ◀── reads status from DB
   shows form once status=ready
   Confirm ── POST .../profile ──▶ status=confirmed, audit_log row,
                                   send event "profile.confirmed"  ──▶ (nothing yet, that's M2)
```

**Why is the profile built in the background, not inside the POST request?**
Fetching three web pages and calling an LLM can take 20–60 seconds, and any step can fail. An HTTP request
that hangs for a minute is fragile: browsers time out, serverless functions get killed, and if it fails
halfway you start over. So the request just **records the intent** (a row plus an event) and returns
immediately. A job runner does the slow work, with retries. The page polls to see progress.

This pattern (**accept fast, process async, poll or push status**) is one of the most useful ideas in
backend engineering. You'll reuse it in every later milestone: discovery, scoring, drafting, sending.

---

## 1. The stack: one mental model per tool

| Tool | Mental model | What it does for us |
|---|---|---|
| **Next.js (App Router)** | "Folders are URLs; React components can run on the server." | Pages, API routes, auth gate |
| **TypeScript** | "JavaScript that checks your work before it runs." | Catches wrong shapes at compile time |
| **Tailwind** | "Styles as class names." | `className="flex gap-4 p-6"` |
| **shadcn/ui** | "Copy-paste components you own." | `components/ui/*`, generated, editable |
| **Supabase** | "Postgres + login system + a security layer inside the DB." | Data, magic links, RLS |
| **Inngest** | "A to-do list for the server that retries until it's done." | Runs `build-profile` reliably |
| **Gemini / Claude** | "An LLM behind one function, swappable." | Turns web pages into a profile |
| **zod** | "A runtime bouncer for data." | Validates input, LLM output, env vars |
| **Jina Reader** | "Any URL → clean markdown." | `https://r.jina.ai/<url>` |

A key idea: **TypeScript only checks at compile time. zod checks at runtime.** Data from outside your
program (HTTP bodies, LLM output, env vars, the DB) has no guaranteed shape. TypeScript can't see it,
so zod validates it at the boundary. After that, TypeScript can trust it.

---

## 2. Project layout

```
app/                          ← Next.js routes (folders = URLs)
  layout.tsx                  ← root HTML shell, applies to every page
  login/                      ← /login (public)
  auth/callback/route.ts      ← /auth/callback (magic link lands here)
  auth/signout/route.ts       ← POST /auth/signout
  (app)/                      ← "route group": parentheses = NOT part of the URL
    layout.tsx                ← shared header + auth check for everything inside
    page.tsx                  ← /  (list your startups)
    onboarding/               ← /onboarding
    startups/[id]/profile/    ← /startups/123/profile  ([id] = dynamic segment)
  api/
    startups/route.ts         ← POST /api/startups
    startups/[id]/route.ts    ← GET  /api/startups/:id
    startups/[id]/profile/route.ts ← PUT/POST /api/startups/:id/profile
    inngest/route.ts          ← Inngest calls this to run jobs
proxy.ts                      ← runs before every request (auth gate)
inngest/client.ts             ← Inngest client + typed event definitions
jobs/                         ← background functions
lib/
  env.ts                      ← validated environment variables
  api.ts                      ← small helpers for route handlers
  audit.ts                    ← write to audit_log
  supabase/                   ← 3 Supabase clients + proxy helper
  llm/                        ← generateJson, prompts, zod schemas, providers/
  fetch/reader.ts             ← Jina Reader
  db/                         ← hand-written row types
supabase/migrations/0001_init.sql ← the whole database schema
```

**The rule behind this layout:** `app/` is thin. It handles HTTP, reads input and returns output.
The real logic lives in `lib/` and `jobs/`, where it can be reused and tested without a browser.

---

## 3. Next.js App Router

### 3.1 Files become routes

- `app/login/page.tsx` → the page at `/login`
- `app/api/startups/route.ts` → an **API endpoint** at `/api/startups`. You export functions named after
  HTTP methods: `export async function POST(request) {...}`
- `app/(app)/startups/[id]/profile/page.tsx` → `/startups/<anything>/profile`, where `id` is available
  in `params`

### 3.2 Server Components vs Client Components

By default, **every component runs on the server**. It can `await` the database directly, and its code
never ships to the browser. Look at [app/(app)/page.tsx](app/(app)/page.tsx): it's an `async` function
that queries Supabase and returns JSX. No `useEffect`, no loading spinner.

A file that starts with `"use client"` runs **in the browser** too. You need that for anything
interactive: `useState`, `onClick`, `onChange`, timers. In M1 these are:

- [app/login/login-form.tsx](app/login/login-form.tsx)
- [app/(app)/onboarding/onboarding-form.tsx](app/(app)/onboarding/onboarding-form.tsx)
- [app/(app)/startups/[id]/profile/profile-editor.tsx](app/(app)/startups/[id]/profile/profile-editor.tsx)

**The pattern used everywhere:** a server `page.tsx` loads the data, then renders a client component and
passes the data as props:

```tsx
// page.tsx (server)
const { data } = await supabase.from("startups").select(...).eq("id", id).maybeSingle();
if (!data) notFound();
return <ProfileEditor initial={data} />;   // profile-editor.tsx is "use client"
```

You get fast first paint (the data is already in the HTML) plus interactivity.

### 3.3 `params` is a Promise (Next 15+)

```ts
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
```

In older Next.js versions `params` was a plain object. Now you `await` it. Pages use generated helper
types: `PageProps<"/startups/[id]/profile">` and `LayoutProps<"/">`. Those are created by
`next typegen`, which is why our `typecheck` script runs it first.

### 3.4 Route groups: `(app)`

The folder `(app)` does **not** appear in the URL. It exists so every page inside can share
[app/(app)/layout.tsx](app/(app)/layout.tsx): the header, the sign-out button and an auth check.
`/login` sits outside the group, so it doesn't get that layout.

### 3.5 `proxy.ts`: code that runs before every request

Next.js 16 **renamed `middleware.ts` to `proxy.ts`**. That's why the file isn't called middleware.
(Lesson: when a framework's major version changes, check its docs; the generated `AGENTS.md` warned
about exactly this.)

[proxy.ts](proxy.ts) calls `updateSession` in [lib/supabase/proxy.ts](lib/supabase/proxy.ts), which
does two jobs:

1. **Refreshes the login session.** Supabase access tokens expire after about an hour. The proxy quietly
   refreshes them and writes new cookies.
2. **Guards routes.** If you're not signed in and the path isn't public, it redirects you to `/login`.
   For `/api/*` routes it returns a JSON `401` instead, because an API caller can't follow a redirect
   to a login page.

```ts
const PUBLIC_PATHS = ["/login", "/auth/callback", "/api/inngest", "/c/"];
```

Why is `/api/inngest` public? Inngest's servers call it, and they aren't a logged-in user. (Inngest
proves who it is with a signing key instead.) `/c/` is reserved for the future tracking links, which
creators' audiences will click without logging in.

The `matcher` in `proxy.ts` skips static files (`_next/static`, images) so we don't run auth logic
for every CSS file.

> **Try it:** add `"/pricing"` to `PUBLIC_PATHS`, create `app/pricing/page.tsx` that returns
> `<h1>Pricing</h1>`, and visit it logged out. Then remove it from the list and see the redirect.

---

## 4. Supabase: three clients, three trust levels

This is the most important security concept in the project. There are **three** ways to talk to
Supabase, and each one runs with different power:

| File | Where it runs | Key used | Acts as | RLS applies? |
|---|---|---|---|---|
| [lib/supabase/client.ts](lib/supabase/client.ts) | Browser | publishable (public) | the logged-in user | ✅ yes |
| [lib/supabase/server.ts](lib/supabase/server.ts) | Server (pages, routes) | publishable + user's cookie | the logged-in user | ✅ yes |
| [lib/supabase/admin.ts](lib/supabase/admin.ts) | Server only (jobs) | **secret** key | "god mode" (`service_role`) | ❌ **bypassed** |

**Why the publishable key can be public:** it grants nothing on its own. What you can see is decided by
**RLS policies in the database** based on *who you're logged in as*. So even a malicious user holding
the key can only read their own rows.

**Why the secret key must never reach the browser:** it bypasses RLS entirely. That's why
`admin.ts` starts with:

```ts
import "server-only";
```

That line makes the **build fail** if any client component ever imports this file, directly or
indirectly. It's a cheap, strong guardrail. We put it on every server-only module (`env.ts`, `llm/*`,
`audit.ts`, `reader.ts`...).

**When do we use admin?**
- In the Inngest job: there's no logged-in user in a background job, so it can't use a user session.
- For writing `audit_log`: clients are forbidden from writing it (so nobody can forge history), so the
  server writes it on their behalf, *after* it has already checked they're allowed.

**Why `NEXT_PUBLIC_` matters:** Next.js only exposes env vars whose names start with `NEXT_PUBLIC_` to
the browser, and only when they're written literally (`process.env.NEXT_PUBLIC_SUPABASE_URL`), because
it find-and-replaces them at build time. That's why [lib/supabase/public-env.ts](lib/supabase/public-env.ts)
spells them out, instead of reading them through the zod-validated `serverEnv()`.

**Cookies in the server client.** The server client needs to *read* the user's session cookie and
sometimes *write* a refreshed one. In a Server Component, cookies are read-only, so `setAll` is wrapped
in `try/catch`. That's safe because the proxy already refreshed the cookie on the way in.

> **Try it:** in [app/(app)/onboarding/onboarding-form.tsx](app/(app)/onboarding/onboarding-form.tsx),
> temporarily add `import { createAdminClient } from "@/lib/supabase/admin";` and run `npm run build`.
> Read the error. That's `server-only` doing its job. Then remove the import.

---

## 5. The database migration

Open [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql). A **migration** is a
versioned SQL file that moves the database from one shape to the next. Migrations are committed with
the code, so any developer (or production) can rebuild the exact same schema. The next change will be
`0002_something.sql`. **Never edit a migration that has already run in production; add a new one.**

### 5.1 The tables and how they relate

```
auth.users (managed by Supabase)
   │ owner_id
   ▼
startups ──┬── campaigns ──┬── matches ──┬── messages ── replies
           │               │     │       └── links ── conversions
           │               │     └── creators (shared pool, no startup_id)
           ├── suppression
           └── audit_log
auth.users ── connected_accounts (founder's Gmail; belongs to a user, not a startup)
```

Things to notice:

- **Every startup-scoped table has its own `startup_id` column**, even when you could reach the startup
  by joining (for example message → match → campaign → startup). This is deliberate denormalization: it
  makes security policies one simple check (`owns_startup(startup_id)`) and makes "all messages for
  startup X" a fast indexed lookup.
- **`creators` has no `startup_id`.** It's a shared pool: the same YouTuber can match many startups.
  `unique (platform, handle)` guarantees no duplicates.
- **`on delete cascade`**: delete a startup and all its campaigns, messages and so on go with it.
  **`on delete set null`**: delete a connected Gmail account and messages keep existing, but their
  `connected_account_id` becomes null.

### 5.2 Enums

```sql
create type public.message_status as enum ('draft', 'approved', 'queued', 'sent', 'replied', 'failed');
```

An enum is a type that only allows fixed values. `update messages set status = 'snet'` fails
immediately instead of silently storing a typo. The database protects itself.

### 5.3 Indexes: why on every foreign key?

An index is like a book's index: without one, Postgres reads every row to find matches (a "sequential
scan"). **Postgres does *not* automatically index foreign-key columns** (only the column they point to).
You need them because:

1. Joins like "messages for this match" filter by `match_id`.
2. When you delete a parent row, Postgres must find all child rows to cascade. Without an index, that's
   a full table scan per delete.

`messages_status_idx` exists because future jobs will constantly ask "give me all `approved`
messages". Also note:

```sql
create index messages_gmail_thread_id_idx on public.messages (gmail_thread_id) where gmail_thread_id is not null;
```

That's a **partial index**. It only indexes rows that have a thread id (email messages), so it's smaller
and faster.

```sql
create unique index suppression_email_key on public.suppression (startup_id, lower(email)) where email is not null;
```

That's an **expression index** plus **unique**: `Bob@X.com` and `bob@x.com` count as the same email,
so you can't suppress it twice, and lookups are case-insensitive.

`matches` has no separate index on `campaign_id` because the unique constraint `(campaign_id,
creator_id)` already creates an index whose **leading column** is `campaign_id`, and Postgres can use it
for campaign-only lookups too.

### 5.4 Triggers

A trigger is a function the database runs automatically on insert or update.

**`set_updated_at`** keeps the `updated_at` column honest without the app remembering to set it:

```sql
create trigger startups_updated_at before update on public.startups
  for each row execute function public.set_updated_at();
```

**`enforce_message_status`** is the interesting one. CLAUDE.md's hard rule says *"No message is sent
unless its status is 'approved' by a human."* You could enforce that only in application code, but code
has bugs, and a future job might accidentally skip the check. So the rule lives **in the database**,
where every code path has to go through it:

- `approved`, `queued`, `sent` and `replied` all require `approved_by` and `approved_at` to be set.
- You can only go to `queued`/`sent` **from** `approved` (or `queued` → `sent`).
- A normal logged-in user (not the server) can only set `draft` or `approved`, can only approve **as
  themselves** (`approved_by = auth.uid()`), and can't change a message that's already sent.

This is called **defense in depth**: several independent layers, so one bug doesn't break the rule.

### 5.5 A few column choices worth noticing

- `uuid primary key default gen_random_uuid()`: random ids can't be guessed, unlike 1, 2, 3.
- `timestamptz`: timestamp *with time zone*. Always use it; plain `timestamp` causes time-zone bugs.
- `jsonb` for `profile_json`: the profile's shape is owned by the zod schema and may evolve, so we store
  it as a JSON document instead of eight columns.
- `refresh_token_enc bytea`: raw bytes, because it holds AES-256-GCM ciphertext (M3), never the
  plaintext token.
- `audit_log.id bigint generated always as identity`: an append-only log where insertion order matters,
  so a sequential id fits better than a uuid.

> **Try it:** in the Supabase SQL editor, run
> `insert into campaigns (startup_id, name) values (gen_random_uuid(), 'x');`
> Read the foreign-key error. Then try `update messages set status = 'banana';` and read the enum error.

---

## 6. Row Level Security (RLS)

**RLS = "every query gets an invisible WHERE clause."** When RLS is on and a user runs
`select * from startups`, Postgres silently adds the policy's condition, so they only ever get their own
rows. Even a hand-written query from the browser console can't escape it.

### 6.1 Turning it on

```sql
alter table public.startups enable row level security;
```

Once RLS is enabled with no policies, **nobody** (except the service role) can see anything. That makes
it deny-by-default. Policies then open specific doors.

### 6.2 Policies

```sql
create policy startups_select on public.startups for select to authenticated
  using (owner_id = (select auth.uid()));

create policy startups_insert on public.startups for insert to authenticated
  with check (owner_id = (select auth.uid()));
```

- `using (...)` filters **which existing rows** you can see, update or delete.
- `with check (...)` validates **the new row** you're writing. Without it, you could insert a startup
  with someone else's `owner_id`.
- `auth.uid()` is a Supabase function returning the logged-in user's id from their JWT.
- Why `(select auth.uid())` instead of `auth.uid()`? Wrapped in a subselect, Postgres evaluates it
  **once per query** instead of once per row. It's a known Supabase performance tip.

### 6.3 The `owns_startup()` helper

Child tables (campaigns, messages...) all need the check "does the current user own this row's
startup?" Instead of repeating a subquery everywhere, there's one function:

```sql
create or replace function public.owns_startup(p_startup_id uuid)
returns boolean language sql stable
security definer
set search_path = ''
as $$ select exists (select 1 from public.startups s
                     where s.id = p_startup_id and s.owner_id = (select auth.uid())); $$;
```

- `security definer`: the function runs with its *creator's* permissions, not the caller's. This
  avoids RLS on `startups` being re-checked inside the policy check, which can recurse or slow down.
- `set search_path = ''`: a security-definer function must not be tricked into calling a look-alike
  function from another schema, so everything inside is fully qualified (`public.startups`).
- `stable`: tells Postgres the result doesn't change within one query, so it can cache it.

### 6.4 Grants: a second layer under RLS

RLS decides **which rows**. `GRANT`/`REVOKE` decides **which operations and columns**.

```sql
revoke all on all tables in schema public from anon;           -- logged-out users: nothing
revoke insert, update, delete on public.creators from authenticated;   -- read-only pool
revoke insert, update, delete, truncate on public.audit_log from authenticated;
```

The cleverest part is `connected_accounts`. We want users to see their own Gmail connection, but
**never** the encrypted token column:

```sql
revoke all on public.connected_accounts from authenticated;
grant select (id, user_id, provider, email, sender_name, ...) on public.connected_accounts to authenticated;
```

Column-level grants. `select refresh_token_enc` fails with "permission denied" even for the owner.
(Note: you have to `revoke all` first. A column-level revoke does nothing if a table-level grant still
exists.)

> **Try it:** sign up with two different emails (use two browsers). Create a startup as user A, copy its
> `/startups/<id>/profile` URL and open it as user B. You get a 404, and no code in the page checks
> ownership. RLS did it.

---

## 7. Magic-link auth, step by step

There are no passwords: Supabase emails a one-time link. Follow the flow through the files:

1. **[app/login/page.tsx](app/login/page.tsx)** renders [login-form.tsx](app/login/login-form.tsx).
2. The form's `action={action}` calls a **Server Action**, `sendMagicLink` in
   [app/login/actions.ts](app/login/actions.ts). A Server Action is a server function you can call
   directly from a form. The `"use server"` directive at the top makes Next.js turn it into a hidden
   POST endpoint for you.
3. `useActionState` gives the form three things: the action's latest return value (`state`), the
   function to call (`action`), and `pending` (true while it runs). It's used to show "Sending…" and
   the "check your email" message.
4. `sendMagicLink` validates the email with zod, then:
   ```ts
   await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: callback.toString() } });
   ```
   Behind the scenes `@supabase/ssr` uses the **PKCE** flow: it creates a secret "code verifier" and
   stores it **in a cookie in this browser**.
5. The user clicks the email link → Supabase verifies it → redirects to
   `/auth/callback?code=...&next=/onboarding`.
6. **[app/auth/callback/route.ts](app/auth/callback/route.ts)** calls
   `exchangeCodeForSession(code)`. Supabase checks the code **against the verifier cookie** from step 4
   and issues session cookies. Result: **the link only works in the browser that requested it.** A
   stolen email link opened elsewhere fails. (That's the point of PKCE.) The route also accepts the
   `token_hash` style, in case you customize the email template later.
7. Redirect to `next`. Logged in.

### The open-redirect guard

```ts
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
```

Without this, an attacker could send someone `.../login?next=https://evil.com`, and after a real login
your site would bounce them to a phishing page. We only allow paths on our own site. `//evil.com` is
blocked too, because browsers treat `//` as "another domain".

### Checking auth: `getClaims()`, not `getSession()`

Cookies can be tampered with. `getClaims()` **verifies the JWT's signature** before trusting who the
user is. The authed layout checks again, even though the proxy already did:

```ts
// app/(app)/layout.tsx
const { data } = await supabase.auth.getClaims();
if (!data?.claims.sub) redirect("/login");
```

That's defense in depth again. If someone misconfigures the proxy matcher later, pages still refuse to
render.

> **Try it:** request a magic link in Chrome, then paste the link from the email into Firefox. Watch it
> fail and land on `/login?error=...`. Now you've *seen* PKCE work.

---

## 8. Onboarding: form → API → event

### 8.1 The client form

[onboarding-form.tsx](app/(app)/onboarding/onboarding-form.tsx) uses a plain `onSubmit` plus `fetch`
(not a Server Action) because the flow is "call an API, then navigate". It uses
`event.preventDefault()` to stop the browser's default full-page submit, sends JSON, and on success
calls `router.push(...)` to the profile page.

### 8.2 The API route

[app/api/startups/route.ts](app/api/startups/route.ts). Read it in this order:

**a) Validate the input with zod, including a transform:**

```ts
url: z.string().trim().min(3).max(2048).transform((value, ctx) => {
  try {
    const url = normalizeUrl(value);                 // "acme.com" → "https://acme.com"
    const host = new URL(url).hostname;
    if (!host.includes(".") || host === "localhost") throw new Error("not public");
    return url;
  } catch {
    ctx.addIssue({ code: "custom", message: "Enter a valid public website URL" });
    return z.NEVER;
  }
}),
```

zod can **clean** data as well as check it: after parsing, `url` is already normalized. Blocking
`localhost` is a small step against people pointing our fetcher at internal addresses (this attack is
called SSRF).

**b) Insert under RLS as the user.** It uses the server client, not admin, so the database enforces
`owner_id = auth.uid()`.

**c) Send the event:**

```ts
await inngest.send(startupCreated.create({ startupId: startup.id }));
```

**d) Handle a failed send.** If Inngest isn't reachable, the row exists but no job will ever run, and the
page would say "building…" forever. So we mark the row `failed` with a helpful message and return 502.
**Always ask yourself: "what state is left behind if step N fails?"**

### 8.3 `parseBody`: a reusable helper

[lib/api.ts](lib/api.ts) returns **either** `{ data }` **or** `{ response }`:

```ts
const body = await parseBody(request, createStartupSchema);
if ("response" in body) return body.response;   // invalid → already a 400 response
body.data.url                                     // TypeScript now knows data exists
```

This is a **discriminated union**. The `"response" in body` check *narrows* the type, so TypeScript
knows exactly which case you're in. No exceptions, no `any`.

> **Try it:** `curl -X POST localhost:3000/api/startups -H "content-type: application/json" -d '{"url":"localhost"}'`
> while logged out (401 from the proxy). Then do the same request from the browser devtools console
> while logged in (400 with a zod error).

---

## 9. Inngest: background jobs that survive failure

### 9.1 Events and functions

[inngest/client.ts](inngest/client.ts) defines **typed events**:

```ts
export const startupCreatedData = z.object({ startupId: z.uuid() });
export const startupCreated = eventType("startup.created", { schema: startupCreatedData });
```

An **event** is a fact: "a startup was created". **Functions** subscribe to events. The sender doesn't
know or care who listens. That's why `profile.confirmed` can already be sent in M1 with no handler:
M2's channel-mapping job will just subscribe to it. This decoupling is the heart of an
**event-driven** design.

### 9.2 How Inngest actually runs your code

[app/api/inngest/route.ts](app/api/inngest/route.ts) exposes your functions over HTTP. The flow:

1. Your app sends an event to Inngest (the dev server locally, the cloud in production).
2. Inngest sees `build-profile` is triggered by it and **calls your `/api/inngest` endpoint** to run it.
3. Your function runs until it hits a `step.run(...)`, runs that step, and reports the result back.
4. Inngest **saves the result** and calls your function again for the next step.

### 9.3 Steps = checkpoints

Open [jobs/build-profile.ts](jobs/build-profile.ts). This is the most important Inngest idea:

**Each `step.run("name", fn)` is a checkpoint.** Once a step succeeds, its return value is saved. If a
later step fails and the function is retried, finished steps **don't run again**: Inngest hands back
their saved result instantly.

So if the LLM times out in `generate-profile`, the retry does **not** re-fetch the three web pages. It
jumps straight back to the LLM call. Without steps you'd redo everything on every failure.

Consequences you must respect:
- **Step results must be JSON-serializable** (they get stored). That's also why page markdown is cut
  to `MAX_PAGE_CHARS` before it's returned from a step: keep saved state small.
- **Code outside steps runs on every re-invocation.** Keep it cheap and deterministic.
- **Step names must be unique and stable**. They're the checkpoint keys.

### 9.4 Parallel steps

```ts
const optional = await Promise.all(optionalUrls.map((url) => step.run(`fetch-...`, async () => {...})));
```

`/pricing` and `/about` are fetched **at the same time**, each as its own retryable step.

### 9.5 Retryable vs non-retryable failures

- The **homepage** is required, so if it fails the error propagates and Inngest retries (up to
  `retries: 3`).
- `/pricing` and `/about` are optional, so a 404 (`PageNotFoundError`) returns `null` and the job
  moves on. Other errors (for example a timeout) still throw and get retried.
- A **bad LLM output** is thrown as `NonRetriableError`: `generateJson` already retried once, so
  retrying the whole step would waste money.

**The thinking to practise:** *"Would trying again plausibly succeed?"* A network timeout: yes, retry.
A 404 or a permanently invalid input: no, fail fast.

### 9.6 `onFailure`, `concurrency`

- `onFailure` runs **after all retries are exhausted**. It sets `profile_status = 'failed'` with the
  error, so the UI stops saying "building…" and shows what went wrong.
- `concurrency: { key: "event.data.startupId", limit: 1 }` means at most one build per startup at a
  time, so two runs can't race and overwrite each other.

> **Try it:** run `npm run inngest`, open http://localhost:8288, submit a startup and watch the run's
> timeline. Then set `ANTHROPIC_API_KEY=wrong` in `.env.local`, restart `npm run dev`, submit again, and
> watch the fetch steps succeed while `generate-profile` fails and retries. Finally put the real key back
> and use **Rerun** in the dashboard.

---

## 10. Calling the LLM: structured, validated JSON

The LLM code is split into layers:

```
lib/llm/profile.ts          the prompt (what to ask)              ← knows nothing about providers
lib/llm/client.ts           generateJson(): retry + zod checks    ← knows nothing about Gemini/Claude
lib/llm/providers/gemini.ts     how to call Google Gemini          ← default (free tier)
lib/llm/providers/anthropic.ts  how to call Anthropic Claude
lib/llm/providers/types.ts      the shared contract (LlmProvider)
```

The prompt and the plumbing are kept separate on purpose: M2's scoring and drafting will reuse
`generateJson` with different prompts. Section 10.5 explains why the providers are split out.

### 10.1 The schema is the contract

[lib/llm/schemas.ts](lib/llm/schemas.ts):

```ts
export const startupProfileSchema = z.object({
  one_liner: z.string().min(1).describe("One sentence: what the product does and for whom."),
  use_cases: z.array(z.string().min(1)).min(1).describe("Concrete use cases, 3-6 short phrases."),
  ...
});
export type StartupProfile = z.infer<typeof startupProfileSchema>;
```

This single schema is used in **four** places:
1. It's turned into a JSON Schema that **constrains the model's output**.
2. It **validates** the model's response.
3. It **validates** the edited profile in the API (`PUT`/`POST .../profile`).
4. It **validates** the form in the browser before sending.

`z.infer` produces the TypeScript type from the schema: one source of truth, so no drift. The
`.describe()` texts end up in the JSON Schema, so they act as per-field instructions to the model.

### 10.2 Structured outputs

Both providers support **structured outputs**: you hand the API a JSON Schema, and it constrains
generation so the reply is valid JSON of that shape. That's much stronger than writing "please reply in
JSON" in a prompt.

**Gemini** ([providers/gemini.ts](lib/llm/providers/gemini.ts)):

```ts
const response = await gemini().models.generateContent({
  model: modelFor(task),
  contents: user,
  config: {
    systemInstruction: system,
    responseMimeType: "application/json",
    responseJsonSchema: toGeminiSchema(schema),   // zod → JSON Schema via z.toJSONSchema()
    maxOutputTokens: maxTokens,
  },
});
```

zod v4 can convert a schema to standard JSON Schema by itself (`z.toJSONSchema`). For our profile that
produces `{"type":"object","properties":{"one_liner":{"type":"string","minLength":1,"description":...}}...}`,
and the `.describe()` texts go along as instructions.

**Claude** ([providers/anthropic.ts](lib/llm/providers/anthropic.ts)) uses the Anthropic SDK's zod helper:

```ts
const response = await anthropic().beta.messages.parse({
  model: MODELS[task], max_tokens: maxTokens, system,
  messages: [{ role: "user", content: user }],
  output_config: { format: betaZodOutputFormat(schema) },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",   // if a safety check declines, re-run on a fallback model
});
```

Different vocabulary (`systemInstruction` vs `system`, `finishReason: "MAX_TOKENS"` vs
`stop_reason: "max_tokens"`), same idea. Each provider file **translates** its API's vocabulary into
one shared answer:

```ts
type JsonAttempt = { kind: "ok"; value: unknown } | { kind: "retry"; problem: string };
```

### 10.3 Why validate again, and retry once?

Structured outputs guarantee the *shape*, but some zod rules (like `.min(1)`, "at least one item")
can't always be enforced by the JSON Schema. So we `safeParse` again, and CLAUDE.md says: *retry once on
validation failure.* The loop:

```
attempt 1 → refusal?            → throw (a retry won't change a policy decision)
          → truncated?          → try again
          → zod fails?          → try again
          → API error (429/500)? → throw; the SDK already retried, and Inngest will retry the step
attempt 2 → same checks → otherwise throw LlmOutputError
```

The rule: each layer retries **only the failures it's responsible for**. The SDK and Inngest retry
network and 429 (rate-limit) errors, `generateJson` retries bad output, and Inngest retries whole steps.
On Gemini's free tier you'll hit 429s sometimes. Inngest waits and retries the step, so it heals itself.

### 10.4 The prompt

[lib/llm/profile.ts](lib/llm/profile.ts). Worth studying:

- The **system prompt** gives the role and rules (*"Do not invent features... competitors only when
  clearly implied"*). It explains **what each field is for** (keywords are *terms creators use*, not
  internal jargon). A model does better when it knows *why*.
- The website content is wrapped in tags: `<page url="...">...</page>`, `<founder_notes>`. Tags
  clearly separate *data* from *instructions*.
- Each page is capped at 30k characters so one giant docs page can't crowd out the others.

> **Try it:** change the `tone` description to "Three adjectives, comma-separated." and rebuild a
> profile. See how much `.describe()` steers the output.

### 10.5 Swapping providers: the adapter pattern

We started on Claude, then switched to Gemini's free tier. Look at what that change touched:

| Changed | Unchanged |
|---|---|
| `lib/llm/providers/*` (new), `client.ts`, `env.ts` | The prompt, the job, the database, every route and page |
| `profile.ts`: one word (`model: MODELS.profile` → `task: "profile"`) | |

That's the **adapter pattern**: define one interface your app needs and write one small "adapter" per
outside service that fits it:

```ts
// providers/types.ts
export interface LlmProvider {
  readonly name: string;
  generate(request: JsonRequest): Promise<JsonAttempt>;
}
```

`client.ts` picks the adapter from `.env.local`:

```ts
const PROVIDERS = { anthropic: anthropicProvider, gemini: geminiProvider };
function provider() { return PROVIDERS[serverEnv().LLM_PROVIDER]; }
```

Two design choices worth copying:

- **Callers say *what* they're doing, not *which model*.** `generateJson({ task: "profile", ... })`.
  Each provider maps tasks to its own models (Gemini: `GEMINI_MODEL`/`GEMINI_FAST_MODEL`; Claude:
  Sonnet/Haiku). Model names stay in one place per provider.
- **Env validation follows the choice.** In [lib/env.ts](lib/env.ts), `superRefine` requires
  `GEMINI_API_KEY` *only if* `LLM_PROVIDER=gemini`, and the same for Anthropic. You never need a key for
  a provider you aren't using.

We also avoid hard-coding a Gemini version: the defaults are Google's `gemini-flash-latest` and
`gemini-flash-lite-latest` **aliases**, which always point at the current models, so a retired version
can't break the app.

**The trade-off:** a common interface can only offer what every provider supports. Claude-only features
(like `fallbacks`) live inside the Claude adapter, and callers can't ask for them. That's fine here;
just be aware of it.

> **Try it:** add a third provider. Groq and Ollama both expose an OpenAI-compatible API. Create
> `providers/ollama.ts` that `fetch`es `http://localhost:11434/api/chat` with `format: <json schema>`,
> register it in `PROVIDERS`, and add `"ollama"` to the `LLM_PROVIDER` enum. Nothing else should need to
> change. If something does, the abstraction leaked.

---

## 11. The profile editor: polling and forms

[profile-editor.tsx](app/(app)/startups/[id]/profile/profile-editor.tsx)

### 11.1 A custom hook for polling

```ts
function useStartupStatus(initial) {
  const [startup, setStartup] = useState(initial);
  const inProgress = IN_PROGRESS.includes(startup.profile_status);

  useEffect(() => {
    if (!inProgress) return;                 // stop polling once ready/failed
    let cancelled = false;
    const timer = setInterval(async () => { ...fetch...; if (!cancelled) setStartup(next); }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };   // cleanup!
  }, [inProgress, initial.id]);

  return startup;
}
```

Lessons in these 15 lines:
- **The effect depends on `inProgress`**, so when the status flips to `ready`, React re-runs the effect.
  The early `return` means no new interval starts, and the cleanup has already cleared the old one.
  Polling stops by itself.
- **Cleanup functions** prevent leaks: leave the page and the interval dies.
- **The `cancelled` flag** handles a race: a fetch that started before unmount shouldn't call `setState`
  after it.
- Pulling this into `useStartupStatus` keeps the component readable. Custom hooks are just functions
  that use hooks.

Polling is the simplest way to get "live" status. Alternatives (websockets, Supabase Realtime,
server-sent events) are more work. Polling every 2s for a job that takes about 30s is perfectly fine.

### 11.2 Form state: lists as lines

The form stores **everything as strings**. List fields are edited one item per line in a textarea, then
converted: `lines(value)` splits, trims and drops blanks. `toForm` and `fromForm` convert between the
"API shape" and the "form shape". Keeping those two shapes separate and converting at the edges is a
clean, reusable pattern.

### 11.3 Validate on the client **and** the server

The client runs `startupProfileSchema.safeParse` for instant, per-field error messages. The server runs
**the same schema** again, because the client can never be trusted (anyone can call the API with
`curl`). Client validation is for UX; server validation is for correctness.

### 11.4 PUT vs POST on the same URL

- `PUT /api/startups/:id/profile` saves a draft (it's idempotent: same input, same result).
- `POST /api/startups/:id/profile` confirms: it saves, sets `confirmed`, writes the audit log and emits
  `profile.confirmed`.

Both call `loadEditable()` first, which checks the user is logged in, the startup exists *for them*
(RLS), and its status is `ready` or `confirmed`. You can't edit a profile that's still building.

> **Try it:** while a profile is building, run this in the devtools console:
> `fetch(location.pathname.replace('/startups','/api/startups'), {method:'PUT', headers:{'content-type':'application/json'}, body: '{}'}).then(r=>r.json())`
> and read the 400. Then send a valid body during `building` and get the 409.

---

## 12. TypeScript and zod patterns used everywhere

CLAUDE.md says: *"Small, typed functions; no `any`."* Here's how we kept to that:

| Pattern | Where | Why |
|---|---|---|
| `z.infer<typeof schema>` | schemas.ts | One source of truth for types plus validation |
| Discriminated unions (`{data} \| {response}`) | lib/api.ts | Errors without exceptions, narrowed by TS |
| `as const` | `MODELS`, `loadEditable` returns | Keeps literal types (`"claude-sonnet-5-5"`, not `string`) |
| `.maybeSingle<T>()` / `.single<T>()` | routes | Tells TS the row shape, returns `null` instead of throwing |
| Type guards `(p): p is ProfilePage => p !== null` | build-profile.ts | Filters `null`s *and* updates the type |
| `import "server-only"` | lib/* | Build-time guard against leaking secrets |
| Validated env ([lib/env.ts](lib/env.ts)) | everywhere on the server | Missing keys fail loudly on first use, with a clear list |
| `import type { X }` | many | Type-only imports are erased at build time |

**Why `serverEnv()` is a function with a cache and not a top-level constant:** if it validated at import
time, `next build` (which imports files but has no secrets) would crash. As a function, it validates
on **first use at runtime**, then reuses the result.

---

## 13. Tooling: typecheck, lint, build, and testing SQL

```bash
npm run typecheck   # next typegen && tsc --noEmit  → type errors
npm run lint        # eslint → style + React/Next bug patterns
npm run build       # full production build → catches server/client boundary issues too
```

Run all three before calling a milestone done. Each catches different problems.

### Proving a type is not `any`

A library can hand you `any` without complaint, and then TypeScript stops checking silently. We used a
trick to test it: temporarily assign the value to the wrong type.

```ts
const probe: number = event.data.startupId;   // should ERROR if startupId is typed as string
```

In the main handler this errored (good, it's typed). In `onFailure` it **didn't** error, which proved
`event.data.event.data` was `any`. The fix was to re-validate it with the zod schema:
`startupCreatedData.parse(event.data.event.data)`. **Don't assume, probe.**

### Testing SQL without a server

Docker wasn't running, so the migration was tested in **PGlite** (real Postgres compiled to WebAssembly,
running inside Node). The test script:
1. stubbed what Supabase provides (`auth.users`, `auth.uid()`, the `authenticated` role),
2. applied the migration,
3. switched roles with `set role authenticated` plus a fake user id, and tried things that **should** be
   blocked.

It checked 18 cases, for example "user B can't see A's startup", "a founder can't mark a message sent"
and "nobody can read the encrypted token". Testing that **forbidden things fail** matters as much as
testing that allowed things work.

---

## 14. Mistakes made along the way (and lessons)

Real mistakes, because these teach more than the clean parts:

1. **Your `claude.md` got overwritten.** Scaffolding created `CLAUDE.md`, and on Windows file names are
   case-**insensitive**, so it replaced `claude.md`. It was restored from memory.
   *Lesson: Windows and macOS filesystems treat `A.md` and `a.md` as the same file; Linux doesn't.
   Use git from day one so any overwrite is one `git checkout` away.* (This folder isn't a git repo
   yet. Run `git init` and commit!)

2. **`create extension pgcrypto` failed in PGlite.** It wasn't even needed: `gen_random_uuid()` is built
   into Postgres 13+. *Lesson: remove what you don't need; every extra dependency is something that can
   break.*

3. **The test script's `'\x00'` sent a null byte.** In a JS template string, `\x00` is an actual null
   character, not the text `\x00`. *Lesson: when a test fails, first ask whether the test itself is
   wrong.*

4. **A hidden `any` in `onFailure`.** See section 13. *Lesson: library types aren't always as strict as
   they look.*

5. **Framework version drift.** Next 16 renamed middleware to proxy; Inngest v4 moved triggers into the
   config (`triggers: [...]`); zod v4 has `z.url()` and `z.uuid()` at the top level. *Lesson: read the
   installed version's docs and types (`node_modules/<pkg>/*.d.ts`), not memory or old blog posts.*

---

## 15. Exercises to cement it

Do these in order. Each one is small, and each one touches a different layer.

**Warm-up**
1. `getUserId()` in [lib/supabase/server.ts](lib/supabase/server.ts) is defined but never used. Refactor
   the API routes to use it instead of calling `getClaims()` inline. Run typecheck.
2. Add a `created_at` "Created 3 minutes ago" line to each card on the home page.

**Database**

3. Write migration `0002_startup_rebuilds.sql` that adds `profile_attempts int not null default 0` to
   `startups`. Apply it in the Supabase SQL editor.
4. In SQL, try to break RLS: as user B, try `update startups set owner_id = '<B id>' where id = '<A's
   startup>'`. Explain *which* clause stops you (`using` or `with check`?).

**Backend**

5. Add a **"Retry"** button when a profile has `failed`. You need: a `POST /api/startups/[id]/rebuild`
   route (check ownership, set status `pending`, send `startup.created` again) and the button in the
   editor's failed card. Increment `profile_attempts` from exercise 3.
6. Make the job **also** fetch `/features` if it exists. (Hint: `profilePageUrls` in `reader.ts`, and
   make sure the step name stays unique.)

**Frontend**

7. Show a live elapsed timer ("Building… 12s") on the building card. (Hint: another `useEffect` +
   `setInterval`, with cleanup.)
8. Turn the list textareas into "chips": type, press Enter to add, × to remove. Keep `fromForm` working.

**Thinking questions** (write answers in your own words)

9. Why can't the Inngest job use `lib/supabase/server.ts`?
10. If we deleted the `enforce_message_status` trigger, what would still protect the "approved-only"
    rule, and what wouldn't?
11. What would break if `build-profile` did all its work in one big `step.run`?
12. Why is the publishable key safe to ship to browsers but the secret key isn't?

---

## 16. Glossary

- **App Router**: Next.js's routing system based on the `app/` folder.
- **Server Component**: a React component that runs only on the server (the default).
- **Client Component**: a component marked `"use client"`, interactive in the browser.
- **Server Action**: a `"use server"` function callable from forms or client code.
- **Route Handler**: `route.ts` exporting `GET`/`POST`/... to make an API endpoint.
- **Proxy**: `proxy.ts`, which runs before requests (formerly "middleware").
- **Migration**: a versioned SQL file that changes the schema.
- **RLS**: Row Level Security, per-row access rules enforced by Postgres.
- **Policy**: one RLS rule (`using` = which rows you can see or touch; `with check` = which rows you can
  write).
- **Service role**: Supabase's admin identity; bypasses RLS.
- **JWT / claims**: the signed token identifying the user; `sub` is the user id.
- **PKCE**: a login flow that ties a magic link to the browser that asked for it.
- **Event**: a named fact (`startup.created`) that functions can react to.
- **Step**: a checkpointed unit inside an Inngest function; retried alone, never re-run once done.
- **Idempotent**: doing it twice has the same effect as doing it once.
- **Structured outputs**: API-level constraint forcing the model's reply to match a JSON Schema.
- **Defense in depth**: several independent protections, so one bug isn't a breach.
- **SSRF**: tricking a server into fetching internal or private URLs.
- **Open redirect**: tricking a site into redirecting users to an attacker's URL.

---

# Part 2: Milestone 2 (YouTube discovery)

M2 answers two questions for a founder: **"How many people care about my problem, and where?"** and
**"Which small YouTubers talk to those people?"** It uses only the official YouTube Data API, the
confirmed profile from M1, and Gemini's free tier.

---

## 17. The M2 picture: from profile to top 30 creators

```
Confirm profile ──▶ profile.confirmed
                      └▶ build-context       profile → text → embedding (768 numbers) → startup_context
                           context.built
                      └▶ generate-queries    LLM writes 3–5 niches × 4–6 viewer-style searches → search_queries
"Find creators" ──▶ campaign row ──▶ /campaigns/:id/creators  (founder edits the queries)
"Start search"  ──▶ queries.confirmed
                      └▶ youtube-search      one search per query (100 units) + stats per 50 videos (1 unit)
                           youtube.searched
                      └▶ score-relevance     embed every video, relevance = cosine similarity (in SQL)
                           relevance.scored
                      └▶ estimate-demand     Σ views × relevance per niche
                           demand.estimated
                      └▶ build-creators      group videos by channel, channel stats, filters, rank_score
                           creators.built
                      └▶ score-creators      LLM "fit" in batches of 20 until 30 are scored
```

Each arrow is an **event**, and each box is its own Inngest function in [jobs/](jobs/). Why not one big
function? Each stage can fail, retry, and be inspected **on its own** in the Inngest dashboard
(http://localhost:8288 → Runs). You can also re-run just one stage by re-sending its event, and a
later platform (say Reddit) can listen to `queries.confirmed` without touching YouTube code.

**The data flows through the database, not through events.** Events only carry ids
(`{ campaignId, startupId }`). Each job loads what it needs. Events stay tiny, and every
intermediate result is visible in Supabase's Table Editor.

**Why top 30 and not 100?** You chose 30 small channels for small startups.
`DISCOVERY.campaignSize` in [lib/config.ts](lib/config.ts) controls it, so expanding later is a
one-number change (plus quota).

---

## 18. Embeddings and cosine similarity

### What an embedding is

An **embedding** turns text into a list of numbers (here 768) that captures its **meaning**. Think of
it as coordinates in a 768-dimensional "meaning space". Texts about similar things land near each
other, even when they share no words.

```
"How to get clients to pay invoices on time"   → [0.021, -0.113, 0.087, ...]  (768 numbers)
"Freelancers: stop chasing late payments"      → [0.019, -0.108, 0.091, ...]  ← close by
"India vs Australia cricket highlights"        → [-0.074, 0.032, -0.005, ...] ← far away
```

A model learned those coordinates from billions of sentences, so words like *invoice*, *late
payment* and *billing* end up pointing in similar directions.

### Cosine similarity

To compare two vectors we measure the **angle** between them, not the distance:

```
cosine similarity = (A · B) / (|A| × |B|)
   1.0  → same direction   → same meaning
   0.0  → perpendicular    → unrelated
```

`A · B` (the dot product) multiplies matching numbers and adds them up. Dividing by the lengths
removes "how long the text was", so only direction (meaning) counts.

### Why this beats keyword matching

| Keyword match | Embedding match |
|---|---|
| "invoice" misses a video titled "Getting paid as a freelancer" | Understands they're about the same thing |
| "Python" matches both the snake and the language | Context decides which one is meant |
| Needs you to guess every synonym | Synonyms come for free |

### Which model makes the embeddings?

Distro can use two, chosen by `EMBED_PROVIDER` in `.env.local`:

| | **local** (default) | **gemini** |
|---|---|---|
| Model | `bge-base-en-v1.5`, open-source, 8-bit quantized | `gemini-embedding-001` |
| Runs | on your CPU, inside the Next.js server ([lib/llm/providers/local-embed.ts](lib/llm/providers/local-embed.ts)) | Google's servers |
| Limit | none (~10 videos/second measured on your laptop) | 1,000 texts/day on the free tier |
| Cost | free (~100 MB model download, once) | free tier, then paid |

We started with Gemini because the brief named it, then switched to local after the free tier's
daily limit stopped real runs (section 29). The switch touched **one function**, `embedMany()`,
because every caller goes through it. That's the same adapter idea as the LLM providers.

**"Quantized"** means the model's weights are stored as 8-bit integers instead of 32-bit floats:
4× smaller and about 1.6× faster here, with nearly identical scores (average difference 0.007 on 200
real videos, and 45 of the top 50 the same). Always check that trade-off with your own data.

**Never compare vectors from different models.** Each model builds its own "map of meaning", so a
Gemini vector and a bge vector are like coordinates from two different atlases. Migration
[0003_embedding_model.sql](supabase/migrations/0003_embedding_model.sql) stores the model id next to
every vector (`embedding_model`):
- the relevance SQL only compares vectors with the **same** tag;
- `score-relevance` re-embeds the context and any video whose tag doesn't match the current model.

So when you move to a better model for real users, you change one setting and old vectors are
redone automatically.

### We measured it (and changed the brief's threshold)

Before writing code we embedded three sentences with **your** Gemini key:

```
invoice vs invoice-app : 0.841
invoice vs cricket     : 0.674   ← unrelated, but still 0.67!
```

Gemini's embeddings rarely go near 0 for normal text, and even unrelated sentences score about
0.6–0.7. A threshold of 0.6 would have kept **everything**, so we set 0.75 for Gemini. **Lesson:
measure before you trust a number from a spec.**

**Then we switched to the local bge model and measured again**, on mixar's 825 real videos:

```
invoice vs invoice-app : 0.73
invoice vs cricket     : 0.29   ← a much wider gap than Gemini's
~0.64  "MetaHuman Facial Rig Transfer for Blender"       on-topic
~0.60  "How to Rig a Hand in Blender 5.2"                 on-topic
~0.57  "Van Helsing's Flying Vampire Brides" + "UV Unwrap"  mixed
~0.49  "How To Make MILLIONS in Grow A Garden 2!"          junk
```

So `relevanceThreshold` is now **0.60**. The same number means different things for different
models, which is why the config comment says to re-measure after any model change. To do it
yourself, sort videos by relevance and read titles around the cut-off, as in exercise 1 of
section 29.

### Where it lives in the code

- [lib/analysis/context.ts](lib/analysis/context.ts) builds the context text from the one-liner,
  problem, ICP, use cases and keywords. `tone` and `creator_offer` are left out: they describe
  outreach, not the topic, and would blur the vector.
- [lib/llm/client.ts](lib/llm/client.ts) has `embed(text)` and `embedMany(texts)`, which send up to
  100 texts per API call.
- [lib/llm/providers/gemini.ts](lib/llm/providers/gemini.ts) has `geminiEmbed`, which asks for
  `outputDimensionality: 768`. The model's full size is 3072 dimensions, but it's trained so the
  first N numbers still work on their own ("Matryoshka" embeddings, like nesting dolls). 768 keeps
  storage small and fits pgvector's fast index limit (2000 dimensions).

> **Try it:** in the Supabase SQL editor, run `select context_text from startup_context;`. That's
> exactly what got embedded. Would you describe your startup differently? Edit the profile, re-confirm,
> and the context is rebuilt.

---

## 19. pgvector: vectors inside Postgres

[supabase/migrations/0002_youtube_discovery.sql](supabase/migrations/0002_youtube_discovery.sql):

```sql
create extension if not exists vector with schema extensions;
...
embedding extensions.vector(768)
```

`pgvector` adds a `vector` column type and distance operators. The one we use is `<=>`, **cosine
distance** (= 1 − cosine similarity). So relevance is computed *inside the database* in one
statement:

```sql
update content_items ci
   set relevance = 1 - (ci.embedding <=> sc.embedding)
  from startup_context sc
 where sc.startup_id = ci.startup_id and ci.startup_id = p_startup_id ...
```

Why do the maths in SQL instead of JavaScript?

- **No data shipping.** Thousands of 768-number vectors never leave the database.
- **Re-scoring is free.** If you re-confirm the profile, the context vector changes. Just re-run
  `score_content_relevance()` and every video is re-scored **without re-embedding** a single one,
  because each video's embedding is stored.
- **Threshold at read time.** We store the relevance of *every* video and filter with `>= threshold`
  when reading. Changing `relevanceThreshold` never needs a new YouTube search.

Two helper functions are **server-only** (`revoke ... from authenticated; grant ... to service_role`):
`set_content_embeddings` (saves 100 vectors in one round trip) and `score_content_relevance`.

---

## 20. Search queries in the viewer's words

[lib/llm/queries.ts](lib/llm/queries.ts) asks the fast model for
`{ niches: [{ name, queries[] }] }`, validated with zod (3–5 niches, 4–6 queries each).

The prompt insists on how real viewers type:

| Marketing words ❌ | Viewer words ✅ |
|---|---|
| "AI-powered invoicing platform" | "how to invoice clients as a freelancer" |
| "streamline your cash flow" | "clients not paying on time what to do" |
| "best-in-class solution" | "quickbooks vs wave for freelancers" |

People with a problem search for **the problem**, not for your product category. Videos answering
those searches are watched by exactly the audience you want.

**The founder reviews the queries before anything is spent.** Queries are saved as `pending`, and
the page shows them as editable inputs. Only "Start search" (`POST /api/campaigns/:id/start`) turns
them into `queued` and emits `queries.confirmed`. Each query costs 100 quota units, so a human
checks the plan first.

---

## 21. API quotas, pagination, batching ids, caching

### Quotas

A **quota** is how much of an API you may use per period. YouTube gives each project **10,000 units
a day**, and different calls cost different amounts:

| Call | Cost | What we use it for |
|---|---|---|
| `search.list` | **100** | find videos for a query |
| `videos.list` | 1 | stats for up to 50 videos |
| `channels.list` | 1 | stats for up to 50 channels |
| `playlistItems.list` | 1 | a channel's latest uploads |

So a run of 20 queries costs 2,000 units for searches plus about 50–200 for everything else.
That's roughly 4 full runs a day. Searching is the expensive part, which is why queries get
reviewed and cached.

**How we count** ([lib/discovery/quota.ts](lib/discovery/quota.ts) and the `consume_quota` SQL
function):

1. **Reserve before calling.** Every YouTube call first asks the database for its units. If the
   call crashes halfway, we've over-counted, never under-counted. Safe.
2. **Atomic.** `update ... set units = units + p_units where units + p_units <= p_limit` runs as one
   statement with a row lock, so two jobs running at the same moment can't both squeeze in past
   the limit.
3. **Stop at 9,000, not 10,000** (`youtubeDailyUnitStop`), which leaves headroom for mistakes and
   for manual testing.
4. **Pacific time.** Google resets the quota at midnight *Pacific*, so `quota_usage.day` is the
   Pacific date ([lib/time.ts](lib/time.ts)). India is 12½–13½ hours ahead, so your "new day" and
   Google's differ.

### Pagination

APIs don't return everything at once. A search returns at most 50 results plus a `nextPageToken`.
Sending the token back returns the next 50:

```
search(q)               → 50 results + nextPageToken "CDIQAA"
search(q, "CDIQAA")     → next 50   + nextPageToken "CGQQAA"
...
```

Every page of `search.list` costs another 100 units, so `searchPagesPerQuery` is **1**. The loop
in `searchVideos` ([lib/discovery/youtube.ts](lib/discovery/youtube.ts)) already supports more pages
if you raise it.

### Batching ids into one call

`videos.list` accepts **up to 50 ids in one call, for 1 unit**. Fetching stats for 1,000 videos
one by one would cost 1,000 units; in groups of 50 it costs 20. That's what
[lib/array.ts](lib/array.ts)'s `chunk()` is for:

```ts
for (const batch of chunk(ids, 50)) {
  await call("videos", { id: batch.join(","), ... }, 1 /* unit */, videosResponse);
}
```

One more trick: every channel's uploads playlist id is its channel id with `UC` replaced by `UU`,
so we get a channel's latest videos without an extra lookup call. We checked this against the real
API before relying on it.

### Caching

**Caching** means saving a result so the same question isn't asked (and paid for) twice. The rule:
*never repeat the same query for the same startup within 7 days*.

- `search_queries.query_norm` is `lower(btrim(query))`, a **generated column**: Postgres computes it,
  so "How To Invoice " and "how to invoice" count as the same query.
- Before searching, the job looks for a row with the same `query_norm` searched in the last 7 days.
  If it finds one, it reuses that row's `video_ids` and marks the new row `cached`, which costs
  0 units.

> **Try it:** run a search, then click "Search again" with the same queries. In the Inngest run, the
> search steps return `{ cached: true }`, and the quota counter on the page doesn't move.

---

## 22. Retries, backoff, and typed errors

Every platform module goes through [lib/discovery/http.ts](lib/discovery/http.ts):

- **Retries** on network errors, 408, 429 and 5xx.
- **Exponential backoff:** wait 1s, then 2s, then 4s. Hammering a struggling server makes things
  worse.
- **Jitter:** a random extra 0–250 ms, so many workers don't all retry at the same instant.
- It **returns** 4xx responses instead of throwing, because only the platform module knows what
  they mean.

[lib/discovery/youtube.ts](lib/discovery/youtube.ts) turns YouTube's errors into **typed errors**
([lib/discovery/types.ts](lib/discovery/types.ts)):

| YouTube says | We throw | What happens |
|---|---|---|
| 403 `quotaExceeded` / `dailyLimitExceeded` | `QuotaExhaustedError` | pause until tomorrow (section 26) |
| 400 / 401 / 403 / 404 (bad key, API off, missing) | `DiscoveryConfigError` | fail now: retrying can't fix a bad key |
| 5xx, other | plain `Error` | Inngest retries the step |

Every response is also **validated with zod** before use. YouTube sends counts as *strings*
(`"viewCount": "1821702351"`), so `z.coerce.number()` converts them. Channels that hide their
subscriber count get `null` ("unknown"), never 0, because 0 would wrongly pass or fail filters.

The same idea applies to the LLM: a Gemini 429 becomes `LlmRateLimitError`, which
[jobs/helpers.ts](jobs/helpers.ts) turns into Inngest's `RetryAfterError` ("wait 60 s, then retry
only this step").

---

## 23. Upserts and unique constraints

An **upsert** is "insert, or update if it already exists". It's what makes re-running safe:

```ts
await admin.from("content_items").upsert(rows, { onConflict: "startup_id,platform,video_id" });
```

Postgres needs to know **what "already exists" means**, and that's the job of a **unique
constraint**:

```sql
constraint content_items_startup_video_key unique (startup_id, platform, video_id)
```

Without it, two queries finding the same video would create two rows, the video's views would be
counted twice in the demand estimate, and the channel would look twice as relevant. Unique
constraints protect data integrity **in the database**, so no code path can create duplicates.

Upserts used in M2:

| Table | Unique on | Why |
|---|---|---|
| `startup_context` | `startup_id` | one context per startup; re-confirming replaces it |
| `content_items` | `startup_id, platform, video_id` | same video found by many queries = one row; stats refresh |
| `creators` | `platform, handle` | shared pool: a channel found by two startups is **one** creator |
| `matches` | `campaign_id, creator_id` | re-running refreshes rank, keeps fit scores |
| `demand_estimates` | `startup_id, niche` | one estimate per niche |

We store the YouTube **channel id** (`UCxxxx`) in `creators.handle`, not the @handle, because
@handles can be changed by the creator and ids can't. A key that changes can't be a key.

`platform` is in the `content_items` key on purpose: when Reddit is added, a Reddit post id can
never collide with a YouTube video id.

---

## 24. Estimating demand (and why it's only an estimate)

[lib/analysis/demand.ts](lib/analysis/demand.ts), a **pure function** (no database, no network):

```
per niche:  interested_estimate = Σ (views × relevance)   over videos with relevance ≥ threshold
            total_comments      = Σ comments
            top_video_ids       = the 3 videos with the biggest views × relevance
```

Multiplying by relevance means a view on a loosely related video counts less than a view on a
spot-on one.

### Why it's only an estimate

| Weakness | Effect |
|---|---|
| **The same person watches many videos** | 10 relevant videos watched by the same 1,000 people count as 10,000 |
| **Old views** | a video from 11 months ago counts all its views, even if interest has faded |
| **Bots and rewatches** | view counts aren't unique humans |
| **Views ≠ buyers** | a student researching "invoicing" isn't a freelancer who'll pay |
| **Search ranking bias** | YouTube's top 50 results favour popular videos, so the long tail is missing |
| **One niche per video** | a video found by two niches is credited to the first only |

So the UI always says **"estimated interested views"** and shows the **evidence videos**. A founder
can click them and judge for themselves. The honest use of this number is to **compare niches**
("Freelance invoicing ≫ Small agency billing"), not to predict sales.

---

## 25. Building and ranking creators

[jobs/build-creators.ts](jobs/build-creators.ts), step by step:

1. **Group relevant videos by channel.** For each channel: relevant views, average relevance, number
   of relevant videos.
2. **Channel stats** (`channels.list`, 50 per call): subscribers, description, country, thumbnail.
   Every channel goes into the shared `creators` pool.
3. **Subscriber filter:** 5,000–200,000 (`DISCOVERY.subscribers`). Small but real channels.
4. **Recent uploads** (`playlistItems.list`, 1 unit per channel, **only** for channels in range, to
   save quota): last upload date plus the 10 latest titles (the LLM uses these later).
5. **Activity filter:** uploaded within 60 days, and at least 1 relevant video.
6. **Email:** [lib/discovery/email-extract.ts](lib/discovery/email-extract.ts) looks in the channel
   description the creator published. It understands anti-spam spellings like
   `name [at] domain [dot] com` and prefers emails near words like "business" or "sponsor". No other
   site is fetched. Channels without an email are **kept but flagged** ("Email: No").
7. **rank_score** saved to `matches`.

### The formula

[lib/analysis/score.ts](lib/analysis/score.ts):

```
rank_score = avg_relevance × log10(relevant_views + subscribers)
```

`log10` squashes size: 10k → 4, 100k → 5, 1M → 6. A channel 10× bigger only gets +1, so
relevance (0–1) matters as much as size. That's what you want for **small** creators.

**A trade-off the tests found:** at relevance 0.90 vs 0.76, a channel 7× bigger still *narrowly*
wins (4.03 vs 4.00). The test `(known trade-off)` in [tests/score.test.ts](tests/score.test.ts)
documents it. If you want relevance to dominate, try `avg_relevance² × log10(...)`, run `npm test`,
and watch which tests change. That's exactly what tests are for.

### The funnel

The page shows where candidates drop out:
`Videos found → Relevant → Channels → 5k–200k subs → Active → With email`. If you only get 12
creators instead of 30, the funnel tells you which filter to loosen, or whether to add queries.

---

## 26. Batches of 20, idempotency, and sleeping until tomorrow

### Why batch?

[jobs/score-creators.ts](jobs/score-creators.ts) sends creators to the LLM **20 at a time**, and 30
creators means 2 batches (20 + 10):

| Reason | Explanation |
|---|---|
| **Rate limits** | the free Gemini tier allows a limited number of requests per minute; 2 calls instead of 30 |
| **Cost and tokens** | one prompt with shared instructions + 20 creators is far cheaper than 20 prompts repeating the instructions |
| **Partial progress** | each batch **saves immediately**; if batch 2 fails, batch 1's 20 creators are already on the page |
| **Comparable scores** | the model sees 20 creators side by side, so its 0–100 scale is more consistent |

Creators are labelled `c1…c20` instead of UUIDs, and the zod schema only allows exactly those
labels (`z.enum(labels)`) and exactly 20 answers (`.length(20)`). The model **can't** invent a
creator or skip one; if it tries, validation fails and `generateJson` retries.

### Idempotency

**Idempotent** means *doing it twice gives the same result as doing it once*. It's crucial with
retries, because you never know if a crashed step "half happened". Two layers make scoring
idempotent:

1. **Inngest memoization.** `score-batch-1` finished means its result is saved, and a retry of the
   function skips straight to `score-batch-2`.
2. **The database decides what's left.** Each batch picks matches `where fit_score is null`, so even
   a brand-new run (for example after "Search again") only scores what isn't scored yet. It never
   pays twice for the same creator.

### Sleeping until tomorrow

When our 9,000-unit budget is used up, `runYoutubeStep` in [jobs/helpers.ts](jobs/helpers.ts):

1. sets the campaign to `paused_quota` (the page shows *"YouTube quota reached, continuing tomorrow"*);
2. calls `step.sleepUntil(midnight Pacific + 5 min)`. **The function is paused for free:** nothing
   runs and nothing polls, and Inngest wakes it up;
3. retries the same work under a new step id (`search-<id>-retry-1`).

A subtle detail: "tomorrow" is computed **inside a `step.run`**. Inngest replays your function code
on every step. If we called `nextPacificMidnight()` outside a step, each replay could compute a
different time. Inside a step, the result is saved and replays reuse it. **Rule: anything
non-deterministic (time, random numbers, API calls) goes inside a step.**

---

## 27. The Audience & Creators page: data fetching

Files: [app/(app)/campaigns/[id]/creators/](app/(app)/campaigns/[id]/creators/)

| Layer | Where | Why |
|---|---|---|
| First snapshot | `page.tsx` (server) calls `loadCampaignOverview` | the page arrives already filled in, with no spinner |
| Live updates | `campaign-view.tsx` polls `GET /api/campaigns/:id` every 3 s **only while jobs run** | same pattern as M1's profile page |
| Table data | `creators-table.tsx` fetches `GET /api/campaigns/:id/creators?page&sort&dir&hasEmail` | sorting and paging happen in the database, so it still works at 10,000 rows |

The server snapshot and the API use **the same function**, `loadCampaignOverview` in
[lib/campaigns.ts](lib/campaigns.ts), so they can never disagree.

### A view for sorting by any column

The table mixes columns from `matches` (fit, scores) and `creators` (subscribers, name). Sorting a
parent table by a joined table's column is awkward through Supabase's API, so the migration creates
a **view**, a saved query that behaves like a table:

```sql
create view public.campaign_creators with (security_invoker = true) as
select m.*, c.display_name, c.audience_size as subscribers, (c.email is not null) as has_email,
       row_number() over (partition by m.campaign_id, (m.removed_at is null)
                          order by m.final_score desc nulls last) as final_rank
from matches m join creators c on c.id = m.creator_id;
```

- `security_invoker = true` is **critical**. The view runs with the *caller's* permissions, so RLS on
  `matches` still hides other founders' rows. Without it, a view runs as its owner and would leak
  everything. (Our migration test checks this: user B sees 0 rows.)
- `row_number() over (...)` is a **window function**: each row gets its rank without collapsing
  rows like `GROUP BY` does. So "#3" stays #3 even when you sort by subscribers.
- `has_email` exposes **yes or no, not the email itself**. The page only needs the flag.

### A sort whitelist

```ts
sort: z.enum(CREATOR_SORT_COLUMNS).default("final_rank")
```

The column name comes from the URL, and anything not in the list is rejected. Never pass a URL
value straight into a query as a column name.

### React: fetch in an effect, set state in the callback

ESLint rejected our first version of the table's effect (`react-hooks/set-state-in-effect`). The fix
is the standard pattern: start the fetch in `useEffect`, set state in its `.then`, and use a
`cancelled` flag so a slow old response can't overwrite a newer one when you click through pages
quickly. "Remove" bumps a `reloadTick` counter that is in the effect's dependencies, which
triggers a clean re-fetch.

**Removed creators are hidden, not deleted** (`matches.removed_at`). That's reversible, keeps a
history, and the PATCH route accepts `{ removed: false }` to restore one.

---

## 28. Unit tests with Vitest

`npm test` runs [tests/](tests/) with Vitest: 27 tests in under a second.

**What we test:** only **pure functions**, meaning same input, same output, no network, no database:
`rankScore`, `finalScore`, `estimateDemand`, `extractBusinessEmail`, `chunk`, the Pacific-time
helpers and `buildContextText`. That's why those live in [lib/analysis/](lib/analysis/) and
[lib/discovery/email-extract.ts](lib/discovery/email-extract.ts), apart from the code that
talks to APIs.

A good test checks **behaviour you care about**, not just "it runs":

```ts
it("grows slowly with size: 10× the reach adds only +1 before relevance", ...)
it("handles the night clocks change (DST ends Nov 1 2026)", ...)
```

**The tests caught a real surprise:** our first expectation, "a more relevant small channel always
beats a big vague one", was **false** for the brief's formula. Instead of bending the test, we
documented the trade-off (section 25). Tests turn assumptions into facts.

Setup notes:
- [vitest.config.mts](vitest.config.mts) maps `@/…` imports like the app does.
- Installing Vitest 5 required upgrading `@types/node` from 20 to 24, to match the Node 24 you run.

---

## 29. M2 lessons and exercises

### Lessons from building it

1. **Measure thresholds with real data.** 0.6 would have kept cricket videos for an invoicing
   startup.
2. **Check API assumptions with cheap calls.** We confirmed the `UC→UU` uploads trick, field names
   and the `404 playlistNotFound` reason for 3 units before relying on them.
3. **Quota is a design constraint, not an afterthought.** It shaped query review, caching, 1 page
   per query, id batching, and filtering *before* the per-channel calls.
4. **Know which limits are per minute and which are per day, and what counts as one request.**
   The first real runs failed with a Gemini `429`. The code treated every 429 as "wait a minute",
   but this one was `EmbedContentRequestsPerDay…FreeTier` with a limit of **1,000**. Every *text*
   counts, even inside a batch of 100, so two startups (825 + ~175 videos) used the whole day's
   budget, and the third run failed after three pointless 60-second retries. The fix follows the
   same pattern as YouTube:
   - we **count embeddings ourselves** (`quota_usage` row `gemini_embed`, stop at 950, in
     `embedMany`);
   - a 429 whose quota id contains `PerDay` becomes `QuotaExhaustedError`, which **pauses the run
     until midnight Pacific** instead of failing ([lib/llm/providers/gemini.ts](lib/llm/providers/gemini.ts));
   - `runQuotaStep` ([jobs/helpers.ts](jobs/helpers.ts)) now wraps every quota-spending step,
     YouTube and Gemini alike.

   Rule of thumb: **a per-minute limit → wait and retry; a per-day limit → pause until reset; a bad
   request → fail now.**
5. **Runs can get stuck when the job runner restarts.** The Inngest dev server keeps runs in
   memory, so stopping it mid-run leaves a campaign saying "Scoring…" forever.
   [lib/campaign-status.ts](lib/campaign-status.ts) treats a run as stuck after 30 minutes without
   progress, and the page then offers "Search again". The cache makes that cheap: 0 search units,
   and only missing embeddings are redone.
6. **Test the database like code.** The migration was applied to a local Postgres with pgvector
   (PGlite 0.3; newer PGlite dropped the bundled vector extension), with 15 checks, including
   "user B can't see A's creators through the view".

### Exercises

These were the parts you'd have written yourself. Try re-implementing or changing them now:

1. **Tune the threshold.** After a real run, look at the spread of scores:
   `select round(relevance::numeric,2) r, count(*) from content_items group by 1 order by 1 desc;`
   Pick the value where titles stop being on-topic, and change `relevanceThreshold`. No re-search
   needed (section 19).
2. **Write `chunk()` yourself.** Delete the body in [lib/array.ts](lib/array.ts), rewrite it, and
   run `npm test` until the `chunk` tests pass.
3. **Change the ranking.** Make relevance count double (`avgRelevance ** 2`), update the
   `(known trade-off)` test to match, and see whether your top 30 changes.
4. **"Restore removed" button.** The API already supports `{ removed: false }`. Add a "Show removed
   (n)" toggle to the table.
5. **Show the quota in the Inngest run.** Make each `search-…` step return the units used so far
   (hint: `reserveQuota` returns the new total).
6. **Second platform (design only).** Sketch `lib/discovery/reddit.ts`: which functions, which
   `DiscoveredContent` fields map from a Reddit post, and which event it would listen to. Don't
   build it yet: check CLAUDE.md's rules and Reddit's API terms first.

### Thinking questions

7. Why does `consume_quota` reserve units **before** the API call instead of counting after?
8. What would go wrong if `creators` were unique on `(platform, display_name)`?
9. Why is `nextPacificMidnight()` called inside `step.run` and not directly in the function?
10. The demand estimate for one niche is 2.4M. Give three reasons the real number of potential
    customers is smaller.

### Glossary (M2)

- **Embedding**: a list of numbers representing the meaning of a text.
- **Cosine similarity**: the angle-based similarity of two vectors; 1 = same meaning.
- **pgvector**: the Postgres extension adding a `vector` type and distance operators (`<=>`).
- **Quota**: an API usage allowance per period (YouTube: 10,000 units a day).
- **Pagination**: fetching results page by page with a `nextPageToken`.
- **Batching**: sending many items in one call (50 ids per `videos.list`, 20 creators per LLM call).
- **Cache**: a saved result reused instead of asking again (7-day query cache).
- **Backoff / jitter**: waiting longer after each failure, plus randomness.
- **Upsert**: insert or update, keyed by a unique constraint.
- **Idempotent**: safe to run twice; same result as running once.
- **View / security_invoker**: a saved query; runs with the caller's permissions so RLS applies.
- **Window function**: a per-row calculation over related rows (`row_number() over (...)`).
- **Pure function**: same input → same output, no side effects; easy to unit test.

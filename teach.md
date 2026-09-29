# Learning Distro: what we built in Milestone 1, and why

This guide explains every piece of Milestone 1 (M1): what it does, **why** it's built that way, and which
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

**Next milestone preview (M2):** a new job subscribes to `profile.confirmed`, uses the profile's
`icp` and `keywords` to map channels (YouTube niches, newsletters...), and starts creator discovery.
You now know every building block it will use: events, steps, `generateJson`, admin client, RLS.

-- Distro — initial schema.
-- RLS model: a founder (auth.users row) owns startups; every startup-scoped row is visible
-- only to that startup's owner. Background jobs use the service role (bypasses RLS).


-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
create type public.profile_status as enum ('pending', 'building', 'ready', 'failed', 'confirmed');
create type public.campaign_status as enum ('draft', 'active', 'paused', 'completed');
create type public.platform as enum ('youtube', 'instagram', 'x', 'newsletter', 'tiktok', 'podcast', 'blog', 'other');
create type public.message_channel as enum ('email', 'instagram_dm', 'x_dm');
create type public.message_status as enum ('draft', 'approved', 'queued', 'sent', 'replied', 'failed');
create type public.reply_source as enum ('gmail', 'manual');
create type public.reply_class as enum ('positive', 'question', 'negotiating', 'not_now', 'negative', 'opt_out', 'auto_reply', 'bounce', 'other');
create type public.conversion_kind as enum ('click', 'signup');
create type public.suppression_reason as enum ('opt_out', 'negative_reply', 'bounce', 'manual');

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- startups
-- ─────────────────────────────────────────────────────────────────────────────
create table public.startups (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  url             text not null,
  name            text,
  notes           text,
  profile_json    jsonb,
  profile_status  public.profile_status not null default 'pending',
  profile_error   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index startups_owner_id_idx on public.startups (owner_id);
create trigger startups_updated_at before update on public.startups
  for each row execute function public.set_updated_at();

-- Ownership check used by every startup-scoped policy. SECURITY DEFINER so it is not
-- itself subject to RLS on startups (avoids policy recursion).
create or replace function public.owns_startup(p_startup_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.startups s
    where s.id = p_startup_id and s.owner_id = (select auth.uid())
  );
$$;
revoke all on function public.owns_startup(uuid) from public;
grant execute on function public.owns_startup(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- campaigns
-- ─────────────────────────────────────────────────────────────────────────────
create table public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  startup_id       uuid not null references public.startups (id) on delete cascade,
  name             text not null,
  status           public.campaign_status not null default 'draft',
  daily_send_cap   integer not null default 30 check (daily_send_cap between 1 and 200),
  paused_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index campaigns_startup_id_idx on public.campaigns (startup_id);
create trigger campaigns_updated_at before update on public.campaigns
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- creators (shared pool across all startups)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.creators (
  id              uuid primary key default gen_random_uuid(),
  platform        public.platform not null,
  handle          text not null,
  display_name    text,
  profile_url     text,
  email           text,
  audience_size   integer check (audience_size >= 0),
  last_active_at  timestamptz,
  niche           text,
  bio             text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint creators_platform_handle_key unique (platform, handle)
);
create trigger creators_updated_at before update on public.creators
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- matches (creator ↔ campaign, with fit score)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.matches (
  id           uuid primary key default gen_random_uuid(),
  startup_id   uuid not null references public.startups (id) on delete cascade,
  campaign_id  uuid not null references public.campaigns (id) on delete cascade,
  creator_id   uuid not null references public.creators (id) on delete cascade,
  fit_score    numeric(5, 2) check (fit_score between 0 and 100),
  fit_reasons  jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  constraint matches_campaign_creator_key unique (campaign_id, creator_id)
);
create index matches_startup_id_idx on public.matches (startup_id);
create index matches_creator_id_idx on public.matches (creator_id);
-- campaign_id is covered by the leading column of matches_campaign_creator_key.

-- ─────────────────────────────────────────────────────────────────────────────
-- connected_accounts (founder's Gmail via OAuth). Owned by the user, not a startup.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.connected_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider           text not null default 'google' check (provider in ('google')),
  email              text not null,
  sender_name        text not null,
  scopes             text[] not null default '{}',
  -- AES-256-GCM ciphertext (iv || tag || ciphertext) of the OAuth refresh token.
  refresh_token_enc  bytea,
  daily_send_cap     integer not null default 30 check (daily_send_cap between 1 and 200),
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint connected_accounts_user_email_key unique (user_id, provider, email)
);
create trigger connected_accounts_updated_at before update on public.connected_accounts
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- messages
-- ─────────────────────────────────────────────────────────────────────────────
create table public.messages (
  id                    uuid primary key default gen_random_uuid(),
  startup_id            uuid not null references public.startups (id) on delete cascade,
  campaign_id           uuid not null references public.campaigns (id) on delete cascade,
  match_id              uuid not null references public.matches (id) on delete cascade,
  connected_account_id  uuid references public.connected_accounts (id) on delete set null,
  channel               public.message_channel not null,
  variant               smallint not null default 1 check (variant in (1, 2)),
  subject               text,
  body                  text not null,
  status                public.message_status not null default 'draft',
  approved_by           uuid references auth.users (id) on delete set null,
  approved_at           timestamptz,
  scheduled_for         timestamptz,
  sent_at               timestamptz,
  gmail_message_id      text,
  gmail_thread_id       text,
  error                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index messages_startup_id_idx on public.messages (startup_id);
create index messages_campaign_id_idx on public.messages (campaign_id);
create index messages_match_id_idx on public.messages (match_id);
create index messages_connected_account_id_idx on public.messages (connected_account_id);
create index messages_approved_by_idx on public.messages (approved_by);
create index messages_status_idx on public.messages (status);
create index messages_gmail_thread_id_idx on public.messages (gmail_thread_id) where gmail_thread_id is not null;
create trigger messages_updated_at before update on public.messages
  for each row execute function public.set_updated_at();

-- Hard rule: nothing is sent without human approval. Enforced in the database so no code
-- path (including a buggy job) can move a message to queued/sent without an approval.
create or replace function public.enforce_message_status()
returns trigger
language plpgsql
as $$
declare
  is_server boolean := coalesce(auth.role(), '') = 'service_role'
                       or current_user in ('postgres', 'service_role');
begin
  if new.status in ('approved', 'queued', 'sent', 'replied') and (new.approved_at is null or new.approved_by is null) then
    raise exception 'message % cannot be % without a human approval', new.id, new.status;
  end if;
  if tg_op = 'UPDATE' and new.status in ('queued', 'sent')
     and old.status not in ('approved', 'queued', 'sent') then
    raise exception 'message % must be approved before it is %', new.id, new.status;
  end if;
  if not is_server then
    -- Founders can only move messages between draft and approved, approving as themselves.
    if new.status not in ('draft', 'approved') then
      raise exception 'status % can only be set by the server', new.status;
    end if;
    if tg_op = 'UPDATE' and old.status not in ('draft', 'approved') and new.status is distinct from old.status then
      raise exception 'message % is already % and cannot be changed', new.id, old.status;
    end if;
    if new.status = 'approved' and new.approved_by is distinct from auth.uid() then
      raise exception 'approved_by must be the approving user';
    end if;
  end if;
  return new;
end;
$$;
create trigger messages_enforce_status before insert or update on public.messages
  for each row execute function public.enforce_message_status();

-- ─────────────────────────────────────────────────────────────────────────────
-- replies
-- ─────────────────────────────────────────────────────────────────────────────
create table public.replies (
  id                   uuid primary key default gen_random_uuid(),
  startup_id           uuid not null references public.startups (id) on delete cascade,
  message_id           uuid not null references public.messages (id) on delete cascade,
  source               public.reply_source not null,
  from_address         text,
  body                 text not null,
  received_at          timestamptz not null default now(),
  gmail_message_id     text unique,
  classification       public.reply_class,
  classification_json  jsonb,
  created_at           timestamptz not null default now()
);
create index replies_startup_id_idx on public.replies (startup_id);
create index replies_message_id_idx on public.replies (message_id);
create index replies_classification_idx on public.replies (startup_id, classification);

-- ─────────────────────────────────────────────────────────────────────────────
-- links (unique tracking links /c/:slug per creator match)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.links (
  id               uuid primary key default gen_random_uuid(),
  startup_id       uuid not null references public.startups (id) on delete cascade,
  match_id         uuid not null references public.matches (id) on delete cascade,
  slug             text not null unique check (slug ~ '^[a-zA-Z0-9_-]{4,64}$'),
  destination_url  text not null,
  created_at       timestamptz not null default now()
);
create index links_startup_id_idx on public.links (startup_id);
create index links_match_id_idx on public.links (match_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- conversions (clicks + signups attributed to a link)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.conversions (
  id           uuid primary key default gen_random_uuid(),
  startup_id   uuid not null references public.startups (id) on delete cascade,
  link_id      uuid not null references public.links (id) on delete cascade,
  kind         public.conversion_kind not null,
  external_id  text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index conversions_startup_id_idx on public.conversions (startup_id);
create index conversions_link_id_idx on public.conversions (link_id, kind);
create unique index conversions_signup_dedupe_idx on public.conversions (link_id, external_id)
  where kind = 'signup' and external_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- suppression (never contact again for this startup)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.suppression (
  id          uuid primary key default gen_random_uuid(),
  startup_id  uuid not null references public.startups (id) on delete cascade,
  creator_id  uuid references public.creators (id) on delete set null,
  email       text,
  platform    public.platform,
  handle      text,
  reason      public.suppression_reason not null,
  created_at  timestamptz not null default now(),
  constraint suppression_target_check check (email is not null or (platform is not null and handle is not null))
);
create index suppression_startup_id_idx on public.suppression (startup_id);
create index suppression_creator_id_idx on public.suppression (creator_id);
create unique index suppression_email_key on public.suppression (startup_id, lower(email)) where email is not null;
create unique index suppression_handle_key on public.suppression (startup_id, platform, lower(handle)) where handle is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log (append-only; written by the server with the service role)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.audit_log (
  id           bigint generated always as identity primary key,
  startup_id   uuid references public.startups (id) on delete cascade,
  actor_id     uuid references auth.users (id) on delete set null,
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index audit_log_startup_id_idx on public.audit_log (startup_id, created_at desc);
create index audit_log_actor_id_idx on public.audit_log (actor_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.startups           enable row level security;
alter table public.campaigns          enable row level security;
alter table public.creators           enable row level security;
alter table public.matches            enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.messages           enable row level security;
alter table public.replies            enable row level security;
alter table public.links              enable row level security;
alter table public.conversions        enable row level security;
alter table public.suppression        enable row level security;
alter table public.audit_log          enable row level security;

-- Nothing is readable anonymously. (/c/:slug redirects run server-side with the service role.)
revoke all on all tables in schema public from anon;

-- startups: owner only
create policy startups_select on public.startups for select to authenticated
  using (owner_id = (select auth.uid()));
create policy startups_insert on public.startups for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy startups_update on public.startups for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy startups_delete on public.startups for delete to authenticated
  using (owner_id = (select auth.uid()));

-- Startup-scoped tables founders may manage directly.
create policy campaigns_all on public.campaigns for all to authenticated
  using (public.owns_startup(startup_id)) with check (public.owns_startup(startup_id));
create policy matches_all on public.matches for all to authenticated
  using (public.owns_startup(startup_id)) with check (public.owns_startup(startup_id));
create policy messages_all on public.messages for all to authenticated
  using (public.owns_startup(startup_id)) with check (public.owns_startup(startup_id));
create policy replies_all on public.replies for all to authenticated
  using (public.owns_startup(startup_id)) with check (public.owns_startup(startup_id));
create policy links_all on public.links for all to authenticated
  using (public.owns_startup(startup_id)) with check (public.owns_startup(startup_id));
create policy suppression_all on public.suppression for all to authenticated
  using (public.owns_startup(startup_id)) with check (public.owns_startup(startup_id));

-- Read-only to founders; written by the server (signup webhook / redirect route).
create policy conversions_select on public.conversions for select to authenticated
  using (public.owns_startup(startup_id));
revoke insert, update, delete on public.conversions from authenticated;

-- audit_log: owners can read their startup's log; no client writes, no edits ever.
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.owns_startup(startup_id));
revoke insert, update, delete, truncate on public.audit_log from authenticated;

-- creators: shared pool — any signed-in founder can read; only jobs (service role) write.
create policy creators_select on public.creators for select to authenticated
  using (true);
revoke insert, update, delete on public.creators from authenticated;

-- connected_accounts: the user sees their own rows, but never the encrypted token.
-- OAuth connect/refresh runs server-side with the service role.
create policy connected_accounts_select on public.connected_accounts for select to authenticated
  using (user_id = (select auth.uid()));
create policy connected_accounts_update on public.connected_accounts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy connected_accounts_delete on public.connected_accounts for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.connected_accounts from authenticated;
grant select (id, user_id, provider, email, sender_name, scopes, daily_send_cap, revoked_at, created_at, updated_at)
  on public.connected_accounts to authenticated;
grant update (sender_name, daily_send_cap, revoked_at) on public.connected_accounts to authenticated;
grant delete on public.connected_accounts to authenticated;

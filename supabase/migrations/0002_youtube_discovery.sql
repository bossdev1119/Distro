-- Milestone 2: YouTube discovery.
-- startup_context (embedding) → search_queries → content_items (videos) → demand_estimates
-- → creators (shared pool) → matches (per campaign, ranked + fit-scored).

create extension if not exists vector with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
create type public.context_status as enum ('embedding', 'generating_queries', 'ready', 'failed');
create type public.query_status as enum ('pending', 'queued', 'searched', 'cached', 'failed');
create type public.campaign_stage as enum (
  'awaiting_queries', 'searching', 'paused_quota', 'scoring_relevance',
  'estimating_demand', 'building_creators', 'scoring_creators', 'done', 'failed'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- startup_context: one embedding per startup describing what it is about
-- ─────────────────────────────────────────────────────────────────────────────
create table public.startup_context (
  id            uuid primary key default gen_random_uuid(),
  startup_id    uuid not null unique references public.startups (id) on delete cascade,
  context_text  text not null,
  -- 768 must match DISCOVERY.embeddingDimensions in lib/config.ts.
  embedding     extensions.vector(768),
  status        public.context_status not null default 'embedding',
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger startup_context_updated_at before update on public.startup_context
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- search_queries: what we search YouTube for (founder reviews them first)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.search_queries (
  id            uuid primary key default gen_random_uuid(),
  startup_id    uuid not null references public.startups (id) on delete cascade,
  niche         text not null,
  query         text not null check (length(query) between 2 and 200),
  -- Normalized text used for the 7-day "never search the same thing twice" cache.
  query_norm    text generated always as (lower(btrim(query))) stored,
  status        public.query_status not null default 'pending',
  video_ids     text[] not null default '{}',
  searched_at   timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);
create index search_queries_startup_status_idx on public.search_queries (startup_id, status);
create index search_queries_cache_idx on public.search_queries (startup_id, query_norm, searched_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- content_items: every video found, with stats, embedding and relevance
-- ─────────────────────────────────────────────────────────────────────────────
create table public.content_items (
  id             uuid primary key default gen_random_uuid(),
  startup_id     uuid not null references public.startups (id) on delete cascade,
  platform       public.platform not null default 'youtube',
  video_id       text not null,
  url            text not null,
  title          text not null,
  description    text not null default '',
  channel_id     text not null,
  channel_title  text,
  thumbnail_url  text,
  views          bigint not null default 0,
  likes          bigint,
  comments       bigint,
  published_at   timestamptz,
  niche          text,
  embedding      extensions.vector(768),
  -- Cosine similarity with startup_context (null until scored). Threshold applied at read time,
  -- so tuning DISCOVERY.relevanceThreshold never needs a new search.
  relevance      real,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Platform in the key so other platforms can reuse this table later.
  constraint content_items_startup_video_key unique (startup_id, platform, video_id)
);
create index content_items_channel_idx on public.content_items (startup_id, channel_id);
create index content_items_relevance_idx on public.content_items (startup_id, relevance desc);
create trigger content_items_updated_at before update on public.content_items
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- demand_estimates: interested-audience estimate per niche
-- ─────────────────────────────────────────────────────────────────────────────
create table public.demand_estimates (
  id                   uuid primary key default gen_random_uuid(),
  startup_id           uuid not null references public.startups (id) on delete cascade,
  niche                text not null,
  interested_estimate  bigint not null default 0,
  relevant_videos      integer not null default 0,
  total_comments       bigint not null default 0,
  top_video_ids        text[] not null default '{}',
  computed_at          timestamptz not null default now(),
  constraint demand_estimates_startup_niche_key unique (startup_id, niche)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- quota_usage: YouTube units spent per day (Pacific time — when Google resets quota)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.quota_usage (
  provider    text not null,
  day         date not null,
  units       integer not null default 0 check (units >= 0),
  updated_at  timestamptz not null default now(),
  primary key (provider, day)
);

-- Atomically reserves units. Returns the new total, or -1 if it would pass p_limit.
-- The UPDATE's row lock makes concurrent callers queue, so two jobs can't both squeeze in.
create or replace function public.consume_quota(p_provider text, p_day date, p_units integer, p_limit integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_units integer;
begin
  insert into public.quota_usage (provider, day) values (p_provider, p_day) on conflict do nothing;
  update public.quota_usage
     set units = units + p_units, updated_at = now()
   where provider = p_provider and day = p_day and units + p_units <= p_limit
  returning units into v_units;
  return coalesce(v_units, -1);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- creators: YouTube fields (shared pool). handle = YouTube channel id (stable; @handles change).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.creators
  add column total_views       bigint,
  add column country           text,
  add column thumbnail_url     text,
  add column stats_updated_at  timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- campaigns: pipeline progress
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.campaigns
  add column budget_n        integer not null default 30 check (budget_n between 1 and 500),
  add column stage           public.campaign_stage not null default 'awaiting_queries',
  add column stage_error     text,
  add column resume_at       timestamptz,
  add column batches_done    integer not null default 0,
  add column batches_total   integer not null default 0,
  -- Funnel counts: videos found → relevant → channels → in range → active → candidates.
  add column stats           jsonb not null default '{}'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- matches: ranking + fit scoring
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.matches
  add column rank_score            real,
  add column final_score           real,
  add column relevant_views        bigint not null default 0,
  add column avg_relevance         real,
  add column relevant_video_count  integer not null default 0,
  add column fit_reason            text,
  add column scored_at             timestamptz,
  add column removed_at            timestamptz;
create index matches_campaign_rank_idx on public.matches (campaign_id, rank_score desc);
create index matches_campaign_final_idx on public.matches (campaign_id, final_score desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Server-side helpers (service role only)
-- ─────────────────────────────────────────────────────────────────────────────

-- Saves many embeddings in one round trip. Embeddings arrive as '[0.1,0.2,...]' text.
create or replace function public.set_content_embeddings(p_ids uuid[], p_embeddings text[])
returns integer
language sql
set search_path = ''
as $$
  with input as (
    select unnest(p_ids) as id, unnest(p_embeddings)::extensions.vector as embedding
  ), updated as (
    update public.content_items ci set embedding = input.embedding
      from input where ci.id = input.id
    returning 1
  )
  select count(*)::integer from updated;
$$;

-- relevance = cosine similarity = 1 - cosine distance (pgvector's <=> operator).
create or replace function public.score_content_relevance(p_startup_id uuid)
returns integer
language sql
set search_path = ''
as $$
  with updated as (
    update public.content_items ci
       set relevance = 1 - (ci.embedding operator(extensions.<=>) sc.embedding)
      from public.startup_context sc
     where sc.startup_id = ci.startup_id
       and ci.startup_id = p_startup_id
       and ci.embedding is not null
       and sc.embedding is not null
    returning 1
  )
  select count(*)::integer from updated;
$$;

revoke all on function public.consume_quota(text, date, integer, integer) from public, anon, authenticated;
revoke all on function public.set_content_embeddings(uuid[], text[]) from public, anon, authenticated;
revoke all on function public.score_content_relevance(uuid) from public, anon, authenticated;
grant execute on function public.consume_quota(text, date, integer, integer) to service_role;
grant execute on function public.set_content_embeddings(uuid[], text[]) to service_role;
grant execute on function public.score_content_relevance(uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_creators: one row per ranked creator, for sorting by any column in the UI.
-- security_invoker = the caller's RLS applies (matches → own startups only).
-- ─────────────────────────────────────────────────────────────────────────────
create view public.campaign_creators with (security_invoker = true) as
select
  m.id                   as match_id,
  m.campaign_id,
  m.startup_id,
  m.rank_score,
  m.final_score,
  m.fit_score,
  m.fit_reason,
  m.relevant_views,
  m.avg_relevance,
  m.relevant_video_count,
  m.scored_at,
  m.removed_at,
  -- Overall rank by final score among non-removed creators; stays the same whatever the UI sorts by.
  row_number() over (
    partition by m.campaign_id, (m.removed_at is null)
    order by m.final_score desc nulls last, m.rank_score desc nulls last
  )                      as final_rank,
  c.id                   as creator_id,
  c.handle               as channel_id,
  c.display_name,
  c.profile_url,
  c.thumbnail_url,
  c.audience_size        as subscribers,
  c.last_active_at,
  c.country,
  (c.email is not null)  as has_email
from public.matches m
join public.creators c on c.id = m.creator_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.startup_context  enable row level security;
alter table public.search_queries   enable row level security;
alter table public.content_items    enable row level security;
alter table public.demand_estimates enable row level security;
alter table public.quota_usage      enable row level security;

revoke all on public.startup_context, public.search_queries, public.content_items,
  public.demand_estimates, public.quota_usage, public.campaign_creators from anon;

-- Read-only to founders; written by jobs (service role).
create policy startup_context_select on public.startup_context for select to authenticated
  using (public.owns_startup(startup_id));
revoke insert, update, delete on public.startup_context from authenticated;

create policy content_items_select on public.content_items for select to authenticated
  using (public.owns_startup(startup_id));
revoke insert, update, delete on public.content_items from authenticated;

create policy demand_estimates_select on public.demand_estimates for select to authenticated
  using (public.owns_startup(startup_id));
revoke insert, update, delete on public.demand_estimates from authenticated;

-- Founders review and edit their own queries.
create policy search_queries_all on public.search_queries for all to authenticated
  using (public.owns_startup(startup_id)) with check (public.owns_startup(startup_id));

-- Quota is app-wide bookkeeping: no client access at all.
revoke all on public.quota_usage from authenticated;

grant select on public.campaign_creators to authenticated;

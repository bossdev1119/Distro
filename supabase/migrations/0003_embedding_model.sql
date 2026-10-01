-- Record WHICH model produced each embedding.
-- Vectors from different models live on different "maps" and must never be compared.
-- With this tag, switching EMBED_PROVIDER re-embeds old rows automatically (score-relevance
-- re-embeds anything whose tag doesn't match the current model) instead of mixing maps.

alter table public.startup_context add column embedding_model text;
alter table public.content_items  add column embedding_model text;

-- Everything embedded so far came from Gemini.
update public.startup_context set embedding_model = 'gemini-embedding-001' where embedding is not null;
update public.content_items  set embedding_model = 'gemini-embedding-001' where embedding is not null;

create index content_items_embedding_model_idx on public.content_items (startup_id, embedding_model);

-- Saves many embeddings (and the model that made them) in one round trip.
drop function if exists public.set_content_embeddings(uuid[], text[]);
create or replace function public.set_content_embeddings(p_ids uuid[], p_embeddings text[], p_model text)
returns integer
language sql
set search_path = ''
as $$
  with input as (
    select unnest(p_ids) as id, unnest(p_embeddings)::extensions.vector as embedding
  ), updated as (
    update public.content_items ci
       set embedding = input.embedding, embedding_model = p_model
      from input where ci.id = input.id
    returning 1
  )
  select count(*)::integer from updated;
$$;

-- relevance = cosine similarity, only between vectors from the SAME model.
-- Rows embedded by another model get relevance = null until they're re-embedded.
create or replace function public.score_content_relevance(p_startup_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.content_items ci
     set relevance = null
    from public.startup_context sc
   where sc.startup_id = ci.startup_id
     and ci.startup_id = p_startup_id
     and ci.embedding_model is distinct from sc.embedding_model;

  update public.content_items ci
     set relevance = 1 - (ci.embedding operator(extensions.<=>) sc.embedding)
    from public.startup_context sc
   where sc.startup_id = ci.startup_id
     and ci.startup_id = p_startup_id
     and ci.embedding is not null
     and sc.embedding is not null
     and ci.embedding_model = sc.embedding_model;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.set_content_embeddings(uuid[], text[], text) from public, anon, authenticated;
revoke all on function public.score_content_relevance(uuid) from public, anon, authenticated;
grant execute on function public.set_content_embeddings(uuid[], text[], text) to service_role;
grant execute on function public.score_content_relevance(uuid) to service_role;

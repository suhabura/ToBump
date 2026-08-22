-- Atomic join capacity + realtime for live Events feed.
-- Idempotent: safe to re-run in Supabase SQL Editor.

-- Serialize joins per activity so two people cannot take the last spot.
create or replace function public.enforce_activity_join_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap int;
  cnt int;
begin
  select a.max_participants into cap
  from public.activities a
  where a.id = new.activity_id
  for update;

  if not found then
    raise exception 'Event not found';
  end if;

  if cap is null then
    return new;
  end if;

  select count(*)::int into cnt
  from public.activity_joins j
  where j.activity_id = new.activity_id;

  if cnt >= cap then
    raise exception 'Event is full'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_activity_join_capacity on public.activity_joins;
create trigger trg_enforce_activity_join_capacity
  before insert on public.activity_joins
  for each row
  execute function public.enforce_activity_join_capacity();

-- Client-facing join helper (auth.uid, capacity lock via trigger).
create or replace function public.join_activity_safe(p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  act public.activities%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into act from public.activities where id = p_activity_id;
  if not found then
    raise exception 'Event not found';
  end if;
  if act.status is distinct from 'active' then
    raise exception 'Event is not available';
  end if;
  if not public.can_view_activity(act) then
    raise exception 'Not allowed';
  end if;

  insert into public.activity_joins (activity_id, user_id)
  values (p_activity_id, auth.uid())
  on conflict (activity_id, user_id) do nothing;
end;
$$;

grant execute on function public.join_activity_safe(uuid) to authenticated;

-- Live feed: broadcast join / leave / activity changes
do $$
begin
  alter publication supabase_realtime add table public.activity_joins;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.activities;
exception
  when duplicate_object then null;
end $$;

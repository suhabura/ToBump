-- Chat is for people joined to an event that has not ended,
-- and for people who added the series to their planner while such an event exists.
-- A past join and the organizer role do not open chat.
-- Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.chat_thread_recipients(p_activity_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with series as (
    select coalesce(target.series_id, target.id) as sid
    from public.activities target
    where target.id = p_activity_id
  ),
  open_rows as (
    select sib.id
    from public.activities sib
    join series s on coalesce(sib.series_id, sib.id) = s.sid
    where coalesce(sib.status, '') <> 'cancelled'
      and (
        (sib.ends_at is not null and sib.ends_at > now())
        or (sib.ends_at is null and sib.starts_at > now())
      )
  )
  select j.user_id
  from public.activity_joins j
  join open_rows o on o.id = j.activity_id
  union
  select f.user_id
  from public.series_follows f
  join series s on f.series_id = s.sid
  where exists (select 1 from open_rows);
$$;

grant execute on function public.chat_thread_recipients(uuid) to authenticated;

create or replace function public.user_in_activity_series(p_activity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.chat_thread_recipients(p_activity_id) recipient
    where recipient = auth.uid()
  );
$$;

grant execute on function public.user_in_activity_series(uuid) to authenticated;

drop policy if exists "chat_select" on public.chat_messages;
drop policy if exists "chat_insert" on public.chat_messages;
create policy "chat_select" on public.chat_messages for select to authenticated
  using (public.user_in_activity_series(activity_id));
create policy "chat_insert" on public.chat_messages for insert to authenticated
  with check (
    user_id = auth.uid() and public.user_in_activity_series(activity_id)
  );

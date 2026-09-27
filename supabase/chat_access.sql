-- Chat is for people joined to an event that has not ended,
-- and for people who added a series to their planner while such an event exists.
-- A one-off ignores planner follows. A past join and the organizer role do not open chat.
-- An invite or a friendship does not open chat.
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
  ),
  series_flag as (
    select exists (
      select 1
      from public.activities sib
      join series s on coalesce(sib.series_id, sib.id) = s.sid
      where
        (
          coalesce(sib.is_recurring, false)
          and (
            cardinality(coalesce(sib.recurrence_weekdays, '{}'::int[])) > 0
            or exists (
              select 1
              from jsonb_array_elements(
                case jsonb_typeof(coalesce(sib.recurrence_rules, '[]'::jsonb))
                  when 'array' then coalesce(sib.recurrence_rules, '[]'::jsonb)
                  else '[]'::jsonb
                end
              ) as rule
              where coalesce(rule->>'weekday', '') ~ '^[1-7]$'
                and jsonb_typeof(rule->'date') is distinct from 'string'
            )
          )
        )
        or (
          cardinality(coalesce(sib.recurrence_dates, '{}'::date[])) >= 2
          and not (
            coalesce(sib.is_recurring, false)
            and (
              cardinality(coalesce(sib.recurrence_weekdays, '{}'::int[])) > 0
              or exists (
                select 1
                from jsonb_array_elements(
                  case jsonb_typeof(coalesce(sib.recurrence_rules, '[]'::jsonb))
                    when 'array' then coalesce(sib.recurrence_rules, '[]'::jsonb)
                    else '[]'::jsonb
                  end
                ) as rule
                where coalesce(rule->>'weekday', '') ~ '^[1-7]$'
                  and jsonb_typeof(rule->'date') is distinct from 'string'
              )
            )
          )
        )
    ) as is_series
  )
  select j.user_id
  from public.activity_joins j
  join open_rows o on o.id = j.activity_id
  union
  select f.user_id
  from public.series_follows f
  join series s on f.series_id = s.sid
  where exists (select 1 from open_rows)
    and (select is_series from series_flag);
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

do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'chat_messages'
  loop
    execute format('drop policy if exists %I on public.chat_messages', pol.policyname);
  end loop;
end $$;

create policy "chat_select" on public.chat_messages for select to authenticated
  using (public.user_in_activity_series(activity_id));
create policy "chat_insert" on public.chat_messages for insert to authenticated
  with check (
    user_id = auth.uid() and public.user_in_activity_series(activity_id)
  );

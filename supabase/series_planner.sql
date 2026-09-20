-- Planner series follow + skipped days + materialize a far occurrence for Join.
-- Run in Supabase SQL Editor. Safe to re-run.

create table if not exists public.series_follows (
  series_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);

create table if not exists public.series_skipped_dates (
  series_id uuid not null references public.activities(id) on delete cascade,
  day date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (series_id, day)
);

create index if not exists idx_series_follows_user on public.series_follows(user_id);
create index if not exists idx_series_skipped_series on public.series_skipped_dates(series_id);

alter table public.series_follows enable row level security;
alter table public.series_skipped_dates enable row level security;

create or replace function public.user_can_see_series(p_series_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.activities a
    where coalesce(a.series_id, a.id) = p_series_id
      and public.can_view_activity(a)
  );
$$;

grant execute on function public.user_can_see_series(uuid) to authenticated;

drop policy if exists "series_follows_select" on public.series_follows;
drop policy if exists "series_follows_insert" on public.series_follows;
drop policy if exists "series_follows_delete" on public.series_follows;
create policy "series_follows_select" on public.series_follows for select to authenticated
  using (user_id = auth.uid());
create policy "series_follows_insert" on public.series_follows for insert to authenticated
  with check (user_id = auth.uid() and public.user_can_see_series(series_id));
create policy "series_follows_delete" on public.series_follows for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "series_skipped_select" on public.series_skipped_dates;
drop policy if exists "series_skipped_insert" on public.series_skipped_dates;
drop policy if exists "series_skipped_delete" on public.series_skipped_dates;
create policy "series_skipped_select" on public.series_skipped_dates for select to authenticated
  using (public.user_can_see_series(series_id));
create policy "series_skipped_insert" on public.series_skipped_dates for insert to authenticated
  with check (
    exists (
      select 1 from public.activities a
      where coalesce(a.series_id, a.id) = series_id and a.created_by = auth.uid()
    )
  );
create policy "series_skipped_delete" on public.series_skipped_dates for delete to authenticated
  using (
    exists (
      select 1 from public.activities a
      where coalesce(a.series_id, a.id) = series_id and a.created_by = auth.uid()
    )
  );

create or replace function public.ensure_series_occurrence(p_series_id uuid, p_starts_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  tpl public.activities%rowtype;
  sid uuid;
  day_lj date;
  existing uuid;
  new_id uuid;
  dur int;
  ends timestamptz;
  tpl_privacy text;
  tpl_group uuid;
  tpl_invites uuid[];
  skipped boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  sid := p_series_id;
  day_lj := (p_starts_at at time zone 'Europe/Ljubljana')::date;

  select * into tpl
  from public.activities a
  where coalesce(a.series_id, a.id) = sid
  order by a.starts_at
  limit 1;
  if not found then
    raise exception 'Event not found';
  end if;
  sid := coalesce(tpl.series_id, tpl.id);

  if not public.user_can_see_series(sid)
     and not exists (
       select 1 from public.series_follows f
       where f.series_id = sid and f.user_id = auth.uid()
     )
  then
    raise exception 'Not allowed';
  end if;

  select exists (
    select 1 from public.series_skipped_dates s
    where s.series_id = sid and s.day = day_lj
  ) into skipped;
  if skipped then
    raise exception 'This occurrence is cancelled';
  end if;

  select a.id into existing
  from public.activities a
  where coalesce(a.series_id, a.id) = sid
    and (a.starts_at at time zone 'Europe/Ljubljana')::date = day_lj
    and a.status is distinct from 'cancelled'
  order by a.starts_at
  limit 1;
  if existing is not null then
    return existing;
  end if;

  dur := coalesce(tpl.duration_minutes, 90);
  if tpl.ends_at is not null and tpl.starts_at is not null then
    dur := greatest(15, round(extract(epoch from (tpl.ends_at - tpl.starts_at)) / 60)::int);
  end if;
  ends := p_starts_at + make_interval(mins => dur);

  tpl_privacy := coalesce(tpl.series_privacy, tpl.privacy);
  tpl_group := case
    when tpl_privacy = 'group' then coalesce(tpl.series_group_id, tpl.group_id)
    else null
  end;
  tpl_invites := coalesce(tpl.series_invite_user_ids, '{}'::uuid[]);

  insert into public.activities (
    title, description, starts_at, ends_at, price, min_participants, max_participants,
    privacy, category_id, enterprise_id, venue_text, venue_latitude, venue_longitude,
    group_id, created_by, chat_enabled, status, is_recurring, recurrence_weekdays,
    recurrence_rules, duration_minutes, series_id, previous_activity_id,
    series_privacy, series_group_id, series_invite_user_ids,
    recurrence_until, recurrence_dates, finance_enabled, updated_at
  ) values (
    tpl.title, tpl.description, p_starts_at, ends, tpl.price, tpl.min_participants, tpl.max_participants,
    tpl_privacy, tpl.category_id, tpl.enterprise_id, tpl.venue_text,
    tpl.venue_latitude, tpl.venue_longitude,
    tpl_group, tpl.created_by, tpl.chat_enabled, 'active', coalesce(tpl.is_recurring, false),
    coalesce(tpl.recurrence_weekdays, '{}'::int[]),
    coalesce(tpl.recurrence_rules, '[]'::jsonb),
    dur,
    sid, tpl.id,
    tpl_privacy, tpl_group, tpl_invites,
    tpl.recurrence_until, coalesce(tpl.recurrence_dates, '{}'::date[]),
    coalesce(tpl.finance_enabled, false), now()
  )
  returning id into new_id;

  insert into public.activity_invites (activity_id, user_id, invited_by)
  select new_id, uid, tpl.created_by
  from unnest(tpl_invites) as uid
  where uid is distinct from tpl.created_by
  on conflict do nothing;

  insert into public.activity_editors (activity_id, user_id, granted_by)
  select new_id, e.user_id, e.granted_by
  from public.activity_editors e
  where e.activity_id = tpl.id
  on conflict do nothing;

  return new_id;
end;
$$;

grant execute on function public.ensure_series_occurrence(uuid, timestamptz) to authenticated;

create or replace function public.join_series_occurrence(p_series_id uuid, p_starts_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  oid uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  oid := public.ensure_series_occurrence(p_series_id, p_starts_at);
  insert into public.activity_joins (activity_id, user_id)
  values (oid, auth.uid())
  on conflict (activity_id, user_id) do nothing;
  return oid;
end;
$$;

grant execute on function public.join_series_occurrence(uuid, timestamptz) to authenticated;

create or replace function public.skip_series_day(p_series_id uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
  tpl public.activities%rowtype;
  nxt record;
  from_ts timestamptz;
  d date;
  seed timestamptz;
  i int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  sid := p_series_id;
  if not exists (
    select 1 from public.activities a
    where coalesce(a.series_id, a.id) = sid and a.created_by = auth.uid()
  ) then
    raise exception 'Not allowed';
  end if;

  insert into public.series_skipped_dates (series_id, day, created_by)
  values (sid, p_day, auth.uid())
  on conflict (series_id, day) do nothing;

  update public.activities
  set status = 'cancelled', updated_at = now()
  where coalesce(series_id, id) = sid
    and status = 'active'
    and (starts_at at time zone 'Europe/Ljubljana')::date = p_day;

  if exists (
    select 1 from public.activities a
    where coalesce(a.series_id, a.id) = sid
      and a.status = 'active'
      and a.starts_at > now()
  ) then
    return;
  end if;

  select * into tpl
  from public.activities a
  where coalesce(a.series_id, a.id) = sid
  order by a.starts_at desc
  limit 1;
  if not found then
    return;
  end if;

  if cardinality(coalesce(tpl.recurrence_dates, '{}'::date[])) > 0 then
    foreach d in array tpl.recurrence_dates
    loop
      if d > p_day and d >= (now() at time zone 'Europe/Ljubljana')::date
         and not exists (
           select 1 from public.series_skipped_dates s where s.series_id = sid and s.day = d
         )
      then
        seed := tpl.starts_at;
        perform public.ensure_series_occurrence(
          sid,
          make_timestamptz(
            extract(year from d)::int,
            extract(month from d)::int,
            extract(day from d)::int,
            extract(hour from (seed at time zone 'Europe/Ljubljana'))::int,
            extract(minute from (seed at time zone 'Europe/Ljubljana'))::int,
            0,
            'Europe/Ljubljana'
          )
        );
        return;
      end if;
    end loop;
    return;
  end if;

  if not coalesce(tpl.is_recurring, false) then
    return;
  end if;

  from_ts := now();
  for i in 1..40 loop
    select s.nxt_start, s.nxt_duration
      into nxt
    from public.next_recurring_slot(
      from_ts,
      tpl.recurrence_rules,
      tpl.recurrence_weekdays,
      coalesce(tpl.duration_minutes, 90),
      tpl.recurrence_until
    ) as s;
    if not found or nxt.nxt_start is null then
      return;
    end if;
    if not exists (
      select 1 from public.series_skipped_dates s
      where s.series_id = sid
        and s.day = (nxt.nxt_start at time zone 'Europe/Ljubljana')::date
    ) then
      perform public.ensure_series_occurrence(sid, nxt.nxt_start);
      return;
    end if;
    from_ts := nxt.nxt_start;
  end loop;
end;
$$;

grant execute on function public.skip_series_day(uuid, date) to authenticated;

-- Ob začetku: enkratni dogodki se zbrišejo;
-- ponavljajoči: trenutni se zbriše, ustvari se naslednji (chat se prenese).
-- Prilepi v Supabase SQL Editor → Run

alter table public.activities
  add column if not exists is_recurring boolean not null default false,
  add column if not exists recurrence_weekdays int[] not null default '{}'::int[],
  add column if not exists recurrence_rules jsonb not null default '[]'::jsonb,
  add column if not exists duration_minutes int,
  add column if not exists series_id uuid,
  add column if not exists previous_activity_id uuid references public.activities(id) on delete set null;

create index if not exists idx_activities_series on public.activities(series_id);
create index if not exists idx_activities_previous on public.activities(previous_activity_id);
create index if not exists idx_activities_started_cleanup
  on public.activities(status, starts_at)
  where status = 'active';

update public.activities set series_id = id where series_id is null;

update public.activities
set duration_minutes = greatest(
  15,
  round(extract(epoch from (ends_at - starts_at)) / 60)::int
)
where duration_minutes is null
  and ends_at is not null
  and ends_at > starts_at;

update public.activities a
set recurrence_rules = (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'weekday', w,
        'hour', extract(hour from (a.starts_at at time zone 'Europe/Ljubljana'))::int,
        'minute', extract(minute from (a.starts_at at time zone 'Europe/Ljubljana'))::int,
        'duration_minutes', coalesce(a.duration_minutes, 90)
      )
      order by w
    ),
    '[]'::jsonb
  )
  from unnest(a.recurrence_weekdays) as w
)
where a.is_recurring
  and coalesce(jsonb_array_length(a.recurrence_rules), 0) = 0
  and cardinality(a.recurrence_weekdays) > 0;

update public.activities a
set recurrence_rules = (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'weekday', (elem->>'weekday')::int,
        'hour', (elem->>'hour')::int,
        'minute', coalesce((elem->>'minute')::int, 0),
        'duration_minutes', coalesce(
          nullif((elem->>'duration_minutes')::int, 0),
          a.duration_minutes,
          90
        )
      )
      order by (elem->>'weekday')::int
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(a.recurrence_rules) elem
)
where a.is_recurring
  and coalesce(jsonb_array_length(a.recurrence_rules), 0) > 0;

-- Ob začetku: ustvari naslednji + zbriši trenutnega
create or replace function public.open_next_recurring_activity(p_activity_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cur public.activities%rowtype;
  nxt_start timestamptz;
  nxt_end timestamptz;
  base_date date;
  d date;
  iso int;
  h int;
  m int;
  rule_duration int;
  next_duration int;
  new_id uuid;
  existing uuid;
  i int;
  rules jsonb;
  weekdays int[];
begin
  select * into cur from public.activities where id = p_activity_id for update;
  if not found then
    return null;
  end if;
  if not cur.is_recurring or cur.status <> 'active' then
    return null;
  end if;

  -- Še se ni začel
  if cur.starts_at > now() then
    return null;
  end if;

  rules := coalesce(cur.recurrence_rules, '[]'::jsonb);
  if jsonb_array_length(rules) = 0 and cardinality(cur.recurrence_weekdays) > 0 then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'weekday', w,
        'hour', extract(hour from (cur.starts_at at time zone 'Europe/Ljubljana'))::int,
        'minute', extract(minute from (cur.starts_at at time zone 'Europe/Ljubljana'))::int,
        'duration_minutes', coalesce(cur.duration_minutes, 90)
      )
      order by w
    ), '[]'::jsonb)
    into rules
    from unnest(cur.recurrence_weekdays) as w;
  end if;

  if rules is null or jsonb_array_length(rules) = 0 then
    -- Brez pravil: samo zbriši začeti dogodek
    delete from public.activities where id = cur.id;
    return null;
  end if;

  select id into existing
  from public.activities
  where previous_activity_id = cur.id
  limit 1;
  if existing is not null then
    delete from public.activities where id = cur.id;
    return existing;
  end if;

  -- Naslednji termin PO datumu začetka (v prihodnosti)
  base_date := (cur.starts_at at time zone 'Europe/Ljubljana')::date;
  nxt_start := null;
  next_duration := coalesce(cur.duration_minutes, 90);

  for i in 1..60 loop
    d := base_date + i;
    iso := extract(isodow from d)::int;
    h := null;
    m := null;
    rule_duration := null;
    select x.hour, x.minute, coalesce(nullif(x.duration_minutes, 0), cur.duration_minutes, 90)
      into h, m, rule_duration
    from jsonb_to_recordset(rules) as x(weekday int, hour int, minute int, duration_minutes int)
    where x.weekday = iso
    limit 1;

    if h is not null then
      nxt_start := make_timestamptz(
        extract(year from d)::int,
        extract(month from d)::int,
        extract(day from d)::int,
        h,
        coalesce(m, 0),
        0,
        'Europe/Ljubljana'
      );
      if nxt_start > now() then
        next_duration := greatest(15, coalesce(rule_duration, 90));
        exit;
      end if;
      nxt_start := null;
    end if;
  end loop;

  if nxt_start is null then
    delete from public.activities where id = cur.id;
    return null;
  end if;

  nxt_end := nxt_start + make_interval(mins => next_duration);

  select array_agg((x.weekday)::int order by x.weekday)
    into weekdays
  from jsonb_to_recordset(rules) as x(weekday int, hour int, minute int, duration_minutes int);

  insert into public.activities (
    title, description, starts_at, ends_at, price, max_participants,
    privacy, category_id, enterprise_id, venue_text, group_id, created_by,
    chat_enabled, status, is_recurring, recurrence_weekdays, recurrence_rules,
    duration_minutes, series_id, previous_activity_id, updated_at
  ) values (
    cur.title, cur.description, nxt_start, nxt_end, cur.price, cur.max_participants,
    cur.privacy, cur.category_id, cur.enterprise_id, cur.venue_text, cur.group_id, cur.created_by,
    cur.chat_enabled, 'active', true, coalesce(weekdays, '{}'::int[]), rules,
    next_duration,
    coalesce(cur.series_id, cur.id), cur.id, now()
  )
  returning id into new_id;

  insert into public.activity_joins (activity_id, user_id)
  select new_id, user_id from public.activity_joins where activity_id = cur.id
  on conflict do nothing;

  insert into public.activity_invites (activity_id, user_id, invited_by)
  select new_id, user_id, invited_by from public.activity_invites where activity_id = cur.id
  on conflict do nothing;

  -- Chat naprej, nato zbriši stari dogodek
  update public.chat_messages
  set activity_id = new_id
  where activity_id = cur.id;

  delete from public.activities where id = cur.id;

  return new_id;
end;
$$;

grant execute on function public.open_next_recurring_activity(uuid) to authenticated;

-- Počisti začete: enkratni → delete; ponavljajoči → naslednji + delete
create or replace function public.process_due_recurring_activities()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
  opened uuid;
  deleted int := 0;
begin
  -- Enkratni, ki so se že začeli
  with gone as (
    delete from public.activities a
    where a.status = 'active'
      and coalesce(a.is_recurring, false) = false
      and a.starts_at <= now()
    returning 1
  )
  select count(*)::int into deleted from gone;
  n := n + coalesce(deleted, 0);

  -- Ponavljajoči, ki so se že začeli
  for r in
    select a.id
    from public.activities a
    where a.is_recurring = true
      and a.status = 'active'
      and a.starts_at <= now()
    order by a.starts_at
    limit 50
  loop
    opened := public.open_next_recurring_activity(r.id);
    n := n + 1;
  end loop;

  return n;
end;
$$;

grant execute on function public.process_due_recurring_activities() to authenticated;

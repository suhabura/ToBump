-- Opt-in Finance (Tricount) per activity / series.
-- Run in Supabase SQL Editor after activity_finance.sql.

alter table public.activities
  add column if not exists finance_enabled boolean not null default false;

-- Same as recurrence.sql open_next_recurring_activity, plus finance_enabled copy.
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
    duration_minutes, series_id, previous_activity_id, updated_at,
    finance_enabled
  ) values (
    cur.title, cur.description, nxt_start, nxt_end, cur.price, cur.max_participants,
    cur.privacy, cur.category_id, cur.enterprise_id, cur.venue_text, cur.group_id, cur.created_by,
    cur.chat_enabled, 'active', true, coalesce(weekdays, '{}'::int[]), rules,
    next_duration,
    coalesce(cur.series_id, cur.id), cur.id, now(),
    coalesce(cur.finance_enabled, false)
  )
  returning id into new_id;

  insert into public.activity_joins (activity_id, user_id)
  select new_id, user_id from public.activity_joins where activity_id = cur.id
  on conflict do nothing;

  insert into public.activity_invites (activity_id, user_id, invited_by)
  select new_id, user_id, invited_by from public.activity_invites where activity_id = cur.id
  on conflict do nothing;

  update public.chat_messages
  set activity_id = new_id
  where activity_id = cur.id;

  delete from public.activities where id = cur.id;

  return new_id;
end;
$$;

grant execute on function public.open_next_recurring_activity(uuid) to authenticated;

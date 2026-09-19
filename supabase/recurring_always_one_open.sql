-- Recurring series: always exactly one future open occurrence.
-- When Friday 8:00 starts, that occurrence is completed and next week's
-- occurrence is created. Run in Supabase SQL Editor. Safe to re-run.

alter table public.activities
  add column if not exists min_participants int;

drop function if exists public.next_recurring_slot(timestamptz, jsonb, int[], int, date, timestamptz, int);
drop function if exists public.next_recurring_slot(timestamptz, jsonb, int[], int, date);

create or replace function public.next_recurring_slot(
  p_from timestamptz,
  p_rules jsonb,
  p_weekdays int[],
  p_fallback_duration int,
  p_until date
)
returns table (nxt_start timestamptz, nxt_duration int)
language plpgsql
volatile
set search_path = public
as $$
declare
  rules jsonb;
  base_date date;
  d date;
  iso int;
  h int;
  m int;
  rule_duration int;
  i int;
  until_day date;
  slot_start timestamptz;
  slot_duration int;
begin
  slot_start := null;
  slot_duration := greatest(15, coalesce(p_fallback_duration, 90));
  until_day := p_until;
  rules := coalesce(p_rules, '[]'::jsonb);

  if jsonb_array_length(rules) = 0 and p_weekdays is not null and cardinality(p_weekdays) > 0 then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'weekday', w,
        'hour', extract(hour from (p_from at time zone 'Europe/Ljubljana'))::int,
        'minute', extract(minute from (p_from at time zone 'Europe/Ljubljana'))::int,
        'duration_minutes', slot_duration
      )
      order by w
    ), '[]'::jsonb)
    into rules
    from unnest(p_weekdays) as w;
  end if;

  if rules is null or jsonb_array_length(rules) = 0 then
    return;
  end if;

  base_date := (p_from at time zone 'Europe/Ljubljana')::date;

  for i in 1..400 loop
    d := base_date + i;
    if until_day is not null and d > until_day then
      exit;
    end if;
    iso := extract(isodow from d)::int;
    h := null;
    m := null;
    rule_duration := null;
    select x.hour, x.minute, coalesce(nullif(x.duration_minutes, 0), slot_duration)
      into h, m, rule_duration
    from jsonb_to_recordset(rules) as x(weekday int, hour int, minute int, duration_minutes int)
    where x.weekday = iso
    limit 1;

    if h is not null then
      slot_start := make_timestamptz(
        extract(year from d)::int,
        extract(month from d)::int,
        extract(day from d)::int,
        h,
        coalesce(m, 0),
        0,
        'Europe/Ljubljana'
      );
      if slot_start > now() then
        slot_duration := greatest(15, coalesce(rule_duration, slot_duration));
        if until_day is not null and (slot_start at time zone 'Europe/Ljubljana')::date > until_day then
          return;
        end if;
        nxt_start := slot_start;
        nxt_duration := slot_duration;
        return next;
        return;
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.open_next_recurring_activity(p_activity_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cur public.activities%rowtype;
  sid uuid;
  nxt_start timestamptz;
  nxt_duration int;
  nxt_end timestamptz;
  new_id uuid;
  existing uuid;
  rules jsonb;
  weekdays int[];
  tpl_privacy text;
  tpl_group uuid;
  tpl_invites uuid[];
begin
  select * into cur from public.activities where id = p_activity_id for update;
  if not found then
    return null;
  end if;
  if not coalesce(cur.is_recurring, false) then
    if cur.status = 'active' and cur.starts_at <= now() then
      update public.activities
      set status = 'completed', updated_at = now()
      where id = cur.id;
    end if;
    return null;
  end if;
  if cur.status = 'cancelled' then
    return null;
  end if;

  sid := coalesce(cur.series_id, cur.id);

  -- Already have a future open occurrence → complete started ones, keep that one.
  select x.id into existing
  from public.activities x
  where coalesce(x.series_id, x.id) = sid
    and x.status = 'active'
    and x.starts_at > now()
    and x.id is distinct from cur.id
  order by x.starts_at
  limit 1;

  if existing is not null then
    update public.activities
    set status = 'completed', updated_at = now()
    where coalesce(series_id, id) = sid
      and status = 'active'
      and starts_at <= now()
      and id is distinct from existing;
    return existing;
  end if;

  -- This row is still the future open event.
  if cur.status = 'active' and cur.starts_at > now() then
    return cur.id;
  end if;

  rules := coalesce(cur.recurrence_rules, '[]'::jsonb);
  select s.nxt_start, s.nxt_duration
    into nxt_start, nxt_duration
  from public.next_recurring_slot(
    cur.starts_at,
    rules,
    cur.recurrence_weekdays,
    coalesce(cur.duration_minutes, 90),
    cur.recurrence_until
  ) as s;

  if nxt_start is null then
    update public.activities
    set status = 'completed',
        is_recurring = false,
        updated_at = now()
    where id = cur.id
      and status = 'active';
    return null;
  end if;

  -- Idempotency: next already created from this occurrence
  select id into existing
  from public.activities
  where previous_activity_id = cur.id
  limit 1;
  if existing is not null then
    update public.activities
    set status = 'completed', updated_at = now()
    where id = cur.id
      and status = 'active';
    return existing;
  end if;

  tpl_privacy := coalesce(cur.series_privacy, cur.privacy);
  tpl_group := case
    when tpl_privacy = 'group' then coalesce(cur.series_group_id, cur.group_id)
    else null
  end;
  tpl_invites := coalesce(cur.series_invite_user_ids, '{}'::uuid[]);
  if cardinality(tpl_invites) = 0 then
    select coalesce(a.series_invite_user_ids, '{}'::uuid[])
      into tpl_invites
    from public.activities a
    where a.id = sid;
  end if;
  if cardinality(tpl_invites) = 0 then
    select coalesce(array_agg(i.user_id), '{}'::uuid[])
      into tpl_invites
    from public.activity_invites i
    where i.activity_id = cur.id;
  end if;

  select coalesce(array_agg((x.weekday)::int order by x.weekday), cur.recurrence_weekdays)
    into weekdays
  from jsonb_to_recordset(coalesce(nullif(rules, '[]'::jsonb), '[]'::jsonb))
    as x(weekday int, hour int, minute int, duration_minutes int);

  nxt_end := nxt_start + make_interval(mins => nxt_duration);

  insert into public.activities (
    title, description, starts_at, ends_at, price, min_participants, max_participants,
    privacy, category_id, enterprise_id, venue_text, venue_latitude, venue_longitude,
    group_id, created_by, chat_enabled, status, is_recurring, recurrence_weekdays,
    recurrence_rules, duration_minutes, series_id, previous_activity_id,
    series_privacy, series_group_id, series_invite_user_ids,
    recurrence_until, finance_enabled, updated_at
  ) values (
    cur.title, cur.description, nxt_start, nxt_end, cur.price, cur.min_participants, cur.max_participants,
    tpl_privacy, cur.category_id, cur.enterprise_id, cur.venue_text,
    cur.venue_latitude, cur.venue_longitude,
    tpl_group, cur.created_by, cur.chat_enabled, 'active', true,
    coalesce(weekdays, '{}'::int[]),
    case when jsonb_array_length(rules) > 0 then rules else cur.recurrence_rules end,
    nxt_duration,
    sid, cur.id,
    tpl_privacy, tpl_group, tpl_invites,
    cur.recurrence_until, coalesce(cur.finance_enabled, false), now()
  )
  returning id into new_id;

  insert into public.activity_invites (activity_id, user_id, invited_by)
  select new_id, uid, cur.created_by
  from unnest(tpl_invites) as uid
  where uid is distinct from cur.created_by
  on conflict do nothing;

  insert into public.activity_editors (activity_id, user_id, granted_by)
  select new_id, e.user_id, e.granted_by
  from public.activity_editors e
  where e.activity_id = cur.id
  on conflict do nothing;

  update public.chat_messages
  set activity_id = new_id
  where activity_id = cur.id;

  -- Close started occurrences; keep only the new future one open.
  update public.activities
  set status = 'completed', updated_at = now()
  where coalesce(series_id, id) = sid
    and status = 'active'
    and id is distinct from new_id
    and starts_at <= now();

  return new_id;
end;
$$;

grant execute on function public.next_recurring_slot(timestamptz, jsonb, int[], int, date) to authenticated;
grant execute on function public.open_next_recurring_activity(uuid) to authenticated;

create or replace function public.process_due_recurring_activities()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
  deleted int := 0;
begin
  with gone as (
    update public.activities a
    set status = 'completed', updated_at = now()
    where a.status = 'active'
      and coalesce(a.is_recurring, false) = false
      and a.starts_at <= now()
    returning 1
  )
  select count(*)::int into deleted from gone;
  n := n + coalesce(deleted, 0);

  -- Started recurring occurrences → complete + open next week (or next matching day)
  for r in
    select a.id
    from public.activities a
    where a.is_recurring = true
      and a.status = 'active'
      and a.starts_at <= now()
    order by a.starts_at
    limit 80
  loop
    perform public.open_next_recurring_activity(r.id);
    n := n + 1;
  end loop;

  -- Recover series that have no future open event (always 1 open until until-date)
  for r in
    select latest.id
    from (
      select distinct on (coalesce(a.series_id, a.id))
        a.id,
        coalesce(a.series_id, a.id) as sid,
        a.is_recurring,
        a.recurrence_until
      from public.activities a
      where a.status is distinct from 'cancelled'
      order by coalesce(a.series_id, a.id), a.starts_at desc
    ) latest
    where latest.is_recurring = true
      and (
        latest.recurrence_until is null
        or latest.recurrence_until >= (timezone('Europe/Ljubljana', now()))::date
      )
      and not exists (
        select 1
        from public.activities x
        where coalesce(x.series_id, x.id) = latest.sid
          and x.status = 'active'
          and x.starts_at > now()
      )
    limit 80
  loop
    perform public.open_next_recurring_activity(r.id);
    n := n + 1;
  end loop;

  return n;
end;
$$;

grant execute on function public.process_due_recurring_activities() to authenticated;

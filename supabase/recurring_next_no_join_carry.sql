-- Recurring next occurrence: attendance starts at 0 (including organizer).
-- Organizer and invitees must join the new occurrence themselves.
-- Invites come from the original series list (series_invite_user_ids).
-- Do NOT copy activity_joins from the closed event.
-- Safe to re-run in Supabase SQL Editor.

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
  tpl_privacy text;
  tpl_group uuid;
  tpl_invites uuid[];
  until_day date;
  nxt_day date;
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

  tpl_privacy := coalesce(cur.series_privacy, cur.privacy);
  tpl_group := case
    when tpl_privacy = 'group' then coalesce(cur.series_group_id, cur.group_id)
    else null
  end;

  -- Invite list locked on the first event (series_invite_user_ids), not who joined last time
  tpl_invites := coalesce(cur.series_invite_user_ids, '{}'::uuid[]);
  if cardinality(tpl_invites) = 0 then
    select coalesce(a.series_invite_user_ids, '{}'::uuid[])
      into tpl_invites
    from public.activities a
    where a.id = coalesce(cur.series_id, cur.id);
  end if;
  if cardinality(tpl_invites) = 0 then
    select coalesce(array_agg(i.user_id), '{}'::uuid[])
      into tpl_invites
    from public.activity_invites i
    where i.activity_id = cur.id;
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

  until_day := cur.recurrence_until;
  base_date := (cur.starts_at at time zone 'Europe/Ljubljana')::date;
  nxt_start := null;
  next_duration := coalesce(cur.duration_minutes, 90);

  for i in 1..120 loop
    d := base_date + i;
    if until_day is not null and d > until_day then
      exit;
    end if;
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

  nxt_day := (nxt_start at time zone 'Europe/Ljubljana')::date;
  if until_day is not null and nxt_day > until_day then
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
    duration_minutes, series_id, previous_activity_id,
    series_privacy, series_group_id, series_invite_user_ids,
    recurrence_until, finance_enabled, updated_at
  ) values (
    cur.title, cur.description, nxt_start, nxt_end, cur.price, cur.max_participants,
    tpl_privacy, cur.category_id, cur.enterprise_id, cur.venue_text, tpl_group, cur.created_by,
    cur.chat_enabled, 'active', true, coalesce(weekdays, '{}'::int[]), rules,
    next_duration,
    coalesce(cur.series_id, cur.id), cur.id,
    tpl_privacy, tpl_group, tpl_invites,
    cur.recurrence_until, coalesce(cur.finance_enabled, false), now()
  )
  returning id into new_id;

  -- Attendance starts empty — nobody is joined (not even the organizer).
  -- Organizer and invitees must tap Join on the new occurrence.
  -- (Do not copy activity_joins from the closed event.)

  -- Invites = original series invite list
  insert into public.activity_invites (activity_id, user_id, invited_by)
  select new_id, uid, cur.created_by
  from unnest(tpl_invites) as uid
  where uid is distinct from cur.created_by
  on conflict do nothing;

  -- Carry co-editors forward
  insert into public.activity_editors (activity_id, user_id, granted_by)
  select new_id, e.user_id, e.granted_by
  from public.activity_editors e
  where e.activity_id = cur.id
  on conflict do nothing;

  update public.chat_messages
  set activity_id = new_id
  where activity_id = cur.id;

  delete from public.activities where id = cur.id;

  return new_id;
end;
$$;

grant execute on function public.open_next_recurring_activity(uuid) to authenticated;

-- Same rule when skipping / deleting "this occurrence only"
create or replace function public.skip_recurring_occurrence(p_activity_id uuid)
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
  tpl_privacy text;
  tpl_group uuid;
  tpl_invites uuid[];
  until_day date;
  nxt_day date;
begin
  select * into cur from public.activities where id = p_activity_id for update;
  if not found then
    return null;
  end if;

  if cur.created_by is distinct from auth.uid() then
    raise exception 'Not allowed to delete this event';
  end if;

  if not cur.is_recurring then
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
    where a.id = coalesce(cur.series_id, cur.id);
  end if;
  if cardinality(tpl_invites) = 0 then
    select coalesce(array_agg(i.user_id), '{}'::uuid[])
      into tpl_invites
    from public.activity_invites i
    where i.activity_id = cur.id;
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

  until_day := cur.recurrence_until;
  base_date := (cur.starts_at at time zone 'Europe/Ljubljana')::date;
  nxt_start := null;
  next_duration := coalesce(cur.duration_minutes, 90);

  for i in 1..120 loop
    d := base_date + i;
    if until_day is not null and d > until_day then
      exit;
    end if;
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

  nxt_day := (nxt_start at time zone 'Europe/Ljubljana')::date;
  if until_day is not null and nxt_day > until_day then
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
    duration_minutes, series_id, previous_activity_id,
    series_privacy, series_group_id, series_invite_user_ids,
    recurrence_until, finance_enabled, updated_at
  ) values (
    cur.title, cur.description, nxt_start, nxt_end, cur.price, cur.max_participants,
    tpl_privacy, cur.category_id, cur.enterprise_id, cur.venue_text, tpl_group, cur.created_by,
    cur.chat_enabled, 'active', true, coalesce(weekdays, '{}'::int[]), rules,
    next_duration,
    coalesce(cur.series_id, cur.id), cur.id,
    tpl_privacy, tpl_group, tpl_invites,
    cur.recurrence_until, coalesce(cur.finance_enabled, false), now()
  )
  returning id into new_id;

  -- No join copy — attendance 0 on the new occurrence

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

  delete from public.activities where id = cur.id;

  return new_id;
end;
$$;

grant execute on function public.skip_recurring_occurrence(uuid) to authenticated;

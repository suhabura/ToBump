-- Custom-date series: all picked dates exist as open occurrences in one series.
-- Run in Supabase SQL Editor. Safe to re-run.

alter table public.activities
  add column if not exists recurrence_dates date[] not null default '{}'::date[];

-- When a dated occurrence starts, complete it; do not invent a weekly next slot.
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

  -- Picked dates: all future rows already exist. Just close started ones.
  if cardinality(coalesce(cur.recurrence_dates, '{}'::date[])) > 0 then
    update public.activities
    set status = 'completed', updated_at = now()
    where coalesce(series_id, id) = sid
      and status = 'active'
      and starts_at <= now();
    return null;
  end if;

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
    recurrence_until, recurrence_dates, finance_enabled, updated_at
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
    cur.recurrence_until, coalesce(cur.recurrence_dates, '{}'::date[]),
    coalesce(cur.finance_enabled, false), now()
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

  update public.activities
  set status = 'completed', updated_at = now()
  where coalesce(series_id, id) = sid
    and status = 'active'
    and id is distinct from new_id
    and starts_at <= now();

  return new_id;
end;
$$;

grant execute on function public.open_next_recurring_activity(uuid) to authenticated;

-- Series-wide chat: joined any occurrence (or organizer) can read/write the thread.
create or replace function public.user_in_activity_series(p_activity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.activities target
    where target.id = p_activity_id
      and (
        target.created_by = auth.uid()
        or exists (
          select 1
          from public.activities sib
          join public.activity_joins j on j.activity_id = sib.id and j.user_id = auth.uid()
          where coalesce(sib.series_id, sib.id) = coalesce(target.series_id, target.id)
        )
      )
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

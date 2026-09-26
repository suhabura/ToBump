-- Series "never coming" + remember the first Ne pridem dialog choice.
-- Run in Supabase SQL Editor. Safe to re-run.

create table if not exists public.series_opt_outs (
  series_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);

create table if not exists public.series_decline_prompts (
  series_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);

create index if not exists idx_series_opt_outs_user on public.series_opt_outs(user_id);
create index if not exists idx_series_decline_prompts_user on public.series_decline_prompts(user_id);

alter table public.series_opt_outs enable row level security;
alter table public.series_decline_prompts enable row level security;

drop policy if exists "series_opt_outs_select" on public.series_opt_outs;
drop policy if exists "series_opt_outs_insert" on public.series_opt_outs;
drop policy if exists "series_opt_outs_delete" on public.series_opt_outs;
create policy "series_opt_outs_select" on public.series_opt_outs for select to authenticated
  using (user_id = auth.uid());
create policy "series_opt_outs_insert" on public.series_opt_outs for insert to authenticated
  with check (user_id = auth.uid() and public.user_can_see_series(series_id));
create policy "series_opt_outs_delete" on public.series_opt_outs for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "series_decline_prompts_select" on public.series_decline_prompts;
drop policy if exists "series_decline_prompts_insert" on public.series_decline_prompts;
drop policy if exists "series_decline_prompts_delete" on public.series_decline_prompts;
create policy "series_decline_prompts_select" on public.series_decline_prompts for select to authenticated
  using (user_id = auth.uid());
create policy "series_decline_prompts_insert" on public.series_decline_prompts for insert to authenticated
  with check (user_id = auth.uid() and public.user_can_see_series(series_id));
create policy "series_decline_prompts_delete" on public.series_decline_prompts for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.series_opt_outs to authenticated;
grant select, insert, delete on public.series_decline_prompts to authenticated;

-- Skip opted-out people when copying series invites onto a new occurrence.
create or replace function public.series_invite_uids_without_opt_outs(
  p_series_id uuid,
  p_invites uuid[],
  p_creator uuid
)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select uid
  from unnest(coalesce(p_invites, '{}'::uuid[])) as uid
  where uid is distinct from p_creator
    and not exists (
      select 1
      from public.series_opt_outs o
      where o.series_id = p_series_id
        and o.user_id = uid
    );
$$;

grant execute on function public.series_invite_uids_without_opt_outs(uuid, uuid[], uuid) to authenticated;

-- Patch ensure_series_occurrence invite copy (from series_planner.sql).
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
  from public.series_invite_uids_without_opt_outs(sid, tpl_invites, tpl.created_by) as uid
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

-- Patch open_next invite copy (from recurring_always_one_open.sql).
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
  from public.series_invite_uids_without_opt_outs(sid, tpl_invites, cur.created_by) as uid
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

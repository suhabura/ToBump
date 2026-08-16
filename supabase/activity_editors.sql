-- Co-editors: creator can grant edit rights to others
-- Paste into Supabase SQL Editor → Run

create table if not exists public.activity_editors (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  granted_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (activity_id, user_id)
);

create index if not exists idx_activity_editors_user on public.activity_editors(user_id);
create index if not exists idx_activity_editors_activity on public.activity_editors(activity_id);

alter table public.activity_editors enable row level security;

create or replace function public.can_edit_activity(act public.activities)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    act.created_by = auth.uid()
    or exists (
      select 1
      from public.activity_editors e
      where e.activity_id = act.id
        and e.user_id = auth.uid()
    );
$$;

grant execute on function public.can_edit_activity(public.activities) to authenticated;

drop policy if exists "editors_select" on public.activity_editors;
drop policy if exists "editors_insert" on public.activity_editors;
drop policy if exists "editors_delete" on public.activity_editors;

create policy "editors_select" on public.activity_editors for select to authenticated
  using (
    user_id = auth.uid()
    or granted_by = auth.uid()
    or exists (
      select 1 from public.activities a
      where a.id = activity_id and public.can_view_activity(a)
    )
  );

create policy "editors_insert" on public.activity_editors for insert to authenticated
  with check (
    granted_by = auth.uid()
    and exists (
      select 1 from public.activities a
      where a.id = activity_id and a.created_by = auth.uid()
    )
  );

create policy "editors_delete" on public.activity_editors for delete to authenticated
  using (
    exists (
      select 1 from public.activities a
      where a.id = activity_id and a.created_by = auth.uid()
    )
  );

drop policy if exists "activities_update_own" on public.activities;
create policy "activities_update_own_or_editor" on public.activities for update to authenticated
  using (public.can_edit_activity(activities));

-- Invites: editors can manage invites when editing
drop policy if exists "invites_select" on public.activity_invites;
drop policy if exists "invites_insert" on public.activity_invites;
drop policy if exists "invites_delete" on public.activity_invites;

create policy "invites_select" on public.activity_invites for select to authenticated
  using (
    user_id = auth.uid()
    or invited_by = auth.uid()
    or exists (
      select 1 from public.activities a
      where a.id = activity_id and public.can_edit_activity(a)
    )
  );

create policy "invites_insert" on public.activity_invites for insert to authenticated
  with check (
    invited_by = auth.uid()
    and exists (
      select 1 from public.activities a
      where a.id = activity_id and public.can_edit_activity(a)
    )
  );

create policy "invites_delete" on public.activity_invites for delete to authenticated
  using (
    invited_by = auth.uid()
    or user_id = auth.uid()
    or exists (
      select 1 from public.activities a
      where a.id = activity_id and public.can_edit_activity(a)
    )
  );

grant select, insert, delete on public.activity_editors to authenticated;

-- Recurring spawn: also copy editors to the next occurrence
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
  tpl_invites := coalesce(cur.series_invite_user_ids, '{}'::uuid[]);
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
    duration_minutes, series_id, previous_activity_id,
    series_privacy, series_group_id, series_invite_user_ids,
    updated_at
  ) values (
    cur.title, cur.description, nxt_start, nxt_end, cur.price, cur.max_participants,
    tpl_privacy, cur.category_id, cur.enterprise_id, cur.venue_text, tpl_group, cur.created_by,
    cur.chat_enabled, 'active', true, coalesce(weekdays, '{}'::int[]), rules,
    next_duration,
    coalesce(cur.series_id, cur.id), cur.id,
    tpl_privacy, tpl_group, tpl_invites,
    now()
  )
  returning id into new_id;

  insert into public.activity_joins (activity_id, user_id)
  select new_id, user_id from public.activity_joins where activity_id = cur.id
  on conflict do nothing;

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

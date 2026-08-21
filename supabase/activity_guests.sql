-- Manual guests for events / recurring series (Tricount-aware).
-- Run in Supabase SQL Editor after activity_finance.sql.

-- Persistent guest identity for a series (series_id = activity.id for one-time events)
create table if not exists public.activity_guests (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null,
  name text not null,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists activity_guests_series_name_uidx
  on public.activity_guests (series_id, lower(trim(name)));

create index if not exists idx_activity_guests_series
  on public.activity_guests (series_id);

-- Guest attendance on a specific occurrence (+ optional fee for Tricount)
create table if not exists public.activity_guest_attendances (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references public.activity_guests(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  series_id uuid not null,
  is_free boolean not null default true,
  amount numeric(10,2) not null default 0 check (amount >= 0),
  -- What the guest fee means in Tricount (recurring / shared expenses)
  fee_treatment text not null default 'none'
    check (fee_treatment in ('none', 'split_all')),
  expense_id uuid references public.activity_expenses(id) on delete set null,
  recorded_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (guest_id, activity_id)
);

create index if not exists idx_guest_attendances_activity
  on public.activity_guest_attendances (activity_id);
create index if not exists idx_guest_attendances_series
  on public.activity_guest_attendances (series_id);

alter table public.activity_guests enable row level security;
alter table public.activity_guest_attendances enable row level security;

drop policy if exists "guests_select" on public.activity_guests;
drop policy if exists "guests_insert" on public.activity_guests;
drop policy if exists "guests_update" on public.activity_guests;
drop policy if exists "guests_delete" on public.activity_guests;
create policy "guests_select" on public.activity_guests for select to authenticated
  using (public.can_view_series(series_id));
create policy "guests_insert" on public.activity_guests for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.can_manage_series_finance(series_id)
  );
create policy "guests_update" on public.activity_guests for update to authenticated
  using (public.can_manage_series_finance(series_id) or created_by = auth.uid());
create policy "guests_delete" on public.activity_guests for delete to authenticated
  using (public.can_manage_series_finance(series_id) or created_by = auth.uid());

drop policy if exists "guest_att_select" on public.activity_guest_attendances;
drop policy if exists "guest_att_insert" on public.activity_guest_attendances;
drop policy if exists "guest_att_update" on public.activity_guest_attendances;
drop policy if exists "guest_att_delete" on public.activity_guest_attendances;
create policy "guest_att_select" on public.activity_guest_attendances for select to authenticated
  using (public.can_view_series(series_id));
create policy "guest_att_insert" on public.activity_guest_attendances for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and public.can_manage_series_finance(series_id)
  );
create policy "guest_att_update" on public.activity_guest_attendances for update to authenticated
  using (public.can_manage_series_finance(series_id) or recorded_by = auth.uid());
create policy "guest_att_delete" on public.activity_guest_attendances for delete to authenticated
  using (public.can_manage_series_finance(series_id) or recorded_by = auth.uid());

grant select, insert, update, delete on public.activity_guests to authenticated;
grant select, insert, update, delete on public.activity_guest_attendances to authenticated;

-- Add guest (or reuse series guest) + mark attendance for this occurrence.
-- If amount > 0 and fee_treatment = split_all, creates a Tricount expense paid by recorder, split among members.
create or replace function public.add_activity_guest(
  p_activity_id uuid,
  p_name text,
  p_amount numeric default 0,
  p_fee_treatment text default 'none',
  p_member_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  act public.activities%rowtype;
  sid uuid;
  g_id uuid;
  att_id uuid;
  exp_id uuid;
  nm text;
  is_free boolean;
  treat text;
  members uuid[];
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  nm := trim(p_name);
  if nm is null or nm = '' then raise exception 'Guest name required'; end if;

  select * into act from public.activities where id = p_activity_id;
  if not found then raise exception 'Activity not found'; end if;

  sid := coalesce(act.series_id, act.id);
  if not public.can_view_series(sid) then raise exception 'Not allowed'; end if;

  -- Creator or editor of this activity
  if act.created_by <> auth.uid()
     and not exists (
       select 1 from public.activity_editors e
       where e.activity_id = act.id and e.user_id = auth.uid()
     )
     and not public.can_manage_series_finance(sid)
  then
    raise exception 'Not allowed';
  end if;

  treat := coalesce(nullif(trim(p_fee_treatment), ''), 'none');
  if treat not in ('none', 'split_all') then
    raise exception 'Invalid fee treatment';
  end if;

  is_free := coalesce(p_amount, 0) <= 0;
  if is_free then
    treat := 'none';
    p_amount := 0;
  end if;

  select id into g_id
  from public.activity_guests
  where series_id = sid and lower(trim(name)) = lower(nm)
  limit 1;

  if g_id is null then
    insert into public.activity_guests (series_id, name, created_by)
    values (sid, nm, auth.uid())
    returning id into g_id;
  end if;

  if exists (
    select 1 from public.activity_guest_attendances
    where guest_id = g_id and activity_id = p_activity_id
  ) then
    raise exception 'Guest already added to this event';
  end if;

  exp_id := null;
  if not is_free and treat = 'split_all' then
    members := p_member_ids;
    if members is null or array_length(members, 1) is null then
      select array_agg(distinct uid) into members
      from (
        select act.created_by as uid
        union
        select j.user_id from public.activity_joins j where j.activity_id = p_activity_id
        union
        select i.user_id from public.activity_invites i where i.activity_id = p_activity_id
        union
        select unnest(coalesce(act.series_invite_user_ids, '{}'::uuid[]))
      ) s(uid)
      where uid is not null;
    end if;
    if members is null or array_length(members, 1) is null then
      members := array[auth.uid()];
    end if;

    exp_id := public.create_series_expense(
      sid,
      'manual',
      format('Guest fee: %s', nm),
      p_amount,
      'equal_all',
      members,
      p_activity_id,
      null,
      null,
      auth.uid()
    );
  end if;

  insert into public.activity_guest_attendances (
    guest_id, activity_id, series_id, is_free, amount, fee_treatment, expense_id, recorded_by
  ) values (
    g_id, p_activity_id, sid, is_free, coalesce(p_amount, 0), treat, exp_id, auth.uid()
  ) returning id into att_id;

  return att_id;
end;
$$;

grant execute on function public.add_activity_guest(uuid, text, numeric, text, uuid[]) to authenticated;

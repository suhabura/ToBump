-- Mark fee obligations paid/unpaid (organizer/editor only).
-- Guest fees go into the budget pot (fee_treatment = to_budget).
-- Idempotent: safe to re-run in Supabase SQL Editor.

create or replace function public.set_obligation_paid(
  p_obligation_id uuid,
  p_paid boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.activity_obligations%rowtype;
begin
  select * into o from public.activity_obligations where id = p_obligation_id for update;
  if not found then raise exception 'Obligation not found'; end if;
  if not public.can_manage_series_finance(o.series_id) then
    raise exception 'Not allowed';
  end if;
  if o.status = 'waived' then raise exception 'Obligation is waived'; end if;

  if coalesce(p_paid, false) then
    update public.activity_obligations
    set
      amount_paid = amount_due,
      status = 'paid',
      updated_at = now()
    where id = p_obligation_id;
  else
    update public.activity_obligations
    set
      amount_paid = 0,
      status = 'unpaid',
      updated_at = now()
    where id = p_obligation_id;
  end if;
end;
$$;

grant execute on function public.set_obligation_paid(uuid, boolean) to authenticated;

-- Allow to_budget guest fee treatment
alter table public.activity_guest_attendances
  drop constraint if exists activity_guest_attendances_fee_treatment_check;

alter table public.activity_guest_attendances
  add constraint activity_guest_attendances_fee_treatment_check
  check (fee_treatment in ('none', 'split_all', 'to_budget'));

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
  period text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  nm := trim(p_name);
  if nm is null or nm = '' then raise exception 'Guest name required'; end if;

  select * into act from public.activities where id = p_activity_id;
  if not found then raise exception 'Activity not found'; end if;

  sid := coalesce(act.series_id, act.id);
  if not public.can_view_series(sid) then raise exception 'Not allowed'; end if;

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
  if treat not in ('none', 'split_all', 'to_budget') then
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

  -- Guest fee → budget pot (marked paid immediately)
  if not is_free and treat = 'to_budget' then
    period := format('fee:guest:%s:activity:%s', g_id, p_activity_id);
    exp_id := public.create_series_expense(
      sid,
      'manual',
      format('Guest fee: %s', nm),
      p_amount,
      'selected',
      array[auth.uid()],
      p_activity_id,
      period,
      null,
      auth.uid(),
      false
    );
  elsif not is_free and treat = 'split_all' then
    -- Legacy Tricount split (kept for old clients)
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
      auth.uid(),
      false
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

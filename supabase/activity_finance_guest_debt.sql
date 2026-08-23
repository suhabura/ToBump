-- Guest fees are unpaid debts until the organizer marks them received.
-- Shows in Finance as "{name} (guest)" with open debt; payment writes INCOME to ledger.
-- Safe to re-run in Supabase SQL Editor.

alter table public.activity_guest_attendances
  add column if not exists amount_paid numeric(10,2) not null default 0
    check (amount_paid >= 0);

alter table public.activity_guest_attendances
  add column if not exists payment_status text not null default 'unpaid';

alter table public.activity_guest_attendances
  drop constraint if exists activity_guest_attendances_payment_status_check;

alter table public.activity_guest_attendances
  add constraint activity_guest_attendances_payment_status_check
  check (payment_status in ('unpaid', 'paid', 'waived'));

comment on column public.activity_guest_attendances.payment_status is
  'Guest fee collection status. to_budget fees start unpaid until marked received.';

-- Existing paid guest fees with amount > 0 stay unpaid until explicitly marked
-- (old flow wrongly charged the organizer / auto-settled).
update public.activity_guest_attendances
set
  amount_paid = 0,
  payment_status = 'unpaid'
where coalesce(is_free, false) = false
  and coalesce(amount, 0) > 0
  and fee_treatment = 'to_budget';

-- Remove legacy fee:guest expenses that put debt on the organizer instead of the guest
delete from public.activity_expenses e
where e.period_key is not null
  and e.period_key like 'fee:guest:%'
  and not exists (
    select 1 from public.series_finance_ledger l
    where l.expense_id = e.id and l.entry_type = 'INCOME'
  );

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

  -- to_budget: unpaid guest debt (no expense yet — INCOME on mark paid)
  -- split_all: legacy Tricount split among members
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
      auth.uid(),
      false
    );
  end if;

  insert into public.activity_guest_attendances (
    guest_id, activity_id, series_id, is_free, amount, fee_treatment, expense_id,
    recorded_by, amount_paid, payment_status
  ) values (
    g_id, p_activity_id, sid, is_free, coalesce(p_amount, 0), treat, exp_id,
    auth.uid(),
    0,
    case
      when is_free or treat = 'none' then 'waived'
      when treat = 'to_budget' then 'unpaid'
      else 'unpaid'
    end
  ) returning id into att_id;

  return att_id;
end;
$$;

grant execute on function public.add_activity_guest(uuid, text, numeric, text, uuid[]) to authenticated;

alter table public.activity_guest_attendances
  add column if not exists ledger_income_id uuid
    references public.series_finance_ledger(id) on delete set null;

create or replace function public.set_guest_attendance_paid(
  p_attendance_id uuid,
  p_paid boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  att public.activity_guest_attendances%rowtype;
  gname text;
  remaining numeric;
  lid uuid;
  desc_text text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into att from public.activity_guest_attendances where id = p_attendance_id for update;
  if not found then raise exception 'Guest attendance not found'; end if;
  if not public.can_manage_series_finance(att.series_id) then
    raise exception 'Not allowed';
  end if;
  if att.is_free or coalesce(att.amount, 0) <= 0 or att.fee_treatment = 'none' then
    raise exception 'No guest fee to collect';
  end if;
  if att.payment_status = 'waived' then raise exception 'Guest fee is waived'; end if;

  select name into gname from public.activity_guests where id = att.guest_id;
  desc_text := coalesce(format('Guest fee: %s', gname), 'Guest fee');

  if coalesce(p_paid, false) then
    remaining := greatest(coalesce(att.amount, 0) - coalesce(att.amount_paid, 0), 0);
    if remaining > 0.001 then
      insert into public.series_finance_ledger (
        series_id, entry_type, amount, occurred_at, activity_id, description, created_by
      ) values (
        att.series_id,
        'INCOME',
        remaining,
        now(),
        att.activity_id,
        desc_text,
        auth.uid()
      ) returning id into lid;
    else
      lid := att.ledger_income_id;
    end if;
    update public.activity_guest_attendances
    set
      amount_paid = amount,
      payment_status = 'paid',
      ledger_income_id = coalesce(lid, ledger_income_id)
    where id = p_attendance_id;
  else
    -- Remove the guest INCOME so available budget drops
    if att.ledger_income_id is not null then
      delete from public.series_finance_ledger where id = att.ledger_income_id;
    else
      -- Legacy rows without ledger_income_id: remove matching guest INCOME
      delete from public.series_finance_ledger l
      where l.id in (
        select l2.id
        from public.series_finance_ledger l2
        where l2.series_id = att.series_id
          and l2.entry_type = 'INCOME'
          and l2.activity_id is not distinct from att.activity_id
          and l2.description = desc_text
          and abs(l2.amount - coalesce(att.amount_paid, att.amount, 0)) < 0.011
        order by l2.occurred_at desc
        limit 1
      );
    end if;

    update public.activity_guest_attendances
    set amount_paid = 0, payment_status = 'unpaid', ledger_income_id = null
    where id = p_attendance_id;
  end if;
end;
$$;

grant execute on function public.set_guest_attendance_paid(uuid, boolean) to authenticated;

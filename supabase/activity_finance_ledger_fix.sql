-- Repair: ensure ledger payment path is the live set_obligation_paid.
-- Safe to re-run after activity_finance_member_settings.sql / paid_budget.sql
-- (those older files redefine set_obligation_paid without INCOME ledger writes).

create or replace function public.record_participant_payment(
  p_obligation_id uuid,
  p_amount numeric,
  p_note text default null,
  p_activity_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.activity_obligations%rowtype;
  pay_id uuid;
  ledger_id uuid;
  remaining numeric;
  pay_amt numeric;
  new_paid numeric;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into o from public.activity_obligations where id = p_obligation_id for update;
  if not found then raise exception 'Obligation not found'; end if;
  if not public.can_manage_series_finance(o.series_id) then
    raise exception 'Not allowed';
  end if;
  if o.status = 'waived' then raise exception 'Obligation is waived'; end if;

  remaining := greatest(o.amount_due - coalesce(o.amount_paid, 0), 0);
  if remaining <= 0.001 then raise exception 'Nothing left to pay'; end if;

  pay_amt := coalesce(p_amount, remaining);
  if pay_amt is null or pay_amt <= 0 then raise exception 'Invalid amount'; end if;
  if pay_amt > remaining + 0.001 then
    pay_amt := remaining;
  end if;

  insert into public.activity_payments (obligation_id, amount, note, recorded_by)
  values (p_obligation_id, pay_amt, p_note, auth.uid())
  returning id into pay_id;

  new_paid := coalesce(o.amount_paid, 0) + pay_amt;

  update public.activity_obligations
  set
    amount_paid = new_paid,
    status = case
      when new_paid + 0.001 >= amount_due then 'paid'
      when new_paid > 0 then 'partial'
      else 'unpaid'
    end,
    updated_at = now()
  where id = p_obligation_id;

  insert into public.series_finance_ledger (
    series_id, entry_type, amount, occurred_at, activity_id, user_id,
    obligation_id, payment_id, description, created_by
  ) values (
    o.series_id, 'INCOME', pay_amt, now(), p_activity_id, o.user_id,
    o.id, pay_id, coalesce(nullif(trim(p_note), ''), 'Payment received'), auth.uid()
  ) returning id into ledger_id;

  insert into public.series_finance_audit (
    series_id, actor_id, action, target_user_id, old_value, new_value
  ) values (
    o.series_id, auth.uid(), 'payment_recorded', o.user_id,
    jsonb_build_object('amount_paid', o.amount_paid, 'amount_due', o.amount_due),
    jsonb_build_object('payment', pay_amt, 'payment_id', pay_id, 'ledger_id', ledger_id)
  );

  return pay_id;
end;
$$;

grant execute on function public.record_participant_payment(uuid, numeric, text, uuid) to authenticated;

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
  remaining numeric;
begin
  select * into o from public.activity_obligations where id = p_obligation_id for update;
  if not found then raise exception 'Obligation not found'; end if;
  if not public.can_manage_series_finance(o.series_id) then
    raise exception 'Not allowed';
  end if;
  if o.status = 'waived' then raise exception 'Obligation is waived'; end if;

  if coalesce(p_paid, false) then
    remaining := greatest(o.amount_due - coalesce(o.amount_paid, 0), 0);
    if remaining > 0.001 then
      perform public.record_participant_payment(p_obligation_id, remaining, 'Marked received', null);
    end if;
  else
    insert into public.series_finance_audit (
      series_id, actor_id, action, target_user_id, old_value, new_value
    ) values (
      o.series_id, auth.uid(), 'payment_cleared_flag', o.user_id,
      jsonb_build_object('amount_paid', o.amount_paid, 'status', o.status),
      jsonb_build_object('amount_paid', 0, 'status', 'unpaid', 'note', 'Flag cleared; ledger history kept')
    );
    update public.activity_obligations
    set amount_paid = 0, status = 'unpaid', updated_at = now()
    where id = p_obligation_id;
  end if;
end;
$$;

grant execute on function public.set_obligation_paid(uuid, boolean) to authenticated;

-- Ensure ledger/audit tables exist (no-op if already created)
create table if not exists public.series_finance_ledger (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null,
  entry_type text not null check (entry_type in ('INCOME', 'EXPENSE')),
  amount numeric(10,2) not null check (amount > 0),
  occurred_at timestamptz not null default now(),
  activity_id uuid references public.activities(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  obligation_id uuid references public.activity_obligations(id) on delete set null,
  payment_id uuid references public.activity_payments(id) on delete set null,
  expense_id uuid references public.activity_expenses(id) on delete set null,
  category text,
  description text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.series_finance_audit (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  target_user_id uuid references public.profiles(id) on delete set null,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

alter table public.activity_joins add column if not exists fee_amount numeric(10,2);
alter table public.activity_joins
  add column if not exists fee_obligation_id uuid references public.activity_obligations(id) on delete set null;
alter table public.activity_expenses add column if not exists category text;

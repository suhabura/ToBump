-- Budget: participant fees fund a pot; expenses can be paid from budget.
-- Idempotent: safe to re-run in Supabase SQL Editor.

alter table public.activity_expenses
  add column if not exists paid_from_budget boolean not null default false;

comment on column public.activity_expenses.paid_from_budget is
  'When true, expense is paid from the event budget pot (not by a person). paid_by is null.';

-- Allow null paid_by when paid_from_budget (already nullable).
-- Recreate create_series_expense with p_paid_from_budget.

drop function if exists public.create_series_expense(uuid, text, text, numeric, text, uuid[], uuid, text, date, uuid);
drop function if exists public.create_series_expense(uuid, text, text, numeric, text, uuid[], uuid, text, date, uuid, boolean);

create or replace function public.create_series_expense(
  p_series_id uuid,
  p_expense_type text,
  p_title text,
  p_amount numeric,
  p_split_mode text,
  p_member_ids uuid[],
  p_activity_id uuid default null,
  p_period_key text default null,
  p_due_date date default null,
  p_paid_by uuid default null,
  p_paid_from_budget boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  exp_id uuid;
  n int;
  share numeric;
  uid uuid;
  payer uuid;
  from_budget boolean;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.can_view_series(p_series_id) then
    raise exception 'Not allowed';
  end if;
  if p_amount is null or p_amount < 0 then raise exception 'Invalid amount'; end if;

  from_budget := coalesce(p_paid_from_budget, false);

  if from_budget then
    -- Actual cost paid from event budget — no person payer, no Tricount obligations
    insert into public.activity_expenses (
      series_id, activity_id, expense_type, title, amount, period_key, split_mode,
      paid_by, paid_from_budget, created_by
    ) values (
      p_series_id, p_activity_id, p_expense_type, p_title, p_amount, p_period_key,
      coalesce(nullif(p_split_mode, ''), 'equal_all'),
      null, true, auth.uid()
    ) returning id into exp_id;

    if p_member_ids is not null then
      foreach uid in array p_member_ids loop
        insert into public.activity_expense_members (expense_id, user_id)
        values (exp_id, uid)
        on conflict do nothing;
      end loop;
    end if;

    return exp_id;
  end if;

  if p_member_ids is null or array_length(p_member_ids, 1) is null then
    raise exception 'Select at least one member';
  end if;

  payer := coalesce(p_paid_by, auth.uid());
  n := array_length(p_member_ids, 1);
  share := round((p_amount / n)::numeric, 2);

  insert into public.activity_expenses (
    series_id, activity_id, expense_type, title, amount, period_key, split_mode,
    paid_by, paid_from_budget, created_by
  ) values (
    p_series_id, p_activity_id, p_expense_type, p_title, p_amount, p_period_key, p_split_mode,
    payer, false, auth.uid()
  ) returning id into exp_id;

  foreach uid in array p_member_ids loop
    insert into public.activity_expense_members (expense_id, user_id) values (exp_id, uid);
    insert into public.activity_obligations (
      expense_id, series_id, user_id, amount_due, amount_paid, status, due_date
    ) values (
      exp_id,
      p_series_id,
      uid,
      share,
      case when uid = payer then share else 0 end,
      case when uid = payer then 'paid' else 'unpaid' end,
      p_due_date
    );
  end loop;

  if share * n <> p_amount then
    update public.activity_obligations o
    set
      amount_due = o.amount_due + (p_amount - share * n),
      amount_paid = case
        when o.user_id = payer then o.amount_due + (p_amount - share * n)
        else o.amount_paid
      end,
      status = case when o.user_id = payer then 'paid' else o.status end
    where o.expense_id = exp_id
      and o.user_id = p_member_ids[1];
  end if;

  return exp_id;
end;
$$;

grant execute on function public.create_series_expense(uuid, text, text, numeric, text, uuid[], uuid, text, date, uuid, boolean) to authenticated;

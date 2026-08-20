-- Tricount-style shared expenses for an activity / recurring series.
-- Idempotent: safe to re-run in Supabase SQL Editor.

-- Legacy settings table (kept for compatibility; UI no longer depends on it)
create table if not exists public.series_finance_settings (
  series_id uuid primary key,
  funding_mode text not null check (funding_mode in ('per_event', 'monthly', 'annual')),
  amount numeric(10,2) not null check (amount >= 0),
  currency text not null default 'EUR',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.activity_expenses (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null,
  activity_id uuid references public.activities(id) on delete set null,
  expense_type text not null check (expense_type in ('per_event', 'monthly', 'annual', 'manual')),
  title text not null,
  amount numeric(10,2) not null check (amount >= 0),
  period_key text,
  split_mode text not null default 'equal_all'
    check (split_mode in ('equal_all', 'equal_attendees', 'selected')),
  paid_by uuid references public.profiles(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.activity_expenses
  add column if not exists paid_by uuid references public.profiles(id) on delete set null;

update public.activity_expenses
set paid_by = created_by
where paid_by is null;

create table if not exists public.activity_expense_members (
  expense_id uuid not null references public.activity_expenses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (expense_id, user_id)
);

create table if not exists public.activity_obligations (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.activity_expenses(id) on delete cascade,
  series_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount_due numeric(10,2) not null check (amount_due >= 0),
  amount_paid numeric(10,2) not null default 0 check (amount_paid >= 0),
  status text not null default 'unpaid'
    check (status in ('unpaid', 'partial', 'paid', 'waived')),
  due_date date,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (expense_id, user_id)
);

create table if not exists public.activity_payments (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null references public.activity_obligations(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  note text,
  recorded_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Peer settlements: from_user paid to_user (reduces debt)
create table if not exists public.activity_settlements (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null,
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  to_user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  note text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (from_user_id <> to_user_id)
);

create index if not exists idx_expenses_series on public.activity_expenses(series_id, created_at desc);
create index if not exists idx_obligations_user on public.activity_obligations(user_id, status);
create index if not exists idx_obligations_series on public.activity_obligations(series_id, status);
create index if not exists idx_payments_obligation on public.activity_payments(obligation_id);
create index if not exists idx_settlements_series on public.activity_settlements(series_id, created_at desc);

alter table public.series_finance_settings enable row level security;
alter table public.activity_expenses enable row level security;
alter table public.activity_expense_members enable row level security;
alter table public.activity_obligations enable row level security;
alter table public.activity_payments enable row level security;
alter table public.activity_settlements enable row level security;

create or replace function public.can_view_series(p_series_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.activities a
    where coalesce(a.series_id, a.id) = p_series_id
      and (
        a.created_by = auth.uid()
        or exists (select 1 from public.activity_joins j where j.activity_id = a.id and j.user_id = auth.uid())
        or exists (select 1 from public.activity_invites i where i.activity_id = a.id and i.user_id = auth.uid())
        or exists (select 1 from public.activity_editors e where e.activity_id = a.id and e.user_id = auth.uid())
      )
  );
$$;

create or replace function public.can_manage_series_finance(p_series_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.activities a
    where coalesce(a.series_id, a.id) = p_series_id
      and (
        a.created_by = auth.uid()
        or exists (select 1 from public.activity_editors e where e.activity_id = a.id and e.user_id = auth.uid())
      )
  );
$$;

grant execute on function public.can_view_series(uuid) to authenticated;
grant execute on function public.can_manage_series_finance(uuid) to authenticated;

drop policy if exists "finance_settings_select" on public.series_finance_settings;
create policy "finance_settings_select" on public.series_finance_settings for select to authenticated
  using (public.can_view_series(series_id));
drop policy if exists "finance_settings_upsert" on public.series_finance_settings;
drop policy if exists "finance_settings_insert" on public.series_finance_settings;
drop policy if exists "finance_settings_update" on public.series_finance_settings;
create policy "finance_settings_insert" on public.series_finance_settings for insert to authenticated
  with check (public.can_manage_series_finance(series_id));
create policy "finance_settings_update" on public.series_finance_settings for update to authenticated
  using (public.can_manage_series_finance(series_id));

drop policy if exists "expenses_select" on public.activity_expenses;
drop policy if exists "expenses_insert" on public.activity_expenses;
drop policy if exists "expenses_delete" on public.activity_expenses;
create policy "expenses_select" on public.activity_expenses for select to authenticated
  using (public.can_view_series(series_id));
-- Any participant can add expenses (Tricount-style)
create policy "expenses_insert" on public.activity_expenses for insert to authenticated
  with check (public.can_view_series(series_id) and created_by = auth.uid());
create policy "expenses_delete" on public.activity_expenses for delete to authenticated
  using (
    public.can_manage_series_finance(series_id)
    or created_by = auth.uid()
  );

drop policy if exists "expense_members_select" on public.activity_expense_members;
drop policy if exists "expense_members_insert" on public.activity_expense_members;
drop policy if exists "expense_members_delete" on public.activity_expense_members;
create policy "expense_members_select" on public.activity_expense_members for select to authenticated
  using (exists (
    select 1 from public.activity_expenses e
    where e.id = expense_id and public.can_view_series(e.series_id)
  ));
create policy "expense_members_insert" on public.activity_expense_members for insert to authenticated
  with check (exists (
    select 1 from public.activity_expenses e
    where e.id = expense_id and public.can_view_series(e.series_id)
  ));
create policy "expense_members_delete" on public.activity_expense_members for delete to authenticated
  using (exists (
    select 1 from public.activity_expenses e
    where e.id = expense_id
      and (public.can_manage_series_finance(e.series_id) or e.created_by = auth.uid())
  ));

drop policy if exists "obligations_select" on public.activity_obligations;
drop policy if exists "obligations_update" on public.activity_obligations;
drop policy if exists "obligations_insert" on public.activity_obligations;
create policy "obligations_select" on public.activity_obligations for select to authenticated
  using (user_id = auth.uid() or public.can_view_series(series_id));
create policy "obligations_update" on public.activity_obligations for update to authenticated
  using (public.can_view_series(series_id));
create policy "obligations_insert" on public.activity_obligations for insert to authenticated
  with check (public.can_view_series(series_id));

drop policy if exists "payments_select" on public.activity_payments;
drop policy if exists "payments_insert" on public.activity_payments;
create policy "payments_select" on public.activity_payments for select to authenticated
  using (exists (
    select 1 from public.activity_obligations o
    where o.id = obligation_id
      and (o.user_id = auth.uid() or public.can_view_series(o.series_id))
  ));
create policy "payments_insert" on public.activity_payments for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and exists (
      select 1 from public.activity_obligations o
      where o.id = obligation_id and public.can_view_series(o.series_id)
    )
  );

drop policy if exists "settlements_select" on public.activity_settlements;
drop policy if exists "settlements_insert" on public.activity_settlements;
drop policy if exists "settlements_delete" on public.activity_settlements;
create policy "settlements_select" on public.activity_settlements for select to authenticated
  using (public.can_view_series(series_id));
create policy "settlements_insert" on public.activity_settlements for insert to authenticated
  with check (public.can_view_series(series_id) and created_by = auth.uid());
create policy "settlements_delete" on public.activity_settlements for delete to authenticated
  using (
    public.can_manage_series_finance(series_id)
    or created_by = auth.uid()
  );

grant select, insert, update on public.series_finance_settings to authenticated;
grant select, insert, delete on public.activity_expenses to authenticated;
grant select, insert, delete on public.activity_expense_members to authenticated;
grant select, insert, update on public.activity_obligations to authenticated;
grant select, insert on public.activity_payments to authenticated;
grant select, insert, delete on public.activity_settlements to authenticated;

create or replace function public.refresh_obligation_status(p_obligation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.activity_obligations%rowtype;
begin
  select * into o from public.activity_obligations where id = p_obligation_id for update;
  if not found then return; end if;
  if o.status = 'waived' then return; end if;

  update public.activity_obligations
  set
    status = case
      when amount_paid <= 0 then 'unpaid'
      when amount_paid + 0.001 >= amount_due then 'paid'
      else 'partial'
    end,
    updated_at = now()
  where id = p_obligation_id;
end;
$$;

grant execute on function public.refresh_obligation_status(uuid) to authenticated;

create or replace function public.record_obligation_payment(
  p_obligation_id uuid,
  p_amount numeric,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.activity_obligations%rowtype;
  pay_id uuid;
  new_paid numeric;
begin
  select * into o from public.activity_obligations where id = p_obligation_id for update;
  if not found then raise exception 'Obligation not found'; end if;
  if not public.can_view_series(o.series_id) then
    raise exception 'Not allowed';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Invalid amount'; end if;
  if o.status = 'waived' then raise exception 'Obligation is waived'; end if;

  insert into public.activity_payments (obligation_id, amount, note, recorded_by)
  values (p_obligation_id, p_amount, p_note, auth.uid())
  returning id into pay_id;

  new_paid := o.amount_paid + p_amount;
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

  return pay_id;
end;
$$;

grant execute on function public.record_obligation_payment(uuid, numeric, text) to authenticated;

create or replace function public.waive_obligation(p_obligation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.activity_obligations%rowtype;
begin
  select * into o from public.activity_obligations where id = p_obligation_id for update;
  if not found then return; end if;
  if not public.can_manage_series_finance(o.series_id) then
    raise exception 'Not allowed';
  end if;
  update public.activity_obligations
  set status = 'waived', updated_at = now()
  where id = p_obligation_id;
end;
$$;

grant execute on function public.waive_obligation(uuid) to authenticated;

-- Drop old overload if present, then create Tricount create_series_expense
drop function if exists public.create_series_expense(uuid, text, text, numeric, text, uuid[], uuid, text, date);
drop function if exists public.create_series_expense(uuid, text, text, numeric, text, uuid[], uuid, text, date, uuid);

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
  p_paid_by uuid default null
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
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.can_view_series(p_series_id) then
    raise exception 'Not allowed';
  end if;
  if p_amount is null or p_amount < 0 then raise exception 'Invalid amount'; end if;
  if p_member_ids is null or array_length(p_member_ids, 1) is null then
    raise exception 'Select at least one member';
  end if;

  payer := coalesce(p_paid_by, auth.uid());
  n := array_length(p_member_ids, 1);
  share := round((p_amount / n)::numeric, 2);

  insert into public.activity_expenses (
    series_id, activity_id, expense_type, title, amount, period_key, split_mode, paid_by, created_by
  ) values (
    p_series_id, p_activity_id, p_expense_type, p_title, p_amount, p_period_key, p_split_mode, payer, auth.uid()
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

  -- Fix rounding remainder on first member
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

grant execute on function public.create_series_expense(uuid, text, text, numeric, text, uuid[], uuid, text, date, uuid) to authenticated;

create or replace function public.record_series_settlement(
  p_series_id uuid,
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.can_view_series(p_series_id) then
    raise exception 'Not allowed';
  end if;
  if p_from_user_id is null or p_to_user_id is null or p_from_user_id = p_to_user_id then
    raise exception 'Invalid users';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Invalid amount'; end if;

  insert into public.activity_settlements (
    series_id, from_user_id, to_user_id, amount, note, created_by
  ) values (
    p_series_id, p_from_user_id, p_to_user_id, p_amount, p_note, auth.uid()
  ) returning id into sid;

  return sid;
end;
$$;

grant execute on function public.record_series_settlement(uuid, uuid, uuid, numeric, text) to authenticated;

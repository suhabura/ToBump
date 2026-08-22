-- Per-person payment method/amount overrides for a series.
-- Marking paid writes activity_payments (transactions) and funds the budget.
-- Idempotent: safe to re-run in Supabase SQL Editor.

create table if not exists public.series_finance_member_settings (
  series_id uuid not null references public.series_finance_settings(series_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  funding_mode text not null
    check (funding_mode in ('per_event', 'monthly', 'annual', 'fixed')),
  amount numeric not null check (amount >= 0),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);

comment on table public.series_finance_member_settings is
  'Per-person override of collection method and amount. Falls back to series_finance_settings when missing.';

create index if not exists idx_series_finance_member_settings_user
  on public.series_finance_member_settings(user_id);

alter table public.series_finance_member_settings enable row level security;

drop policy if exists "member_finance_select" on public.series_finance_member_settings;
create policy "member_finance_select" on public.series_finance_member_settings
  for select to authenticated
  using (public.can_view_series(series_id));

drop policy if exists "member_finance_upsert" on public.series_finance_member_settings;
create policy "member_finance_upsert" on public.series_finance_member_settings
  for insert to authenticated
  with check (public.can_manage_series_finance(series_id));

drop policy if exists "member_finance_update" on public.series_finance_member_settings;
create policy "member_finance_update" on public.series_finance_member_settings
  for update to authenticated
  using (public.can_manage_series_finance(series_id));

drop policy if exists "member_finance_delete" on public.series_finance_member_settings;
create policy "member_finance_delete" on public.series_finance_member_settings
  for delete to authenticated
  using (public.can_manage_series_finance(series_id));

grant select, insert, update, delete on public.series_finance_member_settings to authenticated;

-- Mark paid/unpaid and record ledger transactions
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
      insert into public.activity_payments (obligation_id, amount, note, recorded_by)
      values (p_obligation_id, remaining, 'Marked received', auth.uid());
    end if;
    update public.activity_obligations
    set
      amount_paid = amount_due,
      status = 'paid',
      updated_at = now()
    where id = p_obligation_id;
  else
    delete from public.activity_payments where obligation_id = p_obligation_id;
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

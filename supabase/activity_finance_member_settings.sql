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

-- NOTE: Do NOT redefine set_obligation_paid here.
-- The live payment + INCOME ledger path lives in activity_finance_ledger.sql
-- (and activity_finance_ledger_fix.sql). Re-run that file if payments
-- do not appear in series_finance_ledger.

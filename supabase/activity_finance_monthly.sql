-- Monthly billing: starts on first attendance, then every month until stopped.
-- Organizer can skip one month or stop future months.
-- Idempotent: safe to re-run.

create table if not exists public.series_finance_monthly_billing (
  series_id uuid not null references public.series_finance_settings(series_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  started_month text not null,
  stopped boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (series_id, user_id),
  check (started_month ~ '^\d{4}-\d{2}$')
);

comment on table public.series_finance_monthly_billing is
  'Eligible payer monthly billing window. Starts on first attendance; stopped=true ends future auto charges.';

create table if not exists public.series_finance_monthly_skips (
  series_id uuid not null references public.series_finance_settings(series_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  month_key text not null,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id, month_key),
  check (month_key ~ '^\d{4}-\d{2}$')
);

comment on table public.series_finance_monthly_skips is
  'Months where organizer waived the monthly fee for a user (this month only).';

alter table public.series_finance_monthly_billing enable row level security;
alter table public.series_finance_monthly_skips enable row level security;

drop policy if exists "monthly_billing_select" on public.series_finance_monthly_billing;
create policy "monthly_billing_select" on public.series_finance_monthly_billing for select to authenticated
  using (public.can_view_series(series_id));

drop policy if exists "monthly_billing_insert" on public.series_finance_monthly_billing;
create policy "monthly_billing_insert" on public.series_finance_monthly_billing for insert to authenticated
  with check (
    public.can_manage_series_finance(series_id)
    or user_id = auth.uid()
  );

drop policy if exists "monthly_billing_update" on public.series_finance_monthly_billing;
create policy "monthly_billing_update" on public.series_finance_monthly_billing for update to authenticated
  using (public.can_manage_series_finance(series_id));

drop policy if exists "monthly_billing_delete" on public.series_finance_monthly_billing;
create policy "monthly_billing_delete" on public.series_finance_monthly_billing for delete to authenticated
  using (public.can_manage_series_finance(series_id));

drop policy if exists "monthly_skips_select" on public.series_finance_monthly_skips;
create policy "monthly_skips_select" on public.series_finance_monthly_skips for select to authenticated
  using (public.can_view_series(series_id));

drop policy if exists "monthly_skips_insert" on public.series_finance_monthly_skips;
create policy "monthly_skips_insert" on public.series_finance_monthly_skips for insert to authenticated
  with check (public.can_manage_series_finance(series_id));

drop policy if exists "monthly_skips_delete" on public.series_finance_monthly_skips;
create policy "monthly_skips_delete" on public.series_finance_monthly_skips for delete to authenticated
  using (public.can_manage_series_finance(series_id));

grant select, insert, update, delete on public.series_finance_monthly_billing to authenticated;
grant select, insert, delete on public.series_finance_monthly_skips to authenticated;

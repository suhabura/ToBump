-- Who pays: organizer picks individuals or a group at create time.
-- Fees are created per person only after they attend at least once.
-- Idempotent: safe to re-run in Supabase SQL Editor.

alter table public.series_finance_settings
  add column if not exists payer_group_id uuid references public.friend_groups(id) on delete set null;

alter table public.series_finance_settings
  add column if not exists who_pays text;

-- Drop OLD check first (invitees/attendees), then migrate values, then add NEW check.
alter table public.series_finance_settings
  drop constraint if exists series_finance_settings_who_pays_check;

update public.series_finance_settings
set who_pays = 'selected'
where who_pays is null or who_pays in ('invitees', 'attendees');

alter table public.series_finance_settings
  alter column who_pays set default 'selected';

alter table public.series_finance_settings
  alter column who_pays set not null;

alter table public.series_finance_settings
  add constraint series_finance_settings_who_pays_check
  check (who_pays in ('selected', 'group'));

comment on column public.series_finance_settings.who_pays is
  'Eligible payers: selected individuals or a friend group. Fee created only after first attendance.';

comment on column public.series_finance_settings.payer_group_id is
  'When who_pays = group, members of this group are eligible payers.';

create table if not exists public.series_finance_payers (
  series_id uuid not null references public.series_finance_settings(series_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (series_id, user_id)
);

create index if not exists idx_series_finance_payers_user
  on public.series_finance_payers(user_id);

alter table public.series_finance_payers enable row level security;

drop policy if exists "finance_payers_select" on public.series_finance_payers;
create policy "finance_payers_select" on public.series_finance_payers for select to authenticated
  using (public.can_view_series(series_id));

drop policy if exists "finance_payers_insert" on public.series_finance_payers;
create policy "finance_payers_insert" on public.series_finance_payers for insert to authenticated
  with check (public.can_manage_series_finance(series_id));

drop policy if exists "finance_payers_delete" on public.series_finance_payers;
create policy "finance_payers_delete" on public.series_finance_payers for delete to authenticated
  using (public.can_manage_series_finance(series_id));

grant select, insert, delete on public.series_finance_payers to authenticated;

-- Allow organizers to edit expense amounts (manual fee changes)
drop policy if exists "expenses_update" on public.activity_expenses;
create policy "expenses_update" on public.activity_expenses for update to authenticated
  using (
    public.can_manage_series_finance(series_id)
    or created_by = auth.uid()
  );

grant update on public.activity_expenses to authenticated;

-- Who pays (invitees vs attendees) on series finance settings.
-- Safe to re-run.

alter table public.series_finance_settings
  add column if not exists who_pays text not null default 'invitees';

alter table public.series_finance_settings
  drop constraint if exists series_finance_settings_who_pays_check;

alter table public.series_finance_settings
  add constraint series_finance_settings_who_pays_check
  check (who_pays in ('invitees', 'attendees'));

comment on column public.series_finance_settings.who_pays is
  'Who is split among for funding expenses: invitees or attendees';

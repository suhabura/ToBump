-- Allow funding_mode = fixed (specific amount) for series finance settings.
-- Safe to re-run.

alter table public.series_finance_settings
  drop constraint if exists series_finance_settings_funding_mode_check;

alter table public.series_finance_settings
  add constraint series_finance_settings_funding_mode_check
  check (funding_mode in ('per_event', 'monthly', 'annual', 'fixed'));

drop policy if exists "finance_settings_delete" on public.series_finance_settings;
create policy "finance_settings_delete" on public.series_finance_settings for delete to authenticated
  using (public.can_manage_series_finance(series_id));

grant delete on public.series_finance_settings to authenticated;

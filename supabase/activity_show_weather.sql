-- Organizer can show the start-time forecast on an event.
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.activities
  add column if not exists show_weather boolean not null default false;

-- New series dates inherit the flag from the series template, including
-- rows opened by existing functions that do not list this column.
create or replace function public.activities_copy_show_weather()
returns trigger
language plpgsql
as $$
declare
  inherited boolean;
begin
  if new.series_id is not null and new.series_id is distinct from new.id then
    select a.show_weather into inherited
    from public.activities a
    where a.id = new.series_id;
    if inherited is not null then
      new.show_weather := inherited;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists activities_show_weather_from_series on public.activities;
create trigger activities_show_weather_from_series
  before insert on public.activities
  for each row
  execute function public.activities_copy_show_weather();

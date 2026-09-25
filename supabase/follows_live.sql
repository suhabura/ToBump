-- Drugi odprti Planer naj rumene pike dobi brez ročne osvežitve.
-- Prilepi v Supabase SQL Editor → Run.

do $$
begin
  alter publication supabase_realtime add table public.series_follows;
exception
  when duplicate_object then null;
end $$;

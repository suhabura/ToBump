-- Povabljenec naj nov dogodek vidi brez ročne osvežitve.
-- Prilepi v Supabase SQL Editor → Run.

do $$
begin
  alter publication supabase_realtime add table public.activity_invites;
exception
  when duplicate_object then null;
end $$;

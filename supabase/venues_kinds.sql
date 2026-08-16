-- Prizorišča: uporabnik samo tekst; uradni / ToBump rezervacije iz app 2
-- Prilepi v Supabase SQL Editor → Run

alter table public.activities
  add column if not exists venue_text text;

alter table public.enterprises
  add column if not exists provider_kind text not null default 'official'
    check (provider_kind in ('official', 'tobump_booking'));

comment on column public.enterprises.provider_kind is
  'official = uradni ponudnik; tobump_booking = rezervacijski sistem ToBump (samo app 2)';

comment on column public.activities.venue_text is
  'Prosto besedilno prizorišče (tip 1). Če je enterprise_id nastavljen, gre za tip 2/3.';

-- Uporabniki v app 1 ne smejo vnašati prizorišč v bazo
drop policy if exists "enterprises_insert" on public.enterprises;
drop policy if exists "enterprises_update_own" on public.enterprises;
-- insert/update bodo kasneje dovoljeni verificiranim ponudnikom (app 2)

-- Če imaš že recurrence.sql: ponovno zaženi funkcijo spawn (vključuje venue_text).
-- Glej supabase/recurrence.sql

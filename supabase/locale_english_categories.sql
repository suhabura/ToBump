-- UI language on user_settings + keep categories English-only
-- Paste into Supabase SQL Editor → Run

alter table public.user_settings
  add column if not exists locale text not null default 'en';

comment on column public.user_settings.locale is
  'App UI language (en default). Category rows in DB stay English.';

-- Remap activities from non-English category names onto English Football / Tennis / …
do $$
declare
  football_id uuid;
  tennis_id uuid;
  basketball_id uuid;
begin
  select id into football_id from public.categories where lower(name) = 'football' limit 1;
  select id into tennis_id from public.categories where lower(name) = 'tennis' limit 1;
  select id into basketball_id from public.categories where lower(name) = 'basketball' limit 1;

  if football_id is not null then
    update public.activities
    set category_id = football_id
    where category_id in (
      select id from public.categories where lower(name) in ('nogomet', 'soccer')
    );
    update public.enterprises
    set category_id = football_id
    where category_id in (
      select id from public.categories where lower(name) in ('nogomet', 'soccer')
    );
  end if;

  if tennis_id is not null then
    update public.activities
    set category_id = tennis_id
    where category_id in (select id from public.categories where lower(name) = 'tenis');
    update public.enterprises
    set category_id = tennis_id
    where category_id in (select id from public.categories where lower(name) = 'tenis');
  end if;

  if basketball_id is not null then
    update public.activities
    set category_id = basketball_id
    where category_id in (
      select id from public.categories where lower(name) in ('košarka', 'kosarka')
    );
    update public.enterprises
    set category_id = basketball_id
    where category_id in (
      select id from public.categories where lower(name) in ('košarka', 'kosarka')
    );
  end if;
end $$;

-- Drop non-English / duplicate category rows (safe after remap)
delete from public.categories
where lower(name) in (
  'nogomet', 'soccer', 'tenis', 'košarka', 'kosarka',
  'odbojka', 'tek', 'kolesarjenje', 'plavanje', 'telovadnica', 'fitnes',
  'koncert', 'gledališče', 'gledalisce', 'razstava', 'kino', 'zabava',
  'srečanje', 'srecanje', 'pohod', 'piknik', 'kampiranje',
  'večerja', 'vecerja', 'kava', 'degustacija', 'delavnica', 'predavanje',
  'tečaj', 'tecaj'
);

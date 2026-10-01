-- Places people pick, plus a 30-day cache of Google text search.
-- Also copy the signup town onto the new profile.
-- Run once in the Supabase SQL editor.

create table if not exists public.saved_places (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  latitude double precision not null,
  longitude double precision not null,
  google_place_id text,
  source text not null default 'picked',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists saved_places_google_id
  on public.saved_places (google_place_id)
  where google_place_id is not null;

create table if not exists public.place_query_cache (
  id uuid primary key default gen_random_uuid(),
  query_norm text not null,
  results jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.saved_places enable row level security;
alter table public.place_query_cache enable row level security;

drop policy if exists "saved_places_select" on public.saved_places;
create policy "saved_places_select" on public.saved_places
  for select to authenticated using (true);

drop policy if exists "saved_places_insert" on public.saved_places;
create policy "saved_places_insert" on public.saved_places
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "place_query_cache_select" on public.place_query_cache;
create policy "place_query_cache_select" on public.place_query_cache
  for select to authenticated using (true);

drop policy if exists "place_query_cache_insert" on public.place_query_cache;
create policy "place_query_cache_insert" on public.place_query_cache
  for insert to authenticated with check (true);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, first_name, last_name, location, latitude, longitude)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    nullif(new.raw_user_meta_data->>'location', ''),
    nullif(new.raw_user_meta_data->>'latitude', '')::double precision,
    nullif(new.raw_user_meta_data->>'longitude', '')::double precision
  );
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;

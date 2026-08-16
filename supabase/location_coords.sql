-- Lokacija profila: Google Maps koordinate (lat/lng)
-- Prilepi v Supabase SQL Editor → Run

alter table public.profiles
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

create index if not exists idx_profiles_coords
  on public.profiles(latitude, longitude)
  where latitude is not null and longitude is not null;

create index if not exists idx_enterprises_coords
  on public.enterprises(latitude, longitude)
  where latitude is not null and longitude is not null;

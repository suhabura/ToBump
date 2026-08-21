-- Venue coordinates on activities (same idea as profile location).
-- Run in Supabase SQL Editor. Safe to re-run.

alter table public.activities
  add column if not exists venue_latitude double precision,
  add column if not exists venue_longitude double precision;

create index if not exists idx_activities_venue_coords
  on public.activities (venue_latitude, venue_longitude)
  where venue_latitude is not null and venue_longitude is not null;

comment on column public.activities.venue_latitude is
  'Lat of free-text venue (when enterprise_id is null)';
comment on column public.activities.venue_longitude is
  'Lng of free-text venue (when enterprise_id is null)';

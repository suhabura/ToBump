-- Category hierarchy: parent (basic) + subcategory (entered when creating events)
-- Paste into Supabase SQL Editor → Run

alter table public.categories
  add column if not exists parent_id uuid references public.categories(id) on delete cascade;

create index if not exists idx_categories_parent on public.categories(parent_id);

comment on column public.categories.parent_id is
  'NULL = top-level category (Sport, Culture…). Non-null = subcategory used on events.';

-- Allow same subcategory names under different parents later; keep global unique for now via name.
-- Migrate flat seeds under Sport
insert into public.categories (name, icon, parent_id)
select 'Sport', 'sport', null
where not exists (select 1 from public.categories where lower(name) = 'sport' and parent_id is null);

insert into public.categories (name, icon, parent_id)
select 'Culture', 'culture', null
where not exists (select 1 from public.categories where lower(name) = 'culture' and parent_id is null);

insert into public.categories (name, icon, parent_id)
select 'Social', 'social', null
where not exists (select 1 from public.categories where lower(name) = 'social' and parent_id is null);

insert into public.categories (name, icon, parent_id)
select 'Outdoor', 'outdoor', null
where not exists (select 1 from public.categories where lower(name) = 'outdoor' and parent_id is null);

insert into public.categories (name, icon, parent_id)
select 'Food & Drink', 'food', null
where not exists (select 1 from public.categories where lower(name) = 'food & drink' and parent_id is null);

insert into public.categories (name, icon, parent_id)
select 'Education', 'education', null
where not exists (select 1 from public.categories where lower(name) = 'education' and parent_id is null);

-- Attach existing flat English sport names as subcategories of Sport
update public.categories c
set parent_id = (select id from public.categories p where lower(p.name) = 'sport' and p.parent_id is null limit 1)
where c.parent_id is null
  and lower(c.name) in ('tennis', 'football', 'basketball', 'volleyball', 'running', 'cycling', 'swimming', 'gym');

-- Seed English subcategories (skip if name already exists)
with sport as (
  select id from public.categories where lower(name) = 'sport' and parent_id is null limit 1
),
culture as (
  select id from public.categories where lower(name) = 'culture' and parent_id is null limit 1
),
social as (
  select id from public.categories where lower(name) = 'social' and parent_id is null limit 1
),
outdoor as (
  select id from public.categories where lower(name) = 'outdoor' and parent_id is null limit 1
),
food as (
  select id from public.categories where lower(name) = 'food & drink' and parent_id is null limit 1
),
edu as (
  select id from public.categories where lower(name) = 'education' and parent_id is null limit 1
)
insert into public.categories (name, icon, parent_id)
select v.name, v.icon, v.parent_id
from (
  select 'Football' as name, 'football' as icon, (select id from sport) as parent_id
  union all select 'Tennis', 'tennisball', (select id from sport)
  union all select 'Basketball', 'basketball', (select id from sport)
  union all select 'Volleyball', 'volleyball', (select id from sport)
  union all select 'Running', 'running', (select id from sport)
  union all select 'Cycling', 'cycling', (select id from sport)
  union all select 'Swimming', 'swimming', (select id from sport)
  union all select 'Gym', 'fitness', (select id from sport)
  union all select 'Concert', 'music', (select id from culture)
  union all select 'Theatre', 'theatre', (select id from culture)
  union all select 'Exhibition', 'art', (select id from culture)
  union all select 'Cinema', 'film', (select id from culture)
  union all select 'Party', 'party', (select id from social)
  union all select 'Meetup', 'people', (select id from social)
  union all select 'Networking', 'network', (select id from social)
  union all select 'Hiking', 'hike', (select id from outdoor)
  union all select 'Picnic', 'picnic', (select id from outdoor)
  union all select 'Camping', 'camp', (select id from outdoor)
  union all select 'Dinner', 'dinner', (select id from food)
  union all select 'Coffee', 'coffee', (select id from food)
  union all select 'Tasting', 'wine', (select id from food)
  union all select 'Workshop', 'workshop', (select id from edu)
  union all select 'Lecture', 'lecture', (select id from edu)
  union all select 'Course', 'course', (select id from edu)
) v
where v.parent_id is not null
  and not exists (
    select 1 from public.categories c where lower(c.name) = lower(v.name)
  );

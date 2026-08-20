-- ToBump mobile – event organization schema
-- Run in Supabase SQL Editor

create extension if not exists "pgcrypto";

-- Profiles (1:1 with auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  first_name text not null default '',
  last_name text not null default '',
  phone text,
  avatar_url text,
  gender text check (gender in ('male', 'female', 'other', 'unspecified')),
  dob date,
  location text,
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  icon text,
  parent_id uuid references public.categories(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.enterprises (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  phone text,
  website text,
  email text,
  latitude double precision,
  longitude double precision,
  category_id uuid references public.categories(id) on delete set null,
  price numeric(10,2),
  created_by uuid references public.profiles(id) on delete set null,
  is_approved boolean not null default true,
  provider_kind text not null default 'official' check (provider_kind in ('official', 'tobump_booking')),
  created_at timestamptz not null default now()
);

create table if not exists public.friend_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.friend_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.friend_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  price numeric(10,2) default 0,
  max_participants int,
  privacy text not null default 'invite' check (privacy in ('invite', 'friends', 'group', 'friends_of_friends')),
  category_id uuid references public.categories(id) on delete set null,
  enterprise_id uuid references public.enterprises(id) on delete set null,
  venue_text text,
  group_id uuid references public.friend_groups(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete cascade,
  chat_enabled boolean not null default true,
  status text not null default 'active' check (status in ('active', 'cancelled', 'completed')),
  is_recurring boolean not null default false,
  recurrence_weekdays int[] not null default '{}'::int[],
  recurrence_rules jsonb not null default '[]'::jsonb,
  duration_minutes int,
  recurrence_until date,
  series_id uuid,
  previous_activity_id uuid references public.activities(id) on delete set null,
  series_privacy text check (series_privacy is null or series_privacy in ('invite', 'friends', 'group', 'friends_of_friends')),
  series_group_id uuid references public.friend_groups(id) on delete set null,
  series_invite_user_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_slots (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  label text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.activity_joins (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (activity_id, user_id)
);

create table if not exists public.activity_invites (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (activity_id, user_id)
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  to_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (from_user_id, to_user_id),
  check (from_user_id <> to_user_id)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  message text not null,
  data jsonb default '{}'::jsonb,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  notify_activity_join boolean not null default true,
  notify_message boolean not null default true,
  notify_friend_request boolean not null default true,
  notify_invite boolean not null default true,
  push_token text,
  locale text not null default 'en',
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_reports (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  reported_by uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_activities_starts on public.activities(starts_at);
create index if not exists idx_activities_created_by on public.activities(created_by);
create index if not exists idx_joins_user on public.activity_joins(user_id);
create index if not exists idx_joins_activity on public.activity_joins(activity_id);
create index if not exists idx_chat_activity on public.chat_messages(activity_id, created_at);
create index if not exists idx_notifications_user on public.notifications(user_id, created_at desc);
create index if not exists idx_friendships_to on public.friendships(to_user_id, status);

-- Auto profile + settings on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, first_name, last_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', '')
  );
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper: are two users friends?
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.from_user_id = a and f.to_user_id = b)
        or (f.from_user_id = b and f.to_user_id = a))
  );
$$;

-- Can current user see activity?
create or replace function public.can_view_activity(act public.activities)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select
    act.created_by = auth.uid()
    or act.privacy = 'public'
    or (act.privacy = 'friends' and public.are_friends(act.created_by, auth.uid()))
    or (
      -- FoF: prijatelji vseh, ki so že na dogodku (vključno z organizatorjem)
      act.privacy = 'friends_of_friends'
      and exists (
        select 1 from public.activity_joins j
        where j.activity_id = act.id
          and public.are_friends(j.user_id, auth.uid())
      )
    )
    or (
      act.privacy = 'group'
      and act.group_id is not null
      and exists (
        select 1 from public.friend_group_members m
        where m.group_id = act.group_id and m.user_id = auth.uid()
      )
    )
    or exists (
      select 1 from public.activity_invites i
      where i.activity_id = act.id and i.user_id = auth.uid()
    )
    or exists (
      select 1 from public.activity_joins j
      where j.activity_id = act.id and j.user_id = auth.uid()
    );
$$;

-- RLS
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.enterprises enable row level security;
alter table public.activities enable row level security;
alter table public.activity_slots enable row level security;
alter table public.activity_joins enable row level security;
alter table public.activity_invites enable row level security;
alter table public.friendships enable row level security;
alter table public.chat_messages enable row level security;
alter table public.notifications enable row level security;
alter table public.user_settings enable row level security;
alter table public.activity_reports enable row level security;

-- Profiles
create policy "profiles_select" on public.profiles for select to authenticated using (true);
create policy "profiles_update_own" on public.profiles for update to authenticated using (id = auth.uid());

-- Categories
create policy "categories_select" on public.categories for select to authenticated using (true);
create policy "categories_insert" on public.categories for insert to authenticated with check (true);

-- Enterprises
create policy "enterprises_select" on public.enterprises for select to authenticated using (true);
-- insert/update samo verificirani ponudniki (app 2) – v app 1 ni dovoljeno

-- Activities
create policy "activities_select" on public.activities for select to authenticated
  using (public.can_view_activity(activities));
create policy "activities_insert" on public.activities for insert to authenticated
  with check (created_by = auth.uid());
create policy "activities_update_own" on public.activities for update to authenticated
  using (created_by = auth.uid());
create policy "activities_delete_own" on public.activities for delete to authenticated
  using (created_by = auth.uid());

-- Slots
create policy "slots_select" on public.activity_slots for select to authenticated
  using (exists (select 1 from public.activities a where a.id = activity_id and public.can_view_activity(a)));
create policy "slots_insert" on public.activity_slots for insert to authenticated
  with check (exists (select 1 from public.activities a where a.id = activity_id and a.created_by = auth.uid()));
create policy "slots_delete" on public.activity_slots for delete to authenticated
  using (exists (select 1 from public.activities a where a.id = activity_id and a.created_by = auth.uid()));

-- Joins
create policy "joins_select" on public.activity_joins for select to authenticated
  using (exists (select 1 from public.activities a where a.id = activity_id and public.can_view_activity(a)));
create policy "joins_insert" on public.activity_joins for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.activities a
      where a.id = activity_id
        and public.can_view_activity(a)
    )
  );
create policy "joins_delete" on public.activity_joins for delete to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from public.activities a where a.id = activity_id and a.created_by = auth.uid()
  ));

-- Invites
create policy "invites_select" on public.activity_invites for select to authenticated
  using (user_id = auth.uid() or invited_by = auth.uid()
    or exists (select 1 from public.activities a where a.id = activity_id and a.created_by = auth.uid()));
create policy "invites_insert" on public.activity_invites for insert to authenticated
  with check (invited_by = auth.uid() and exists (
    select 1 from public.activities a where a.id = activity_id and a.created_by = auth.uid()
  ));
create policy "invites_delete" on public.activity_invites for delete to authenticated
  using (invited_by = auth.uid() or user_id = auth.uid());

-- Friendships
create policy "friendships_select" on public.friendships for select to authenticated
  using (from_user_id = auth.uid() or to_user_id = auth.uid());
create policy "friendships_insert" on public.friendships for insert to authenticated
  with check (from_user_id = auth.uid());
create policy "friendships_update" on public.friendships for update to authenticated
  using (to_user_id = auth.uid() or from_user_id = auth.uid());
create policy "friendships_delete" on public.friendships for delete to authenticated
  using (from_user_id = auth.uid() or to_user_id = auth.uid());

-- Chat (joined or creator)
create policy "chat_select" on public.chat_messages for select to authenticated
  using (
    exists (select 1 from public.activity_joins j where j.activity_id = chat_messages.activity_id and j.user_id = auth.uid())
    or exists (select 1 from public.activities a where a.id = chat_messages.activity_id and a.created_by = auth.uid())
  );
create policy "chat_insert" on public.chat_messages for insert to authenticated
  with check (
    user_id = auth.uid() and (
      exists (select 1 from public.activity_joins j where j.activity_id = activity_id and j.user_id = auth.uid())
      or exists (select 1 from public.activities a where a.id = activity_id and a.created_by = auth.uid())
    )
  );

-- Notifications
create policy "notifications_select" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "notifications_update" on public.notifications for update to authenticated using (user_id = auth.uid());
create policy "notifications_insert" on public.notifications for insert to authenticated with check (true);

-- Settings
create policy "settings_select" on public.user_settings for select to authenticated using (user_id = auth.uid());
create policy "settings_update" on public.user_settings for update to authenticated using (user_id = auth.uid());

-- Reports
create policy "reports_insert" on public.activity_reports for insert to authenticated
  with check (reported_by = auth.uid());
create policy "reports_select_own" on public.activity_reports for select to authenticated
  using (reported_by = auth.uid());

-- Realtime for chat
alter publication supabase_realtime add table public.chat_messages;
alter publication supabase_realtime add table public.notifications;

-- Seed categories
insert into public.categories (name, icon) values
  ('Tenis', 'tennisball'),
  ('Nogomet', 'football'),
  ('Košarka', 'basketball')
on conflict (name) do nothing;

-- Storage bucket for avatars (run once)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatar_public_read" on storage.objects for select using (bucket_id = 'avatars');
create policy "avatar_own_upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatar_own_update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatar_own_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

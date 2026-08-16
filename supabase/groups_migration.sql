-- Odpri to datoteko v Cursorju, Ctrl+A, Ctrl+C, prilepi v Supabase SQL Editor, Run.
-- NE prilepjaj imena datoteke ali poti – samo ta SQL.

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

alter table public.activities add column if not exists group_id uuid;

alter table public.activities drop constraint if exists activities_privacy_check;
alter table public.activities
  add constraint activities_privacy_check
  check (privacy in ('invite', 'friends', 'group', 'public'));
alter table public.activities alter column privacy set default 'invite';

create index if not exists idx_group_members_group on public.friend_group_members(group_id);
create index if not exists idx_group_members_user on public.friend_group_members(user_id);
create index if not exists idx_friend_groups_owner on public.friend_groups(created_by);

create or replace function public.can_view_activity(act public.activities)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    act.created_by = auth.uid()
    or act.privacy = 'public'
    or (act.privacy = 'friends' and public.are_friends(act.created_by, auth.uid()))
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

alter table public.friend_groups enable row level security;
alter table public.friend_group_members enable row level security;

drop policy if exists "groups_select" on public.friend_groups;
drop policy if exists "groups_insert" on public.friend_groups;
drop policy if exists "groups_update" on public.friend_groups;
drop policy if exists "groups_delete" on public.friend_groups;
drop policy if exists "group_members_select" on public.friend_group_members;
drop policy if exists "group_members_insert" on public.friend_group_members;
drop policy if exists "group_members_delete" on public.friend_group_members;

create or replace function public.is_group_owner(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friend_groups g
    where g.id = gid and g.created_by = auth.uid()
  );
$$;

create or replace function public.is_group_member(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friend_group_members m
    where m.group_id = gid and m.user_id = auth.uid()
  );
$$;

create policy "groups_select" on public.friend_groups for select to authenticated
  using (created_by = auth.uid() or public.is_group_member(id));

create policy "groups_insert" on public.friend_groups for insert to authenticated
  with check (created_by = auth.uid());

create policy "groups_update" on public.friend_groups for update to authenticated
  using (created_by = auth.uid());

create policy "groups_delete" on public.friend_groups for delete to authenticated
  using (created_by = auth.uid());

create policy "group_members_select" on public.friend_group_members for select to authenticated
  using (public.is_group_owner(group_id) or public.is_group_member(group_id));

create policy "group_members_insert" on public.friend_group_members for insert to authenticated
  with check (public.is_group_owner(group_id));

create policy "group_members_delete" on public.friend_group_members for delete to authenticated
  using (public.is_group_owner(group_id));

-- Popravek infinite recursion za friend_groups / friend_group_members
-- Prilepi v Supabase SQL Editor → Run

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

drop policy if exists "groups_select" on public.friend_groups;
drop policy if exists "groups_insert" on public.friend_groups;
drop policy if exists "groups_update" on public.friend_groups;
drop policy if exists "groups_delete" on public.friend_groups;
drop policy if exists "group_members_select" on public.friend_group_members;
drop policy if exists "group_members_insert" on public.friend_group_members;
drop policy if exists "group_members_delete" on public.friend_group_members;

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

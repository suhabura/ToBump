-- FoF: prijatelji vseh, ki so se že prijavili, lahko vidijo in se pridružijo
-- Run in Supabase SQL Editor → Run
-- Also fixes activities_privacy_check so 'friends_of_friends' can be saved.

alter table public.activities drop constraint if exists activities_privacy_check;
alter table public.activities
  add constraint activities_privacy_check
  check (privacy in ('invite', 'friends', 'group', 'friends_of_friends'));

alter table public.activities drop constraint if exists activities_series_privacy_check;
alter table public.activities
  add constraint activities_series_privacy_check
  check (
    series_privacy is null
    or series_privacy in ('invite', 'friends', 'group', 'friends_of_friends')
  );

create or replace function public.can_view_activity(act public.activities)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    act.created_by = auth.uid()
    or (act.privacy = 'friends' and public.are_friends(act.created_by, auth.uid()))
    or (
      -- Participants' friends: friends of anyone who already joined (incl. organizer)
      act.privacy = 'friends_of_friends'
      and exists (
        select 1
        from public.activity_joins j
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

drop policy if exists "joins_insert" on public.activity_joins;
create policy "joins_insert" on public.activity_joins for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.activities a
      where a.id = activity_id
        and public.can_view_activity(a)
    )
  );

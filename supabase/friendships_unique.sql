-- One friendship per unordered pair; email is unique identity on profiles.
-- Run in Supabase SQL Editor.

-- 1) Drop duplicate friendships (keep accepted > pending > rejected, then newest)
with ranked as (
  select
    id,
    row_number() over (
      partition by least(from_user_id, to_user_id), greatest(from_user_id, to_user_id)
      order by
        case status
          when 'accepted' then 0
          when 'pending' then 1
          else 2
        end,
        coalesce(updated_at, created_at) desc,
        created_at desc
    ) as rn
  from public.friendships
)
delete from public.friendships f
using ranked r
where f.id = r.id
  and r.rn > 1;

-- 2) Enforce unique pair regardless of direction (A→B same as B→A)
create unique index if not exists friendships_unique_pair
  on public.friendships (
    least(from_user_id, to_user_id),
    greatest(from_user_id, to_user_id)
  );

-- 3) Email as unique identity on profiles (ignore empty)
create unique index if not exists profiles_email_unique_ci
  on public.profiles (lower(trim(email)))
  where email is not null and trim(email) <> '';

-- 4) Helper: send friend request without creating a reverse duplicate
create or replace function public.send_friend_request(p_to_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  existing public.friendships%rowtype;
  new_id uuid;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if p_to_user_id is null or p_to_user_id = me then
    raise exception 'Invalid friend';
  end if;

  select * into existing
  from public.friendships
  where (from_user_id = me and to_user_id = p_to_user_id)
     or (from_user_id = p_to_user_id and to_user_id = me)
  limit 1;

  if found then
    if existing.status = 'accepted' then
      raise exception 'Already friends';
    end if;
    if existing.status = 'pending' then
      -- If they already invited me, accept instead of duplicating
      if existing.to_user_id = me then
        update public.friendships
        set status = 'accepted', updated_at = now()
        where id = existing.id;
        return existing.id;
      end if;
      raise exception 'Friend request already pending';
    end if;
    -- rejected → reopen as new pending from me
    update public.friendships
    set
      from_user_id = me,
      to_user_id = p_to_user_id,
      status = 'pending',
      updated_at = now()
    where id = existing.id;
    return existing.id;
  end if;

  insert into public.friendships (from_user_id, to_user_id, status)
  values (me, p_to_user_id, 'pending')
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.send_friend_request(uuid) from public;
grant execute on function public.send_friend_request(uuid) to authenticated;

-- 5) On accept: remove any other rows for the same pair
create or replace function public.accept_friend_request(p_friendship_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cur public.friendships%rowtype;
  a uuid;
  b uuid;
begin
  select * into cur from public.friendships where id = p_friendship_id for update;
  if not found then
    return;
  end if;
  if cur.to_user_id is distinct from auth.uid() then
    raise exception 'Not allowed';
  end if;
  if cur.status <> 'pending' then
    return;
  end if;

  update public.friendships
  set status = 'accepted', updated_at = now()
  where id = cur.id;

  a := least(cur.from_user_id, cur.to_user_id);
  b := greatest(cur.from_user_id, cur.to_user_id);

  delete from public.friendships
  where id <> cur.id
    and least(from_user_id, to_user_id) = a
    and greatest(from_user_id, to_user_id) = b;
end;
$$;

revoke all on function public.accept_friend_request(uuid) from public;
grant execute on function public.accept_friend_request(uuid) to authenticated;

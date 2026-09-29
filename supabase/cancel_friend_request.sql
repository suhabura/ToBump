-- Cancel a friend request you sent, and remove the recipient's notification.
-- Run in the Supabase SQL editor.

create or replace function public.cancel_friend_request(p_friendship_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cur public.friendships%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into cur
  from public.friendships
  where id = p_friendship_id
  for update;

  if not found then
    return;
  end if;

  if cur.from_user_id is distinct from auth.uid() then
    raise exception 'Not allowed';
  end if;

  if cur.status <> 'pending' then
    raise exception 'Not a pending request';
  end if;

  delete from public.notifications
  where user_id = cur.to_user_id
    and type = 'friend_request'
    and data->>'from_user_id' = cur.from_user_id::text;

  delete from public.friendships
  where id = cur.id;
end;
$$;

revoke all on function public.cancel_friend_request(uuid) from public;
grant execute on function public.cancel_friend_request(uuid) to authenticated;

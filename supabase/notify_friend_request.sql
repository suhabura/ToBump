-- Reliable in-app notifications for friend requests (respects user_settings).
-- Run in Supabase SQL editor.

create or replace function public.notify_user(
  p_user_id uuid,
  p_type text,
  p_message text,
  p_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed boolean := true;
  new_id uuid;
  payload jsonb := coalesce(p_data, '{}'::jsonb);
begin
  if p_user_id is null or p_type is null or p_message is null then
    return null;
  end if;

  select case p_type
    when 'friend_request' then coalesce(s.notify_friend_request, true)
    when 'friend_accepted' then coalesce(s.notify_friend_request, true)
    when 'message' then coalesce(s.notify_message, true)
    when 'activity_join' then coalesce(s.notify_activity_join, true)
    when 'invite' then coalesce(s.notify_invite, true)
    when 'editor' then coalesce(s.notify_invite, true)
    else true
  end
  into allowed
  from public.user_settings s
  where s.user_id = p_user_id;

  if allowed is null then
    allowed := true;
  end if;

  if not allowed then
    return null;
  end if;

  -- Avoid duplicate friend notifications when both trigger + client fire
  if p_type = 'friend_request'
    and payload ? 'from_user_id'
    and exists (
      select 1
      from public.notifications n
      where n.user_id = p_user_id
        and n.type = 'friend_request'
        and n.data->>'from_user_id' = payload->>'from_user_id'
        and n.created_at > now() - interval '2 minutes'
    )
  then
    return null;
  end if;

  if p_type = 'friend_accepted'
    and payload ? 'user_id'
    and exists (
      select 1
      from public.notifications n
      where n.user_id = p_user_id
        and n.type = 'friend_accepted'
        and n.data->>'user_id' = payload->>'user_id'
        and n.created_at > now() - interval '2 minutes'
    )
  then
    return null;
  end if;

  insert into public.notifications (user_id, type, message, data)
  values (p_user_id, p_type, p_message, payload)
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.notify_user(uuid, text, text, jsonb) from public;
grant execute on function public.notify_user(uuid, text, text, jsonb) to authenticated;

create or replace function public.friendship_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recipient uuid;
  locale text := 'en';
  msg text;
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    recipient := new.to_user_id;
    select coalesce(s.locale, 'en') into locale
    from public.user_settings s
    where s.user_id = recipient;

    msg := case when locale = 'sl'
      then 'Nova prošnja za prijateljstvo'
      else 'New friend request'
    end;

    perform public.notify_user(
      recipient,
      'friend_request',
      msg,
      jsonb_build_object('from_user_id', new.from_user_id, 'friendship_id', new.id)
    );
    return new;
  end if;

  if tg_op = 'UPDATE'
    and old.status = 'pending'
    and new.status = 'accepted'
  then
    recipient := new.from_user_id;
    select coalesce(s.locale, 'en') into locale
    from public.user_settings s
    where s.user_id = recipient;

    msg := case when locale = 'sl'
      then 'Prošnja sprejeta'
      else 'Friend request accepted'
    end;

    perform public.notify_user(
      recipient,
      'friend_accepted',
      msg,
      jsonb_build_object('user_id', new.to_user_id, 'friendship_id', new.id)
    );
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_friendship_notify on public.friendships;
create trigger trg_friendship_notify
  after insert or update of status on public.friendships
  for each row
  execute function public.friendship_notify();

-- Realtime badge for pending friend requests
do $$
begin
  alter publication supabase_realtime add table public.friendships;
exception
  when duplicate_object then null;
end $$;

-- Backfill missing in-app notifications for current pending requests
insert into public.notifications (user_id, type, message, data)
select
  f.to_user_id,
  'friend_request',
  case when coalesce(s.locale, 'en') = 'sl'
    then 'Nova prošnja za prijateljstvo'
    else 'New friend request'
  end,
  jsonb_build_object('from_user_id', f.from_user_id, 'friendship_id', f.id)
from public.friendships f
left join public.user_settings s on s.user_id = f.to_user_id
where f.status = 'pending'
  and not exists (
    select 1
    from public.notifications n
    where n.user_id = f.to_user_id
      and n.type = 'friend_request'
      and (
        n.data->>'friendship_id' = f.id::text
        or n.data->>'from_user_id' = f.from_user_id::text
      )
  );

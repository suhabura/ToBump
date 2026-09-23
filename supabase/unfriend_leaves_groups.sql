-- Ob prekinitvi prijateljstva oseba izgine iz grup, ki jih je ustvaril drugi.
-- Prilepi v Supabase SQL Editor → Run.

create or replace function public.unfriend_leaves_groups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.friend_group_members m
  using public.friend_groups g
  where m.group_id = g.id
    and (
      (g.created_by = old.from_user_id and m.user_id = old.to_user_id)
      or (g.created_by = old.to_user_id and m.user_id = old.from_user_id)
    );
  return old;
end;
$$;

drop trigger if exists trg_unfriend_leaves_groups on public.friendships;
create trigger trg_unfriend_leaves_groups
  before delete on public.friendships
  for each row
  execute function public.unfriend_leaves_groups();

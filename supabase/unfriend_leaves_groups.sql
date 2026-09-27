-- Ob prekinitvi prijateljstva oseba izgine iz skupin drugega.
-- Skupina brez članov se izbriše. Dogodki ostanejo, povezava na skupino se spusti.
-- Zaženi znova v urejevalniku SQL v Supabase.

create or replace function public.unfriend_leaves_groups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  touched uuid[];
  gid uuid;
begin
  select array_agg(distinct g.id) into touched
  from public.friend_groups g
  join public.friend_group_members m on m.group_id = g.id
  where (g.created_by = old.from_user_id and m.user_id = old.to_user_id)
     or (g.created_by = old.to_user_id and m.user_id = old.from_user_id);

  delete from public.friend_group_members m
  using public.friend_groups g
  where m.group_id = g.id
    and (
      (g.created_by = old.from_user_id and m.user_id = old.to_user_id)
      or (g.created_by = old.to_user_id and m.user_id = old.from_user_id)
    );

  if touched is null then
    return old;
  end if;

  for gid in
    select g.id
    from public.friend_groups g
    where g.id = any(touched)
      and not exists (
        select 1 from public.friend_group_members m where m.group_id = g.id
      )
  loop
    update public.activities set group_id = null where group_id = gid;
    begin
      update public.activities set series_group_id = null where series_group_id = gid;
    exception
      when undefined_column then null;
    end;
    begin
      update public.series_finance_settings set payer_group_id = null where payer_group_id = gid;
    exception
      when undefined_table or undefined_column then null;
    end;
    delete from public.friend_groups where id = gid;
  end loop;

  return old;
end;
$$;

drop trigger if exists trg_unfriend_leaves_groups on public.friendships;
create trigger trg_unfriend_leaves_groups
  before delete on public.friendships
  for each row
  execute function public.unfriend_leaves_groups();

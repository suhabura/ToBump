-- Owner can delete a group even when events still point at it.
-- Run once in the Supabase SQL editor.

create or replace function public.delete_friend_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.friend_groups g
    where g.id = p_group_id and g.created_by = auth.uid()
  ) then
    raise exception 'Could not delete the group.';
  end if;

  update public.activities set group_id = null where group_id = p_group_id;

  begin
    update public.activities set series_group_id = null where series_group_id = p_group_id;
  exception
    when undefined_column then null;
  end;

  begin
    update public.series_finance_settings set payer_group_id = null where payer_group_id = p_group_id;
  exception
    when undefined_table or undefined_column then null;
  end;

  delete from public.friend_group_members where group_id = p_group_id;
  delete from public.friend_groups where id = p_group_id;
end;
$$;

grant execute on function public.delete_friend_group(uuid) to authenticated;

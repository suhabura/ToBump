-- Kdo naj dobi obvestilo, ko organizator odpre termin prijateljem udeležencev.
-- Prijateljstev drugih oseb odjemalec ne vidi, zato seznam sestavi ta funkcija.
-- Prilepi v Supabase SQL Editor → Run.

create or replace function public.fof_open_recipients(p_activity_id uuid)
returns table (recipient_id uuid, joiner_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  act public.activities%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into act from public.activities where id = p_activity_id;
  if not found then
    raise exception 'Event not found';
  end if;
  if act.created_by is distinct from auth.uid() and not public.can_edit_activity(act) then
    raise exception 'Not allowed';
  end if;

  return query
  select picked.recipient_id, picked.joiner_id
  from (
    select distinct on (other.other_id)
      other.other_id as recipient_id,
      j.user_id as joiner_id
    from public.activity_joins j
    join public.friendships f
      on f.status = 'accepted'
     and (f.from_user_id = j.user_id or f.to_user_id = j.user_id)
    cross join lateral (
      select case
        when f.from_user_id = j.user_id then f.to_user_id
        else f.from_user_id
      end as other_id
    ) other
    where j.activity_id = p_activity_id
      and other.other_id is distinct from act.created_by
      and not exists (
        select 1 from public.activity_joins jj
        where jj.activity_id = p_activity_id and jj.user_id = other.other_id
      )
      and not exists (
        select 1 from public.activity_invites i
        where i.activity_id = p_activity_id and i.user_id = other.other_id
      )
    order by other.other_id, j.user_id
  ) picked;
end;
$$;

grant execute on function public.fof_open_recipients(uuid) to authenticated;

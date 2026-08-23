-- Clear per-event funding fee when a participant leaves an occurrence.
-- Safe to re-run in Supabase SQL Editor.

create or replace function public.clear_attendance_funding_fee(
  p_activity_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  act public.activities%rowtype;
  sid uuid;
  period text;
  exp_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into act from public.activities where id = p_activity_id;
  if not found then return; end if;

  sid := coalesce(act.series_id, act.id);

  -- Self, organizer, series finance manager, or activity editor
  if auth.uid() <> p_user_id
     and act.created_by <> auth.uid()
     and not public.can_manage_series_finance(sid)
     and not exists (
       select 1 from public.activity_editors e
       where e.activity_id = p_activity_id and e.user_id = auth.uid()
     )
  then
    raise exception 'Not allowed';
  end if;

  period := format('fee:event:%s:user:%s', p_activity_id, p_user_id);

  for exp_id in
    select e.id
    from public.activity_expenses e
    where e.period_key = period
  loop
    delete from public.activity_expenses where id = exp_id;
  end loop;

  -- Clear locked fee on join if the row still exists
  begin
    update public.activity_joins
    set fee_amount = null, fee_obligation_id = null
    where activity_id = p_activity_id and user_id = p_user_id;
  exception
    when undefined_column then null;
  end;
end;
$$;

grant execute on function public.clear_attendance_funding_fee(uuid, uuid) to authenticated;

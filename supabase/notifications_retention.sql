-- Obvestila so kratek znak, ne zgodovina. Po 7 dneh se zbrišejo.
-- Prilepi v Supabase SQL Editor → Run.

create or replace function public.prune_my_notifications()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  delete from public.notifications
  where user_id = auth.uid()
    and created_at < now() - interval '7 days';
end;
$$;

revoke all on function public.prune_my_notifications() from public;
grant execute on function public.prune_my_notifications() to authenticated;

delete from public.notifications
where created_at < now() - interval '7 days';

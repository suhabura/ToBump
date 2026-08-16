-- Ustavi serijo: ob ročnem izbrisu ponavljajočega se novi termini ne ustvarijo.
-- Prilepi v Supabase SQL Editor → Run (po recurrence.sql)

create or replace function public.cancel_activity_series(p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cur public.activities%rowtype;
  sid uuid;
begin
  select * into cur from public.activities where id = p_activity_id for update;
  if not found then
    return;
  end if;

  if cur.created_by is distinct from auth.uid() then
    raise exception 'Ni dovoljenja za izbris te serije';
  end if;

  sid := coalesce(cur.series_id, cur.id);

  -- Najprej ustavi ponavljanje (da process_due / open_next ne ustvari naslednjega)
  update public.activities
  set
    is_recurring = false,
    status = 'cancelled',
    recurrence_rules = '[]'::jsonb,
    recurrence_weekdays = '{}'::int[],
    updated_at = now()
  where id = sid
     or series_id = sid
     or id = p_activity_id;

  delete from public.activities
  where id = sid
     or series_id = sid
     or id = p_activity_id;
end;
$$;

grant execute on function public.cancel_activity_series(uuid) to authenticated;

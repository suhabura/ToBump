-- One-time events leave active lists the moment they start.
-- Run in Supabase SQL editor (updates process_due_recurring_activities).

create or replace function public.process_due_recurring_activities()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
  opened uuid;
  deleted int := 0;
begin
  -- Enkratni: completed takoj ob starts_at (ne brišemo zaradi finance/zgodovine)
  with gone as (
    update public.activities a
    set status = 'completed',
        updated_at = now()
    where a.status = 'active'
      and coalesce(a.is_recurring, false) = false
      and a.starts_at <= now()
    returning 1
  )
  select count(*)::int into deleted from gone;
  n := n + coalesce(deleted, 0);

  -- Ponavljajoči, ki so se že začeli
  for r in
    select a.id
    from public.activities a
    where a.is_recurring = true
      and a.status = 'active'
      and a.starts_at <= now()
    order by a.starts_at
    limit 50
  loop
    opened := public.open_next_recurring_activity(r.id);
    n := n + 1;
  end loop;

  return n;
end;
$$;

grant execute on function public.process_due_recurring_activities() to authenticated;

-- Takoj počisti že začete enkratne dogodke
update public.activities
set status = 'completed',
    updated_at = now()
where status = 'active'
  and coalesce(is_recurring, false) = false
  and starts_at <= now();

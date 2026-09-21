-- Explicit "can't come" for one occurrence. Silence stays "no answer".
-- Join does not carry, and neither does a decline.

create table if not exists public.activity_declines (
  activity_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (activity_id, user_id)
);

alter table public.activity_declines enable row level security;

drop policy if exists "declines_select" on public.activity_declines;
create policy "declines_select" on public.activity_declines for select to authenticated
  using (exists (
    select 1 from public.activities a
    where a.id = activity_id and public.can_view_activity(a)
  ));

drop policy if exists "declines_insert" on public.activity_declines;
create policy "declines_insert" on public.activity_declines for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.activities a
      where a.id = activity_id and public.can_view_activity(a)
    )
  );

drop policy if exists "declines_delete" on public.activity_declines;
create policy "declines_delete" on public.activity_declines for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.activity_declines to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.activity_declines;
exception
  when duplicate_object then null;
end $$;

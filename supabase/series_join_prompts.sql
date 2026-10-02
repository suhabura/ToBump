-- Remember that the first Pridem / Ne pridem choice was answered for a series.
-- Run in Supabase SQL Editor. Safe to re-run.

create table if not exists public.series_join_prompts (
  series_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);

create index if not exists idx_series_join_prompts_user on public.series_join_prompts(user_id);

alter table public.series_join_prompts enable row level security;

drop policy if exists "series_join_prompts_select" on public.series_join_prompts;
drop policy if exists "series_join_prompts_insert" on public.series_join_prompts;
drop policy if exists "series_join_prompts_delete" on public.series_join_prompts;
create policy "series_join_prompts_select" on public.series_join_prompts for select to authenticated
  using (user_id = auth.uid());
create policy "series_join_prompts_insert" on public.series_join_prompts for insert to authenticated
  with check (user_id = auth.uid() and public.user_can_see_series(series_id));
create policy "series_join_prompts_delete" on public.series_join_prompts for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.series_join_prompts to authenticated;

-- Let an editor, not only the organizer, mark one series day as skipped
-- when they move that occurrence. Run once in the Supabase SQL editor.
-- The organizer can already do this without this file.

drop policy if exists "series_skipped_insert" on public.series_skipped_dates;
drop policy if exists "series_skipped_delete" on public.series_skipped_dates;

create policy "series_skipped_insert" on public.series_skipped_dates for insert to authenticated
  with check (
    exists (
      select 1 from public.activities a
      where coalesce(a.series_id, a.id) = series_id
        and (
          a.created_by = auth.uid()
          or exists (
            select 1 from public.activity_editors e
            where e.activity_id = a.id and e.user_id = auth.uid()
          )
        )
    )
  );

create policy "series_skipped_delete" on public.series_skipped_dates for delete to authenticated
  using (
    exists (
      select 1 from public.activities a
      where coalesce(a.series_id, a.id) = series_id
        and (
          a.created_by = auth.uid()
          or exists (
            select 1 from public.activity_editors e
            where e.activity_id = a.id and e.user_id = auth.uid()
          )
        )
    )
  );

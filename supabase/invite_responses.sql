-- Let anyone who can open an event see who was invited, so "No reply" is not organizer-only.
-- Run in the Supabase SQL editor.

drop policy if exists "invites_select" on public.activity_invites;
create policy "invites_select" on public.activity_invites for select to authenticated
  using (
    user_id = auth.uid()
    or invited_by = auth.uid()
    or exists (
      select 1 from public.activities a
      where a.id = activity_id
        and (a.created_by = auth.uid() or public.can_view_activity(a))
    )
  );

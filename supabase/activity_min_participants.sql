-- Optional min capacity on events. Run in Supabase SQL Editor. Safe to re-run.
-- After this, re-run supabase/recurring_always_one_open.sql so the next
-- occurrence copies min_participants.

alter table public.activities
  add column if not exists min_participants int;

comment on column public.activities.min_participants is
  'Optional lower bound of attendees; max_participants remains the join cap.';

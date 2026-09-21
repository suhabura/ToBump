-- Feed looks up invites by the signed-in user.
-- Planner looks up a person's events by creator, status, and start time.

create index if not exists idx_invites_user on public.activity_invites (user_id);

create index if not exists idx_activities_creator_status_starts
  on public.activities (created_by, status, starts_at);

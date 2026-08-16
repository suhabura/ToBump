-- Če skupine obstajajo, a app še javlja napako – zaženi še te GRANT-e:
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.friend_groups to authenticated;
grant select, insert, update, delete on public.friend_group_members to authenticated;
grant usage, select on all sequences in schema public to authenticated;

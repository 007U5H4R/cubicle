alter table anon_sessions enable row level security;
alter table runs enable row level security;
alter table messages enable row level security;
alter table artifacts enable row level security;
alter table events enable row level security;

create policy runs_read_shared_or_owned on runs for select to anon, authenticated
  using (is_shared or owner_user_id = auth.uid());

create policy messages_read_via_run on messages for select to anon, authenticated
  using (exists (select 1 from runs r where r.id = messages.run_id and (r.is_shared or r.owner_user_id = auth.uid())));

create policy artifacts_read_via_run on artifacts for select to anon, authenticated
  using (exists (select 1 from runs r where r.id = artifacts.run_id and (r.is_shared or r.owner_user_id = auth.uid())));
-- anon_sessions and events: RLS on, no policies -> invisible to anon/authenticated; service role bypasses RLS.

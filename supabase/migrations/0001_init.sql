create extension if not exists pgcrypto;

create table if not exists anon_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  claimed_by_user_id uuid references auth.users(id),
  referrer text not null check (referrer in ('direct','share_link','campaign'))
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  anon_session_id uuid not null references anon_sessions(id),
  owner_user_id uuid references auth.users(id),
  idea text not null check (char_length(idea) between 1 and 500),
  status text not null default 'queued' check (status in ('queued','running','complete','failed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  stop_reason text check (stop_reason in ('done','cap_messages','cap_time','cap_tokens','repeat')),
  model_agent text not null,
  model_orchestrator text not null,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_cents integer not null default 0,
  share_slug text unique,
  is_shared boolean not null default false,
  error text
);
create index if not exists runs_status_started_idx on runs (status, started_at);
create index if not exists runs_anon_session_idx on runs (anon_session_id);
create index if not exists runs_owner_idx on runs (owner_user_id);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  seq integer not null,
  from_role text not null check (from_role in ('pm','researcher','designer','developer','office')),
  to_role text not null check (to_role in ('pm','researcher','designer','developer','team')),
  act text not null check (act in ('propose','question','objection','agree','done')),
  subject text not null,
  body text not null,
  reply_to uuid references messages(id),
  hops integer not null default 0 check (hops between 0 and 3),
  brief text,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create table if not exists artifacts (
  run_id uuid not null references runs(id) on delete cascade,
  type text not null check (type in ('prd','scan','copy','plan')),
  status text not null default 'pending' check (status in ('pending','streaming','done','failed')),
  content_md text not null default '',
  grounded boolean not null default false,
  sources jsonb not null default '[]'::jsonb,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (run_id, type)
);

create table if not exists events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  anon_session_id uuid,
  user_id uuid,
  run_id uuid,
  name text not null,
  props jsonb not null default '{}'::jsonb
);
create index if not exists events_name_ts_idx on events (name, ts);
create index if not exists events_run_idx on events (run_id);

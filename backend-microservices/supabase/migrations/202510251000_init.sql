-- QRush Trivia initial schema for Supabase

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  nickname text not null,
  whatsapp_number text unique not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_activity timestamptz
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  title text unique not null,
  status text not null default 'scheduled', -- scheduled | pre_game | in_progress | finished | cancelled
  start_time timestamptz not null,
  end_time timestamptz,
  started_at timestamptz,
  prize_pool numeric(12,2) not null default 0,
  total_questions int not null default 10,
  winner_count int default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  question_text text not null,
  option_a text not null,
  option_b text not null,
  option_c text not null,
  option_d text not null,
  correct_answer text not null,
  question_order int not null
);
create index if not exists idx_questions_game_order on public.questions(game_id, question_order);

create table if not exists public.game_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'registered', -- registered | active | eliminated | winner
  eliminated_by_question int,
  created_at timestamptz not null default now(),
  unique (game_id, user_id)
);
create index if not exists idx_game_players_game on public.game_players(game_id);

create table if not exists public.player_answers (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  question_number int not null,
  answer text not null,
  is_correct boolean,
  created_at timestamptz not null default now()
);
create index if not exists idx_player_answers_lookup on public.player_answers(game_id, user_id, question_number);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  to_number text not null,
  template text,
  message text,
  payload jsonb,
  status text not null default 'queued', -- queued | sending | sent | failed
  created_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Example RPCs (optional; functions can also insert directly)
-- create or replace function public.create_game(
--   p_title text,
--   p_start_time timestamptz,
--   p_prize_pool numeric,
--   p_total_questions int
-- ) returns uuid as $$
-- declare v_id uuid;
-- begin
--   insert into public.games(title, start_time, prize_pool, total_questions)
--   values (p_title, p_start_time, p_prize_pool, p_total_questions)
--   returning id into v_id;
--   return v_id;
-- exception when unique_violation then
--   raise exception 'DUPLICATE_TITLE' using errcode = '23505';
-- end; $$ language plpgsql security definer;

-- RLS policies can be added later. For now, keep tables open in development.

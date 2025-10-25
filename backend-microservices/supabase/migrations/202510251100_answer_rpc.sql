-- Atomic answer processing RPC to prevent race conditions
-- This function handles the entire answer workflow in a single transaction

create or replace function public.record_player_answer(
  p_game_id uuid,
  p_whatsapp_number text,
  p_answer text
) returns jsonb as $$
declare
  v_user_id uuid;
  v_game_status text;
  v_question_number int;
  v_question record;
  v_is_correct boolean;
  v_player_status text;
  v_remaining_count int;
  v_result jsonb;
begin
  -- Find user by WhatsApp number
  select id into v_user_id from public.users where whatsapp_number = p_whatsapp_number;
  if v_user_id is null then
    return jsonb_build_object('error', 'User not found', 'code', 'USER_NOT_FOUND');
  end if;

  -- Check game status
  select status into v_game_status from public.games where id = p_game_id;
  if v_game_status is null then
    return jsonb_build_object('error', 'Game not found', 'code', 'GAME_NOT_FOUND');
  end if;
  if v_game_status != 'in_progress' then
    return jsonb_build_object('error', 'Game is not in progress', 'code', 'GAME_NOT_ACTIVE');
  end if;

  -- Check player is not already eliminated
  select status into v_player_status from public.game_players 
  where game_id = p_game_id and user_id = v_user_id;
  
  if v_player_status is null then
    return jsonb_build_object('error', 'Player not registered', 'code', 'NOT_REGISTERED');
  end if;
  
  if v_player_status = 'eliminated' then
    return jsonb_build_object('error', 'Player already eliminated', 'code', 'ALREADY_ELIMINATED');
  end if;

  -- Determine next question number for this player
  select coalesce(count(*), 0) + 1 into v_question_number
  from public.player_answers
  where game_id = p_game_id and user_id = v_user_id;

  -- Fetch the question
  select * into v_question from public.questions
  where game_id = p_game_id and question_order = v_question_number;

  if v_question is null then
    return jsonb_build_object('error', 'No more questions', 'code', 'NO_QUESTION');
  end if;

  -- Check correctness
  v_is_correct := (upper(trim(p_answer)) = upper(trim(v_question.correct_answer)));

  -- Insert answer record
  insert into public.player_answers (game_id, user_id, question_number, answer, is_correct)
  values (p_game_id, v_user_id, v_question_number, p_answer, v_is_correct);

  if not v_is_correct then
    -- Eliminate player
    update public.game_players
    set status = 'eliminated', eliminated_by_question = v_question_number
    where game_id = p_game_id and user_id = v_user_id;

    return jsonb_build_object(
      'result', 'eliminated',
      'question_number', v_question_number,
      'correct_answer', v_question.correct_answer,
      'user_id', v_user_id
    );
  end if;

  -- Answer is correct - check if this player is now the only remaining player
  select count(*) into v_remaining_count
  from public.game_players
  where game_id = p_game_id and status not in ('eliminated');

  if v_remaining_count = 1 then
    -- We have a winner!
    update public.game_players
    set status = 'winner'
    where game_id = p_game_id and user_id = v_user_id;

    update public.games
    set status = 'finished', winner_count = 1, end_time = now()
    where id = p_game_id;

    return jsonb_build_object(
      'result', 'winner',
      'question_number', v_question_number,
      'user_id', v_user_id,
      'game_finished', true
    );
  end if;

  -- Correct answer, game continues
  return jsonb_build_object(
    'result', 'correct',
    'question_number', v_question_number,
    'remaining_players', v_remaining_count,
    'user_id', v_user_id
  );

exception
  when others then
    return jsonb_build_object('error', SQLERRM, 'code', 'INTERNAL_ERROR');
end;
$$ language plpgsql security definer;

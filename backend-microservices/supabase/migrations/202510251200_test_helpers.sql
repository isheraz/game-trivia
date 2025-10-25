-- Helper function to bulk insert questions for a game
create or replace function public.bulk_insert_questions(
  p_game_id uuid,
  p_questions jsonb -- array of {question_text, option_a, option_b, option_c, option_d, correct_answer}
) returns int as $$
declare
  v_question jsonb;
  v_order int := 0;
  v_count int := 0;
begin
  for v_question in select * from jsonb_array_elements(p_questions)
  loop
    v_order := v_order + 1;
    insert into public.questions (
      game_id,
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_answer,
      question_order
    ) values (
      p_game_id,
      v_question->>'question_text',
      v_question->>'option_a',
      v_question->>'option_b',
      v_question->>'option_c',
      v_question->>'option_d',
      v_question->>'correct_answer',
      v_order
    );
    v_count := v_count + 1;
  end loop;
  
  return v_count;
end;
$$ language plpgsql security definer;

-- Sample data insertion for testing
-- Run this to populate a test game with questions
do $$
declare
  v_game_id uuid;
begin
  -- Create a test game
  insert into public.games (title, start_time, prize_pool, total_questions, status)
  values (
    'Sample Test Game ' || extract(epoch from now())::text,
    now() + interval '1 hour',
    100,
    5,
    'scheduled'
  ) returning id into v_game_id;
  
  -- Insert sample questions
  perform public.bulk_insert_questions(v_game_id, '[
    {
      "question_text": "Who wrote Hamlet?",
      "option_a": "Shakespeare",
      "option_b": "Dickens",
      "option_c": "Twain",
      "option_d": "Austen",
      "correct_answer": "Shakespeare"
    },
    {
      "question_text": "What is 2 + 2?",
      "option_a": "3",
      "option_b": "4",
      "option_c": "5",
      "option_d": "6",
      "correct_answer": "4"
    },
    {
      "question_text": "Capital of France?",
      "option_a": "London",
      "option_b": "Berlin",
      "option_c": "Paris",
      "option_d": "Madrid",
      "correct_answer": "Paris"
    },
    {
      "question_text": "Largest ocean?",
      "option_a": "Atlantic",
      "option_b": "Pacific",
      "option_c": "Indian",
      "option_d": "Arctic",
      "correct_answer": "Pacific"
    },
    {
      "question_text": "Speed of light?",
      "option_a": "300,000 km/s",
      "option_b": "150,000 km/s",
      "option_c": "500,000 km/s",
      "option_d": "100,000 km/s",
      "correct_answer": "300,000 km/s"
    }
  ]'::jsonb);
  
  raise notice 'Test game created with ID: %', v_game_id;
end $$;

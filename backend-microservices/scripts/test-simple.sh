#!/usr/bin/env bash
# Simple test script using SQL and non-admin endpoints
# This bypasses admin authentication issues

set -e

echo "🎮 QRush Trivia - SQL-Based Test Flow"
echo "======================================"
echo ""

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
TEST_PHONE="${TEST_PHONE:-923196612416}"
# Supabase API keys (defaults to local dev keys printed by `supabase start`)
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH}"
SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz}"

echo "📍 Supabase URL: $SUPABASE_URL"
echo "📱 Test phone: $TEST_PHONE"
echo ""

# Step 1: Create game via SQL
echo "Step 1: Creating game via SQL..."
GAME_ID=$(psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -t -A -c "
INSERT INTO games (title, start_time, prize_pool, total_questions, status)
VALUES ('Test Game ' || extract(epoch from now())::text, now() + interval '1 hour', 100, 5, 'scheduled')
RETURNING id::text;
" | head -1)

if [ -z "$GAME_ID" ]; then
  echo "❌ Failed to create game"
  exit 1
fi

echo "✅ Game created: $GAME_ID"
echo ""

# Step 2: Add questions via SQL
echo "Step 2: Adding questions..."
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "
SELECT bulk_insert_questions('$GAME_ID', '[
  {\"question_text\": \"Who wrote Hamlet?\", \"option_a\": \"Shakespeare\", \"option_b\": \"Dickens\", \"option_c\": \"Twain\", \"option_d\": \"Austen\", \"correct_answer\": \"Shakespeare\"},
  {\"question_text\": \"What is 2 + 2?\", \"option_a\": \"3\", \"option_b\": \"4\", \"option_c\": \"5\", \"option_d\": \"6\", \"correct_answer\": \"4\"},
  {\"question_text\": \"Capital of France?\", \"option_a\": \"London\", \"option_b\": \"Berlin\", \"option_c\": \"Paris\", \"option_d\": \"Madrid\", \"correct_answer\": \"Paris\"},
  {\"question_text\": \"Largest ocean?\", \"option_a\": \"Atlantic\", \"option_b\": \"Pacific\", \"option_c\": \"Indian\", \"option_d\": \"Arctic\", \"correct_answer\": \"Pacific\"},
  {\"question_text\": \"Speed of light?\", \"option_a\": \"300,000 km/s\", \"option_b\": \"150,000 km/s\", \"option_c\": \"500,000 km/s\", \"option_d\": \"100,000 km/s\", \"correct_answer\": \"300,000 km/s\"}
]'::jsonb);
" > /dev/null
echo "✅ Questions added"
echo ""

# Step 3: Open registration
echo "Step 3: Opening registration..."
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "UPDATE games SET status = 'pre_game' WHERE id = '$GAME_ID';" > /dev/null
echo "✅ Registration opened"
echo ""

# Step 4: Player joins
echo "Step 4: Player joining game..."
JOIN_RESPONSE=$(curl -s -X POST "$SUPABASE_URL/functions/v1/registration" \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d "{\"gameId\":\"$GAME_ID\",\"phoneNumber\":\"$TEST_PHONE\"}")
echo "Response: $JOIN_RESPONSE"
echo ""

# Step 5: Start game
echo "Step 5: Starting game..."
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "UPDATE games SET status = 'in_progress', started_at = now() WHERE id = '$GAME_ID';" > /dev/null
echo "✅ Game started"
echo ""

# Step 6: Submit answers
echo "Step 6: Submitting answers..."

for i in 1 2 3; do
  case "$i" in
    1) ANSWER="Shakespeare" ;;
    2) ANSWER="4" ;;
    *) ANSWER="Wrong" ;;
  esac

  echo "  Question $i: Submitting answer '$ANSWER'..."
  ANSWER_RESPONSE=$(curl -s -X POST "$SUPABASE_URL/functions/v1/gameplay" \
    -H "Content-Type: application/json" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -d "{\"gameId\":\"$GAME_ID\",\"phoneNumber\":\"$TEST_PHONE\",\"answer\":\"$ANSWER\"}")
  
  echo "  Response: $ANSWER_RESPONSE"
  
  # Check if eliminated
  if echo "$ANSWER_RESPONSE" | grep -q "eliminated"; then
    echo "  ⚠️  Player eliminated - test complete"
    break
  fi
  
  sleep 1
done
echo ""

# Step 7: Check notifications
echo "Step 7: Checking notifications..."
NOTIF_COUNT=$(psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -t -A -c "SELECT count(*) FROM notifications WHERE to_number = '$TEST_PHONE';")
echo "✅ $NOTIF_COUNT notifications queued for $TEST_PHONE"
echo ""

# Step 8: Process notifications
echo "Step 8: Processing notification queue..."
DISPATCH_RESPONSE=$(curl -s "$SUPABASE_URL/functions/v1/cron-dispatcher" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY")
echo "Response: $DISPATCH_RESPONSE"
echo ""

# Step 9: Check final status
echo "Step 9: Checking final game status..."
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "
SELECT 
  g.id,
  g.status,
  g.winner_count,
  (SELECT count(*) FROM game_players WHERE game_id = g.id) as total_players,
  (SELECT count(*) FROM game_players WHERE game_id = g.id AND status = 'eliminated') as eliminated_players,
  (SELECT count(*) FROM notifications WHERE to_number = '$TEST_PHONE') as notifications_sent
FROM games g 
WHERE g.id = '$GAME_ID';
"
echo ""

echo "✅ Test flow completed!"
echo ""
echo "📊 Next steps:"
echo "  - View notifications: psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \"SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5;\""
echo "  - View player answers: psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \"SELECT * FROM player_answers WHERE game_id = '$GAME_ID';\""
echo "  - Export results: curl \"$SUPABASE_URL/functions/v1/admin-games/$GAME_ID/export\""

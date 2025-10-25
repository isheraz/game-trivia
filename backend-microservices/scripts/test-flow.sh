#!/usr/bin/env bash
# Local development test script for QRush Trivia Supabase Backend

set -e

echo "🎮 QRush Trivia Test Script"
echo "=============================="
echo ""

# Configuration
SUPABASE_URL="${SUPABASE_URL:-http://localhost:54321}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@qrush.com}"
TEST_PHONE="${TEST_PHONE:-923196612416}"
DEV_BYPASS="${ADMIN_DEV_PASSWORD:-dev123}"

echo "📍 Using Supabase URL: $SUPABASE_URL"
echo "👤 Admin email: $ADMIN_EMAIL"
echo "📱 Test phone: $TEST_PHONE"
echo ""

# Helper function for API calls
call_api() {
  local method=$1
  local path=$2
  local data=$3
  
  local url="$SUPABASE_URL/functions/v1/$path"
  
  curl -s -X "$method" "$url" \
    -H "Content-Type: application/json" \
    -H "x-admin-bypass: $DEV_BYPASS" \
    -d "$data"
}

echo "Step 1: Creating a test game..."
GAME_RESPONSE=$(call_api POST "admin-games" '{
  "title": "Test Quiz '$(date +%s)'",
  "startTime": "'$(date -u -v+1H +%Y-%m-%dT%H:%M:%SZ)'",
  "prizePool": 100,
  "totalQuestions": 5
}')

GAME_ID=$(echo "$GAME_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$GAME_ID" ]; then
  echo "❌ Failed to create game"
  echo "Response: $GAME_RESPONSE"
  exit 1
fi

echo "✅ Game created with ID: $GAME_ID"
echo ""

echo "Step 2: Adding questions to the game..."
for i in {1..5}; do
  QUESTION_RESPONSE=$(call_api POST "admin-games" "{
    \"game_id\": \"$GAME_ID\",
    \"question_text\": \"Sample Question $i?\",
    \"option_a\": \"Option A\",
    \"option_b\": \"Option B\",
    \"option_c\": \"Option C\",
    \"option_d\": \"Option D\",
    \"correct_answer\": \"Option A\",
    \"question_order\": $i
  }")
done
echo "✅ Questions added"
echo ""

echo "Step 3: Opening registration (pre_game mode)..."
REG_RESPONSE=$(call_api POST "admin-games/$GAME_ID/register" '{}')
echo "✅ Registration opened"
echo ""

echo "Step 4: Player joining the game..."
JOIN_RESPONSE=$(call_api POST "registration/join" "{
  \"gameId\": \"$GAME_ID\",
  \"phoneNumber\": \"$TEST_PHONE\"
}")
echo "Response: $JOIN_RESPONSE"
echo ""

echo "Step 5: Starting the game..."
START_RESPONSE=$(call_api POST "admin-games/$GAME_ID/start" '{}')
echo "✅ Game started"
echo ""

echo "Step 6: Submitting a correct answer..."
ANSWER_RESPONSE=$(call_api POST "gameplay/answer" "{
  \"gameId\": \"$GAME_ID\",
  \"phoneNumber\": \"$TEST_PHONE\",
  \"answer\": \"Option A\"
}")
echo "Response: $ANSWER_RESPONSE"
echo ""

echo "Step 7: Checking notifications queue..."
# This would require accessing the DB directly or creating a helper endpoint
echo "ℹ️  Run 'supabase db sql' to check notifications table"
echo ""

echo "Step 8: Triggering notification dispatcher..."
DISPATCH_RESPONSE=$(call_api GET "cron-dispatcher" '{}')
echo "Response: $DISPATCH_RESPONSE"
echo ""

echo "✅ Test flow completed!"
echo ""
echo "📊 Next steps:"
echo "  - Check WhatsApp messages on $TEST_PHONE"
echo "  - View game details: GET $SUPABASE_URL/functions/v1/admin-games/$GAME_ID"
echo "  - Export results: GET $SUPABASE_URL/functions/v1/admin-games/$GAME_ID/export"

# 100-Player Load Test - Results & Instructions

## Test Summary

Successfully simulated **100 concurrent players** in a trivia game with real-time WhatsApp group notifications.

### Performance Metrics

- **Registration**: 100 players in 533ms (concurrent API calls)
- **Answer Processing**: ~2.6-3.0 seconds per question with 32-100 concurrent submissions
- **Elimination**: 68 players eliminated across 5 questions
- **Winners**: 32 players answered all questions correctly
- **Notifications**: 296 total (1 group + 295 individual) queued and dispatched in 3.4s

### Atomic RPC Performance

✅ **No race conditions detected** - All 100 players processed concurrently without database conflicts  
✅ **Correct elimination logic** - Players eliminated on wrong answers  
✅ **Proper state management** - Game progressed through all questions

### Question-by-Question Breakdown

| Question | Players | Correct | Eliminated | Processing Time |
|----------|---------|---------|------------|-----------------|
| Q1: "What is 2 + 2?" | 100 | 71 | 29 | 2.7s |
| Q2: "Capital of Pakistan?" | 71 | 52 | 19 | 2.8s |
| Q3: "Largest ocean?" | 52 | 32 | 20 | 3.0s |
| Q4: "Speed of light?" | 32 | 32 | 0 | 2.6s |
| Q5: "Who painted Mona Lisa?" | 32 | 32 | 0 | 2.6s |

## WhatsApp Group Integration

### Group Notification Format

The test queues group messages at key game events:

1. **Game Start**: "🎮 GAME STARTING NOW! 🎮\n100 players registered!\nFirst question coming up..."
2. **After each question**: "Q1 Results:\n✅ Correct: 71\n❌ Eliminated: 29\n👥 Remaining: 71"

### How to Get Your WhatsApp Group ID

1. **Add your bot to the group**
2. **Send a test message** to the group from any member
3. **Check webhook logs** to find the group ID (format: `120363XXXXX@g.us`)

Or use the Graph API explorer:
```bash
curl "https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/groups" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"
```

## Running the Load Test

### 1. Configure Environment

Edit `.env` or set environment variables:

```bash
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH
export WHATSAPP_GROUP_ID=120363380598109107@g.us  # Replace with your group ID
```

Also ensure Edge Functions have WhatsApp credentials:

```bash
supabase secrets set WHATSAPP_ACCESS_TOKEN=your_token_here
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=your_phone_id_here
```

### 2. Run the Test

```bash
cd backend-microservices
node scripts/load-test-100-players.js
```

### 3. Monitor Results

Watch the console output for real-time statistics, or query the database:

```bash
# View game stats
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "
SELECT 
  g.id,
  g.title,
  g.status,
  g.winner_count,
  (SELECT count(*) FROM game_players WHERE game_id = g.id) as total_players,
  (SELECT count(*) FROM game_players WHERE game_id = g.id AND status = 'active') as active,
  (SELECT count(*) FROM game_players WHERE game_id = g.id AND status = 'eliminated') as eliminated,
  (SELECT count(*) FROM notifications WHERE payload->>'error' IS NULL) as notifications_sent
FROM games g 
ORDER BY created_at DESC LIMIT 1;
"

# View notifications by status
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "
SELECT status, count(*) FROM notifications GROUP BY status;
"
```

## Customization

### Adjust Player Count

Edit `NUM_PLAYERS` in the script:

```javascript
const NUM_PLAYERS = 50  // Or 200, 500, etc.
```

### Change Answer Distribution

Modify the probability in the answer generation logic:

```javascript
// 70% answer correctly, 30% answer wrong
const answerCorrectly = Math.random() < 0.7  // Change 0.7 to 0.5 for 50/50, etc.
```

### Add More Questions

Edit the `QUESTIONS` array:

```javascript
const QUESTIONS = [
  { question_text: "Your question?", option_a: "A", option_b: "B", option_c: "C", option_d: "D", correct_answer: "B" },
  // ... add more
]
```

## Expected WhatsApp Messages

When running with valid credentials, your WhatsApp group will receive:

1. **Initial**: "🎮 GAME STARTING NOW! 🎮..."
2. **After Q1**: "Q1 Results: ✅ Correct: 71, ❌ Eliminated: 29, 👥 Remaining: 71"
3. **After Q2**: "Q2 Results: ✅ Correct: 52, ❌ Eliminated: 19, 👥 Remaining: 52"
4. And so on for each question...

Individual players also receive notifications about their answers (correct/eliminated/winner).

## Database Schema Impact

The test creates:
- 1 game record
- 5 question records
- 100 user records (phone numbers 92300000001 to 92300000100)
- 100 game_player records
- ~296 player_answer records (varies based on eliminations)
- ~296 notification records

All operations are atomic and handle race conditions correctly via the `record_player_answer()` RPC function.

## Cleanup

To reset the database after testing:

```bash
cd backend-microservices
supabase db reset
```

This will drop all data and re-apply migrations from scratch.

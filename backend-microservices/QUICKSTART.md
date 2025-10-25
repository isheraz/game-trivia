# Quick Start Guide

## Problem: Authentication Errors

If you see `Missing authorization header` errors when testing, you need to configure the dev bypass password.

## Solution

### Option 1: Use Environment Variable (Recommended for Local Dev)

Create `.env` file:
```bash
ADMIN_DEV_PASSWORD=dev123
```

Then restart Supabase functions:
```bash
# Stop current server (Ctrl+C)
supabase functions serve
```

### Option 2: Test Without Admin Auth

For testing non-admin endpoints, you don't need auth:

```bash
# Join game (no auth required)
curl -X POST 'http://127.0.0.1:54321/functions/v1/registration/join' \
  -H 'Content-Type: application/json' \
  -d '{"gameId":"YOUR_GAME_ID","phoneNumber":"923196612416"}'

# Submit answer (no auth required)
curl -X POST 'http://127.0.0.1:54321/functions/v1/gameplay/answer' \
  -H 'Content-Type: application/json' \
  -d '{"gameId":"YOUR_GAME_ID","phoneNumber":"923196612416","answer":"Option A"}'
```

### Option 3: Create Game via Database

Use Supabase Studio or SQL:

```bash
# Open Supabase Studio
supabase db studio

# Or use SQL directly
supabase db sql
```

Then run:
```sql
INSERT INTO games (title, start_time, prize_pool, total_questions, status)
VALUES ('Test Game', now() + interval '1 hour', 100, 5, 'scheduled')
RETURNING *;
```

## Testing Flow Without Admin Endpoints

1. **Create game via SQL** (as shown above)
2. **Add questions via SQL**:
```sql
-- Get your game_id from step 1, then:
SELECT bulk_insert_questions('YOUR_GAME_ID', '[
  {"question_text": "Test Q1?", "option_a": "A", "option_b": "B", "option_c": "C", "option_d": "D", "correct_answer": "A"}
]'::jsonb);
```

3. **Set status to pre_game** (to allow joins):
```sql
UPDATE games SET status = 'pre_game' WHERE id = 'YOUR_GAME_ID';
```

4. **Test JOIN endpoint**:
```bash
curl -X POST 'http://127.0.0.1:54321/functions/v1/registration/join' \
  -H 'Content-Type: application/json' \
  -d '{"gameId":"YOUR_GAME_ID","phoneNumber":"923196612416"}'
```

5. **Start game**:
```sql
UPDATE games SET status = 'in_progress', started_at = now() WHERE id = 'YOUR_GAME_ID';
```

6. **Submit answer**:
```bash
curl -X POST 'http://127.0.0.1:54321/functions/v1/gameplay/answer' \
  -H 'Content-Type: application/json' \
  -d '{"gameId":"YOUR_GAME_ID","phoneNumber":"923196612416","answer":"A"}'
```

7. **Check notifications**:
```sql
SELECT * FROM notifications ORDER BY created_at DESC LIMIT 10;
```

8. **Trigger notification dispatcher**:
```bash
curl 'http://127.0.0.1:54321/functions/v1/cron-dispatcher'
```

## Full Test with Sample Data

The migrations include a test helper. Run this after `supabase db reset`:

```sql
-- This is automatically run by migration 202510251200_test_helpers.sql
-- It creates a game with 5 questions

-- Find the game ID:
SELECT id, title, status FROM games ORDER BY created_at DESC LIMIT 1;
```

Then follow steps 3-8 above using that game ID.

## Troubleshooting

### Functions not picking up secrets
- Restart: `supabase functions serve` (Ctrl+C then restart)
- Check config: `supabase/config.toml` should have `[edge_runtime.secrets]` section
- Verify: Check function logs for environment variable errors

### Database connection issues
- Restart Supabase: `supabase stop && supabase start`
- Reset DB: `supabase db reset` (⚠️ deletes all data)

### WhatsApp messages not sending
- Check secrets are set (see README.md)
- Verify WHATSAPP_ACCESS_TOKEN is valid
- Check notification dispatcher logs
- Verify notification status: `SELECT * FROM notifications WHERE status = 'failed';`

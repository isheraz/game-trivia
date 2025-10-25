# Creating a WhatsApp Group for QRush Trivia Notifications

## Prerequisites

You already have:
- ✅ WhatsApp Access Token: `EAA7ur0x0AtE...`
- ✅ WhatsApp Phone Number ID: `732111529996186`
- ✅ API Version: `v18.0`

## Method 1: Create Group Manually & Get ID via Webhook (Recommended)

### Step 1: Create the Group on WhatsApp

1. **Open WhatsApp** (on your phone or WhatsApp Business app)
2. **Create a new group**:
   - Tap the "New Chat" button
   - Select "New Group"
   - Name it: "QRush Trivia Game" (or any name you prefer)
   - Add at least one participant (yourself or a test contact)
   - Tap "Create"

3. **Add your WhatsApp Business number** to the group:
   - The phone number associated with ID `732111529996186`
   - This is the number your API credentials are linked to

### Step 2: Set Up Webhook to Capture Group ID

First, make sure your webhook endpoint is running and accessible:

```bash
# Option A: Using ngrok for testing (creates public URL)
ngrok http 54321

# This will give you a URL like: https://abc123.ngrok.io
# Your webhook will be: https://abc123.ngrok.io/functions/v1/webhook
```

### Step 3: Register Webhook with WhatsApp

```bash
# Set your webhook URL (replace with your ngrok URL or public domain)
WEBHOOK_URL="https://abc123.ngrok.io/functions/v1/webhook"

# Register the webhook
curl -X POST "https://graph.facebook.com/v18.0/732111529996186/subscribed_apps" \
  -H "Authorization: Bearer EAA7ur0x0AtEBPpPQuLmL2l42FZBnTGzop8KAXER5VXYufu67H68khZCoIWUFwPveIeWiF6GOVXbaZAd5TFlSmNBiAySWg0f2kJzUo2g6c8boMAADfDGdi1EaSU1fZCjcquPm7uNqZColNGUEPHziyryKpeO9FbzjvratZARwXZCDstRnKam8nLX4Se57EpZCovikAS5VDCLQMCbayJXjNlt6SJ0YFlGU17ZCOXAqabxmA" \
  -d "fields=messages"
```

### Step 4: Send a Test Message to the Group

1. **In WhatsApp**, send any message to the group (e.g., "Testing")
2. **Check your webhook logs** to see the incoming message

The webhook payload will contain the group ID in this format:

```json
{
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "120363380598109107@g.us",  // <-- This is your GROUP ID!
          "text": { "body": "Testing" }
        }]
      }
    }]
  }]
}
```

### Step 5: Check Database for Group ID

```bash
# View webhook events in database
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "
SELECT 
  id,
  created_at,
  payload->'entry'->0->'changes'->0->'value'->'messages'->0->>'from' as sender_id,
  payload->'entry'->0->'changes'->0->'value'->'messages'->0->'text'->>'body' as message
FROM webhook_events 
WHERE provider = 'whatsapp'
ORDER BY created_at DESC 
LIMIT 5;
"
```

The `sender_id` ending in `@g.us` is your **Group ID**!

---

## Method 2: List Groups via API (If Available)

**Note**: This requires the `whatsapp_business_management` permission.

```bash
curl "https://graph.facebook.com/v18.0/732111529996186/groups" \
  -H "Authorization: Bearer EAA7ur0x0AtEBPpPQuLmL2l42FZBnTGzop8KAXER5VXYufu67H68khZCoIWUFwPveIeWiF6GOVXbaZAd5TFlSmNBiAySWg0f2kJzUo2g6c8boMAADfDGdi1EaSU1fZCjcquPm7uNqZColNGUEPHziyryKpeO9FbzjvratZARwXZCDstRnKam8nLX4Se57EpZCovikAS5VDCLQMCbayJXjNlt6SJ0YFlGU17ZCOXAqabxmA"
```

**Response (if permission is granted)**:
```json
{
  "data": [
    {
      "id": "120363380598109107@g.us",
      "name": "QRush Trivia Game",
      "participants_count": 5
    }
  ]
}
```

---

## Method 3: Extract from WhatsApp Web

1. **Open WhatsApp Web** (web.whatsapp.com)
2. **Open your group chat**
3. **Open Browser DevTools** (F12 or Right-click → Inspect)
4. **Go to Console tab**
5. **Run this JavaScript**:

```javascript
// Get selected chat
const chat = Store.Chat.get(Store.Chat.getActive());
console.log('Group ID:', chat.id._serialized);
// Output: 120363380598109107@g.us
```

Or check the URL bar:
```
https://web.whatsapp.com/send?phone=120363380598109107@g.us
                                      ^^^^^^^^^^^^^^^^^^^^^ This is the Group ID
```

---

## Verify Group ID Format

Valid WhatsApp Group IDs:
- ✅ Format: `XXXXXXXXXXX@g.us` (always ends with `@g.us`)
- ✅ Example: `120363380598109107@g.us`
- ❌ NOT: Just numbers like `923196612416` (that's an individual)

---

## Testing Group Messages

### 1. Update Environment Variable

```bash
# In backend-microservices/.env
WHATSAPP_GROUP_ID=120363380598109107@g.us  # Replace with your actual group ID
```

Or set it temporarily:

```bash
export WHATSAPP_GROUP_ID="120363380598109107@g.us"
```

### 2. Send Test Message via Script

```bash
cd /Users/sheraz/work/Trivia-game/backend-microservices

# Quick test: Queue and send a group notification
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "
INSERT INTO notifications (to_number, message, status)
VALUES ('120363380598109107@g.us', 
        '🎮 Test notification from QRush Trivia! This is a group message test.', 
        'queued');
"

# Dispatch the notification
curl -X GET 'http://127.0.0.1:54321/functions/v1/cron-dispatcher' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Authorization: Bearer sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
```

### 3. Check WhatsApp Group

You should see the test message in your WhatsApp group within a few seconds!

### 4. Verify in Database

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "
SELECT 
  id,
  to_number,
  LEFT(message, 50) as message_preview,
  status,
  payload->>'whatsapp_message_id' as whatsapp_id,
  payload->>'is_group' as is_group
FROM notifications 
WHERE to_number LIKE '%@g.us'
ORDER BY created_at DESC 
LIMIT 5;
"
```

---

## Running the 100-Player Load Test with Group Notifications

Once you have your Group ID:

```bash
cd /Users/sheraz/work/Trivia-game/backend-microservices

# Set the group ID
export WHATSAPP_GROUP_ID="120363380598109107@g.us"  # Replace with your ID

# Run the load test
node scripts/load-test-100-players.js
```

**Expected Group Messages**:
1. "🎮 GAME STARTING NOW! 🎮\n100 players registered!..."
2. "Q1 Results:\n✅ Correct: 71\n❌ Eliminated: 29\n👥 Remaining: 71"
3. "Q2 Results:..." (and so on for each question)

---

## Troubleshooting

### Issue: "Permission denied" when registering webhook

**Solution**: Your WhatsApp Business account needs webhook permissions. Go to:
- Meta Business Suite → WhatsApp → Settings → Webhook
- Enable webhook subscriptions for "messages"

### Issue: Messages not appearing in group

**Check**:
1. Is your business phone number a member of the group?
2. Is the group ID correct (ends with `@g.us`)?
3. Check notification status in database (should be 'sent', not 'failed')

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "
SELECT status, payload FROM notifications 
WHERE to_number = 'YOUR_GROUP_ID@g.us' 
ORDER BY created_at DESC LIMIT 1;
"
```

### Issue: "Recipient not found" error

**Cause**: The group ID is incorrect or your business number is not in the group.

**Solution**: 
1. Verify group ID format (must end with `@g.us`)
2. Add your business number to the WhatsApp group

---

## Next Steps

After successfully getting your group ID:

1. ✅ Update `.env` with `WHATSAPP_GROUP_ID`
2. ✅ Run a test message to verify
3. ✅ Run the 100-player load test
4. ✅ Monitor your WhatsApp group for real-time game updates!

For more details, see `LOAD_TEST_RESULTS.md`.

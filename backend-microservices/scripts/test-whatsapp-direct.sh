#!/bin/bash
# Direct WhatsApp Graph API test - bypasses all our code to verify credentials

set -euo pipefail

# Resolve repo root relative to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load credentials from project .env if present
if [ -f "$ROOT_DIR/.env" ]; then
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
fi

# Allow overriding via environment or CLI arg: ./test-whatsapp-direct.sh 923124501070
TEST_PHONE_INPUT="${1:-}" 
TEST_PHONE="${TEST_PHONE_INPUT:-${TEST_PHONE:-}}"

# Normalize env vars (strip quotes)
WHATSAPP_ACCESS_TOKEN="${WHATSAPP_ACCESS_TOKEN-}"
WHATSAPP_ACCESS_TOKEN="${WHATSAPP_ACCESS_TOKEN//\"/}"
WHATSAPP_PHONE_NUMBER_ID="${WHATSAPP_PHONE_NUMBER_ID-}"
WHATSAPP_PHONE_NUMBER_ID="${WHATSAPP_PHONE_NUMBER_ID//\"/}"
WHATSAPP_API_VERSION="${WHATSAPP_API_VERSION:-v19.0}"
TEST_PHONE="${TEST_PHONE-}"
TEST_PHONE="${TEST_PHONE//\"/}"

echo "🔍 Testing WhatsApp API Credentials"
echo "===================================="
echo ""
echo "📞 Phone Number ID: $WHATSAPP_PHONE_NUMBER_ID"
echo "📱 Test Recipient: ${TEST_PHONE:-<missing>}"
echo "🌐 API Version: $WHATSAPP_API_VERSION"
echo ""

if [ -z "$WHATSAPP_ACCESS_TOKEN" ] || [ -z "$WHATSAPP_PHONE_NUMBER_ID" ] || [ -z "${TEST_PHONE}" ]; then
  echo "❌ Error: Missing required environment variables"
  echo "   Please ensure WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and TEST_PHONE are set in .env"
  echo "   You can also pass the phone as an argument: ./scripts/test-whatsapp-direct.sh 923124501070"
  exit 1
fi

RECIPIENT="$TEST_PHONE"
# Add + if not already present
# if [[ "$RECIPIENT" != +* ]]; then
#   RECIPIENT="+$RECIPIENT"
# fi

echo "📤 Sending test message to $RECIPIENT..."
echo ""

RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
  "https://graph.facebook.com/$WHATSAPP_API_VERSION/$WHATSAPP_PHONE_NUMBER_ID/messages" \
  -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"messaging_product\": \"whatsapp\",
    \"to\": \"$RECIPIENT\",
    \"type\": \"text\",
    \"text\": {
      \"body\": \"🎮 QRush Test: WhatsApp credentials verified! $(date)\"
    }
  }")

HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo ""
echo "🧾 Raw Response (for debugging):"
echo "$BODY"
echo ""
echo "Response:"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

# New logic to detect 24-hour session rule or policy restrictions
ERROR_MESSAGE=$(echo "$BODY" | jq -r '.error.message // empty' 2>/dev/null || echo "")
ERROR_CODE=$(echo "$BODY" | jq -r '.error.code // empty' 2>/dev/null || echo "")

if [[ "$ERROR_MESSAGE" == *"policy_violation"* ]] || [[ "$ERROR_MESSAGE" == *"message failed to send"* ]] || [[ "$ERROR_MESSAGE" == *"Recipient has not opted in"* ]] || \
   echo "$BODY" | grep -iqE 'policy_violation|message failed to send|Recipient has not opted in'; then
  echo "⚠️ Message likely dropped due to 24-hour session rule or user not opted-in."
  echo "💡 Tip: Send a template message (e.g. 'hello_world') or have the user message your number first."
fi

if [[ "$ERROR_MESSAGE" == *"Invalid OAuth access token"* ]] || [[ "$ERROR_CODE" == "190" ]]; then
  echo "❌ Error: Access token is invalid or expired."
  echo "🔑 Tip: Generate a new access token from Meta Developer Dashboard."
fi

if [ "$HTTP_CODE" = "200" ]; then
  MESSAGE_ID=$(echo "$BODY" | jq -r '.messages[0].id' 2>/dev/null)
  echo "✅ SUCCESS! Message sent successfully"
  echo "📨 Message ID: $MESSAGE_ID"
  echo "📱 Check your WhatsApp on $TEST_PHONE"
else
  echo "❌ FAILED! WhatsApp API returned error"
  ERROR_MESSAGE=$(echo "$BODY" | jq -r '.error.message' 2>/dev/null || echo "Unknown error")
  ERROR_CODE=$(echo "$BODY" | jq -r '.error.code' 2>/dev/null || echo "Unknown")
  echo "   Error Code: $ERROR_CODE"
  echo "   Error Message: $ERROR_MESSAGE"
  echo ""
  echo "Common issues:"
  echo "  - Token expired (WhatsApp tokens expire after 60 days)"
  echo "  - Phone number not verified in Meta Business Manager"
  echo "  - Recipient hasn't messaged your number first (required for some accounts)"
  echo "  - Invalid phone number format (should be E.164: country code + number, no + sign)"
fi

echo "--- Test Completed at $(date) ---"

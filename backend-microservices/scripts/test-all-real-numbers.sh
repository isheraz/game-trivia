#!/bin/bash
# Test sending to all real numbers from REAL_WHATSAPP_NUMBERS

set -e

source .env

WHATSAPP_ACCESS_TOKEN="${WHATSAPP_ACCESS_TOKEN//\"/}"
WHATSAPP_PHONE_NUMBER_ID="${WHATSAPP_PHONE_NUMBER_ID//\"/}"
WHATSAPP_API_VERSION="${WHATSAPP_API_VERSION:-v18.0}"
REAL_NUMBERS="${REAL_WHATSAPP_NUMBERS//\"/}"

IFS=',' read -ra NUMBERS <<< "$REAL_NUMBERS"

echo "🎮 QRush - Testing all real WhatsApp numbers"
echo "============================================="
echo ""

for PHONE in "${NUMBERS[@]}"; do
  PHONE=$(echo "$PHONE" | xargs) # trim whitespace
  echo "📤 Sending to: $PHONE"
  
  RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
    "https://graph.facebook.com/$WHATSAPP_API_VERSION/$WHATSAPP_PHONE_NUMBER_ID/messages" \
    -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"messaging_product\": \"whatsapp\",
      \"to\": \"$PHONE\",
      \"type\": \"text\",
      \"text\": {
        \"body\": \"🎮 QRush Trivia: Your number ($PHONE) is registered for game notifications!\"
      }
    }")
  
  HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
  
  if [ "$HTTP_CODE" = "200" ]; then
    MESSAGE_ID=$(echo "$RESPONSE" | sed '/HTTP_CODE:/d' | jq -r '.messages[0].id' 2>/dev/null)
    echo "   ✅ Sent! Message ID: $MESSAGE_ID"
  else
    ERROR=$(echo "$RESPONSE" | sed '/HTTP_CODE:/d' | jq -r '.error.message' 2>/dev/null || echo "Unknown error")
    echo "   ❌ Failed: $ERROR"
  fi
  echo ""
  sleep 1
done

echo "✅ Test complete! Check all phones for messages."

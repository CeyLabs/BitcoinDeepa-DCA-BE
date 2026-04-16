#!/bin/bash

# BitcoinDeepa Fund Transfer Test Script
# Usage: ./test-fund-transfer.sh <amount_in_sats> <telegram_id> <memo>
# Example: ./test-fund-transfer.sh 3653 7551840633 "Test transfer"

set -e

# Check arguments
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <amount_in_sats> <telegram_id> [memo]"
    echo "Example: $0 3653 7551840633 'Test transfer'"
    exit 1
fi

AMOUNT=$1
TELEGRAM_ID=$2
MEMO="${3:-Test DCA transfer}"

# Load environment variables from .env file
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)
fi

# Check required environment variables
if [ -z "$BITCOINDEEPA_API_URL" ]; then
    echo "Error: BITCOINDEEPA_API_URL not set"
    exit 1
fi

if [ -z "$BITCOINDEEPA_HMAC_SECRET" ]; then
    echo "Error: BITCOINDEEPA_HMAC_SECRET not set"
    exit 1
fi

API_URL="$BITCOINDEEPA_API_URL"
HMAC_SECRET="$BITCOINDEEPA_HMAC_SECRET"
ENDPOINT="/api/v1/send"
HTTP_METHOD="POST"
TIMESTAMP=$(date +%s)

# Build request body
REQUEST_BODY=$(cat <<EOF
{"amount":${AMOUNT},"to":"${TELEGRAM_ID}","memo":"${MEMO}"}
EOF
)

echo "========================================="
echo "BitcoinDeepa Fund Transfer Test"
echo "========================================="
echo "API URL:     ${API_URL}${ENDPOINT}"
echo "Amount:      ${AMOUNT} satoshis"
echo "To User:     ${TELEGRAM_ID}"
echo "Memo:        ${MEMO}"
echo "Timestamp:   ${TIMESTAMP}"
echo "Request Body: ${REQUEST_BODY}"
echo "========================================="

# Generate HMAC signature
# Message format: METHOD + PATH + TIMESTAMP + BODY
MESSAGE="${HTTP_METHOD}${ENDPOINT}${TIMESTAMP}${REQUEST_BODY}"
SIGNATURE=$(echo -n "$MESSAGE" | openssl dgst -sha256 -hmac "$HMAC_SECRET" | sed 's/^.* //')

echo "HMAC Message: ${MESSAGE}"
echo "HMAC Signature: ${SIGNATURE}"
echo "========================================="
echo ""

# Make API request
echo "Sending request..."
echo ""

RESPONSE=$(curl -X POST "${API_URL}${ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "X-HMAC-Signature: ${SIGNATURE}" \
    -H "X-Timestamp: ${TIMESTAMP}" \
    -d "${REQUEST_BODY}" \
    -w "\nHTTP_STATUS_CODE:%{http_code}" \
    -s)

# Extract HTTP status code
HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_STATUS_CODE" | cut -d':' -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS_CODE/d')

echo "========================================="
echo "Response:"
echo "========================================="
echo "HTTP Status: ${HTTP_CODE}"
echo "Body: ${BODY}"
echo "========================================="

# Pretty print JSON if jq is available
if command -v jq &> /dev/null; then
    echo ""
    echo "Formatted Response:"
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
fi

# Check if successful
if [ "$HTTP_CODE" = "200" ]; then
    echo ""
    echo "✅ Transfer successful!"
    exit 0
else
    echo ""
    echo "❌ Transfer failed with status ${HTTP_CODE}"
    exit 1
fi

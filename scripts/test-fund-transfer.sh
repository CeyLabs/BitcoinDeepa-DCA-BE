#!/bin/bash

# BitcoinDeepa Fund Transfer Test Script (Ed25519-signed, see the bot's
# dca-backend-integration.md §3)
# Usage: ./test-fund-transfer.sh <amount_in_sats> <telegram_id> [memo]
# Example: ./test-fund-transfer.sh 3653 7551840633 "Test transfer"
#
# Needs BITCOINDEEPA_API_URL, BITCOINDEEPA_WALLET_ID and the private key, either
# BITCOINDEEPA_SEND_PRIVATE_KEY_FILE (path to the PEM) or
# BITCOINDEEPA_SEND_PRIVATE_KEY_PEM (PEM text, multi-line or with literal \n).
# DRY_RUN=1 prints the signed request without sending it.
# Requires OpenSSL 3+ (pkeyutl -rawin for Ed25519).

set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <amount_in_sats> <telegram_id> [memo]"
    echo "Example: $0 3653 7551840633 'Test transfer'"
    exit 1
fi

AMOUNT=$1
TELEGRAM_ID=$2
MEMO="${3:-Test DCA transfer}"

# Load .env (set -a keeps quoted multi-line values intact)
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

: "${BITCOINDEEPA_API_URL:?BITCOINDEEPA_API_URL not set}"
: "${BITCOINDEEPA_WALLET_ID:?BITCOINDEEPA_WALLET_ID not set}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

KEY_FILE="${BITCOINDEEPA_SEND_PRIVATE_KEY_FILE:-}"
if [ -z "$KEY_FILE" ]; then
    : "${BITCOINDEEPA_SEND_PRIVATE_KEY_PEM:?Set BITCOINDEEPA_SEND_PRIVATE_KEY_FILE or BITCOINDEEPA_SEND_PRIVATE_KEY_PEM}"
    KEY_FILE="$TMP_DIR/key.pem"
    printf '%b\n' "${BITCOINDEEPA_SEND_PRIVATE_KEY_PEM}" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
fi

ENDPOINT="/api/v1/send"
METHOD="POST"
TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)

# Serialize once: these exact bytes are hashed, signed and sent
REQUEST_BODY=$(printf '{"amount":%s,"to":"%s","memo":"%s"}' "$AMOUNT" "$TELEGRAM_ID" "$MEMO")
BODY_HASH=$(printf '%s' "$REQUEST_BODY" | openssl dgst -sha256 -r | cut -d' ' -f1)

# BDB-SEND-ED25519-V1 \n METHOD \n PATH \n QUERY (empty) \n TS \n NONCE \n sha256hex(body)
printf 'BDB-SEND-ED25519-V1\n%s\n%s\n\n%s\n%s\n%s' \
    "$METHOD" "$ENDPOINT" "$TIMESTAMP" "$NONCE" "$BODY_HASH" > "$TMP_DIR/message"
SIGNATURE=$(openssl pkeyutl -sign -inkey "$KEY_FILE" -rawin -in "$TMP_DIR/message" | openssl base64 -A)

echo "========================================="
echo "BitcoinDeepa Fund Transfer Test"
echo "========================================="
echo "API URL:      ${BITCOINDEEPA_API_URL}${ENDPOINT}"
echo "Wallet ID:    ${BITCOINDEEPA_WALLET_ID}"
echo "Amount:       ${AMOUNT} satoshis"
echo "To User:      ${TELEGRAM_ID}"
echo "Memo:         ${MEMO}"
echo "Timestamp:    ${TIMESTAMP}"
echo "Nonce:        ${NONCE}"
echo "Request Body: ${REQUEST_BODY}"
echo "Signature:    ${SIGNATURE}"
echo "========================================="

if [ "${DRY_RUN:-}" = "1" ]; then
    echo "DRY_RUN=1: not sent"
    exit 0
fi

echo "Sending request..."
RESPONSE=$(curl -s -X POST "${BITCOINDEEPA_API_URL}${ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "X-Wallet-ID: ${BITCOINDEEPA_WALLET_ID}" \
    -H "X-Timestamp: ${TIMESTAMP}" \
    -H "X-Nonce: ${NONCE}" \
    -H "X-Signature: ${SIGNATURE}" \
    --data-binary "${REQUEST_BODY}" \
    --max-time 100 \
    -w "\nHTTP_STATUS_CODE:%{http_code}")

HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_STATUS_CODE" | cut -d':' -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS_CODE/d')

echo "========================================="
echo "HTTP Status: ${HTTP_CODE}"
if command -v jq &> /dev/null; then
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
else
    echo "$BODY"
fi
echo "========================================="

case "$HTTP_CODE" in
    200) echo "✅ Transfer successful"; exit 0 ;;
    202) echo "⏳ Accepted, not done yet (awaiting approval or invoice routing)"; exit 0 ;;
    *)   echo "❌ Transfer failed with status ${HTTP_CODE}"; exit 1 ;;
esac

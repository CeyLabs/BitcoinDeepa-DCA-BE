#!/bin/bash

# BitcoinDeepa Fund Transfer Test Script (Ed25519-signed, see the bot's
# dca-backend-integration.md §3). This MOVES SATS from the DCA wallet.
# Usage: ./scripts/test-fund-transfer.sh <amount_in_sats> <telegram_id> [memo]
# Example: ./scripts/test-fund-transfer.sh 3653 7551840633 "Test transfer"
#
# The memo is the bot's idempotency key: the same memo is only paid once, so
# the default memo carries a timestamp. Pass your own to test a retry.
#
# Needs BITCOINDEEPA_API_URL, BITCOINDEEPA_WALLET_ID and the private key, either
# BITCOINDEEPA_SEND_PRIVATE_KEY_FILE (path to the PEM) or
# BITCOINDEEPA_SEND_PRIVATE_KEY_PEM (PEM text, multi-line or with literal \n).
# They are read from ENV_FILE (default .env), e.g. ENV_FILE=.env.dev for staging.
# DRY_RUN=1 prints the signed request without sending it.
# Requires OpenSSL 3+ (pkeyutl -rawin for Ed25519). macOS ships LibreSSL, which
# can't do it: Homebrew's openssl@3 is picked up automatically, or set OPENSSL.

set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <amount_in_sats> <telegram_id> [memo]"
    echo "Example: ENV_FILE=.env.dev $0 3653 7551840633 'Test transfer'"
    exit 1
fi

AMOUNT=$1
TELEGRAM_ID=$2
MEMO="${3:-Test DCA transfer $(date +%Y%m%d-%H%M%S)}"

if ! [[ "$AMOUNT" =~ ^[1-9][0-9]*$ ]]; then
    echo "amount must be a whole number of sats above 0, got: ${AMOUNT}"
    exit 1
fi
if ! [[ "$TELEGRAM_ID" =~ ^[0-9]+$ ]]; then
    echo "telegram_id must be a number, got: ${TELEGRAM_ID}"
    exit 1
fi
# The memo goes into the JSON as is, so keep it to characters that need no escaping
if [[ "$MEMO" == *'"'* || "$MEMO" == *"\\"* || "$MEMO" == *[[:cntrl:]]* ]]; then
    echo 'memo must not contain ", \ or control characters'
    exit 1
fi

# Pick an OpenSSL that can sign Ed25519 (not the system LibreSSL on macOS)
OPENSSL="${OPENSSL:-openssl}"
if "$OPENSSL" version 2>/dev/null | grep -qi libressl; then
    for candidate in /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
        if [ -x "$candidate" ]; then
            OPENSSL="$candidate"
            break
        fi
    done
fi
if "$OPENSSL" version 2>/dev/null | grep -qi libressl || ! command -v "$OPENSSL" > /dev/null; then
    echo "OpenSSL 3+ is required (found: $("$OPENSSL" version 2>/dev/null || echo none))."
    echo "Install it (brew install openssl@3) or set OPENSSL=/path/to/openssl"
    exit 1
fi
readonly OPENSSL

# Load the env file (set -a keeps quoted multi-line values intact)
ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    case "$ENV_FILE" in
        */*) . "$ENV_FILE" ;;
        *)   . "./$ENV_FILE" ;;
    esac
    set +a
elif [ "$ENV_FILE" != ".env" ]; then
    echo "ENV_FILE not found: ${ENV_FILE}"
    exit 1
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
NONCE=$("$OPENSSL" rand -hex 16)

# Serialize once: these exact bytes are hashed, signed and sent
# (same shape as BitcoinDeepaService.sendFunds: amount, to, memo)
REQUEST_BODY=$(printf '{"amount":%s,"to":"%s","memo":"%s"}' "$AMOUNT" "$TELEGRAM_ID" "$MEMO")
BODY_HASH=$(printf '%s' "$REQUEST_BODY" | "$OPENSSL" dgst -sha256 -r | cut -d' ' -f1)

# BDB-SEND-ED25519-V1 \n METHOD \n PATH \n QUERY (empty) \n TS \n NONCE \n sha256hex(body)
printf 'BDB-SEND-ED25519-V1\n%s\n%s\n\n%s\n%s\n%s' \
    "$METHOD" "$ENDPOINT" "$TIMESTAMP" "$NONCE" "$BODY_HASH" > "$TMP_DIR/message"
SIGNATURE=$("$OPENSSL" pkeyutl -sign -inkey "$KEY_FILE" -rawin -in "$TMP_DIR/message" | "$OPENSSL" base64 -A)

echo "========================================="
echo "BitcoinDeepa Fund Transfer Test"
echo "========================================="
echo "Env file:     ${ENV_FILE}"
echo "API URL:      ${BITCOINDEEPA_API_URL}${ENDPOINT}"
echo "Wallet ID:    ${BITCOINDEEPA_WALLET_ID}"
echo "Amount:       ${AMOUNT} satoshis"
echo "To User:      ${TELEGRAM_ID}"
echo "Memo:         ${MEMO}"
echo "Timestamp:    ${TIMESTAMP}"
echo "Nonce:        ${NONCE}"
echo "Request Body: ${REQUEST_BODY}"
echo "Body SHA-256: ${BODY_HASH}"
echo "Signature:    ${SIGNATURE}"
echo "========================================="

if [ "${DRY_RUN:-}" = "1" ]; then
    echo "DRY_RUN=1: not sent"
    exit 0
fi

echo "Sending request..."
# Headers and body go to files so the whole response can be printed untouched
CURL_STATUS=0
CURL_META=$(curl -sS -X POST "${BITCOINDEEPA_API_URL}${ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "X-Wallet-ID: ${BITCOINDEEPA_WALLET_ID}" \
    -H "X-Timestamp: ${TIMESTAMP}" \
    -H "X-Nonce: ${NONCE}" \
    -H "X-Signature: ${SIGNATURE}" \
    --data-binary "${REQUEST_BODY}" \
    --max-time 100 \
    -D "$TMP_DIR/headers" \
    -o "$TMP_DIR/body" \
    -w '%{http_code} %{time_total} %{size_download}') || CURL_STATUS=$?

if [ "$CURL_STATUS" -ne 0 ] && [ ! -s "$TMP_DIR/headers" ]; then
    echo "❌ Request failed (curl exit ${CURL_STATUS}, no response from ${BITCOINDEEPA_API_URL})"
    echo "   On a timeout the transfer may still have gone through. Retry with the SAME memo: \"${MEMO}\""
    exit 1
fi

read -r HTTP_CODE TIME_TOTAL SIZE_DOWNLOAD <<< "$CURL_META"

echo "========================================="
echo "Response (HTTP ${HTTP_CODE}, ${TIME_TOTAL}s, ${SIZE_DOWNLOAD} bytes)"
echo "----- headers -----"
tr -d '\r' < "$TMP_DIR/headers" | sed '/^$/d'
echo "----- body (raw) -----"
if [ -s "$TMP_DIR/body" ]; then
    cat "$TMP_DIR/body"
    echo
else
    echo "(empty)"
fi
if command -v jq &> /dev/null && jq -e . "$TMP_DIR/body" > /dev/null 2>&1; then
    echo "----- body (JSON) -----"
    jq '.' "$TMP_DIR/body"
fi
echo "========================================="
if [ "$CURL_STATUS" -ne 0 ]; then
    echo "❌ Response was cut short (curl exit ${CURL_STATUS}): outcome unknown, retry with the SAME memo"
    exit 1
fi

case "$HTTP_CODE" in
    200)     echo "✅ Transfer successful"; exit 0 ;;
    202)     echo "⏳ Accepted, not done yet (awaiting approval or invoice routing)"; exit 0 ;;
    401|403) echo "❌ Rejected (${HTTP_CODE}): check the key, wallet id, clock or IP allowlist"; exit 1 ;;
    5??)     echo "❓ Status ${HTTP_CODE}: outcome unknown, the transfer may have gone through. Retry with the SAME memo"; exit 1 ;;
    *)       echo "❌ Transfer failed with status ${HTTP_CODE}"; exit 1 ;;
esac

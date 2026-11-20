#!/bin/bash

# BitcoinDeepa P2P API Test Script (Ed25519-signed, the same calls as
# P2pService / P2pBotClient: the bot's /api/v1/p2p, docs/p2p-api.md and
# dca-backend-integration.md §5-6).
#
# Usage:
#   ./scripts/test-p2p.sh me      <telegram_id>
#   ./scripts/test-p2p.sh send    <telegram_id> <to_telegram_id> <amount_sats> [memo] [idempotency_key]
#   ./scripts/test-p2p.sh get     <telegram_id> <transfer_id>
#   ./scripts/test-p2p.sh watch   <telegram_id> <transfer_id>   # poll every 3s until final
#   ./scripts/test-p2p.sh approve <telegram_id> <collect_id>
# Example:
#   ENV_FILE=.env.dev ./scripts/test-p2p.sh send 7551840633 1234567890 1000 "P2P test"
#
# <telegram_id> is the numeric Telegram ID of the user the call is made for. It
# goes in the X-BDB-User header and on the seventh line of the signed text
# (BDB-P2P-ED25519-V2), and the two must match exactly. The user must have
# logged in through /api/v1/init, else 403 login_required.
#
# `send` and `approve` MOVE SATS out of that REAL user's own bot wallet: `send`
# to <to_telegram_id>, `approve` to whoever made the collect request (see
# test-collect.sh). Above the bot's daily confirm threshold a send answers 202
# awaiting_confirmation and the user confirms in the bot chat.
# idempotency_key defaults to a new UUID: a new one for each payment, the same
# one on a retry (the bot returns the original transfer). Pass "" as the memo
# to send none.
#
# Needs BITCOINDEEPA_API_URL and the bot private key (the same key as the send
# API; its public key is the bot's api.p2p.service_public_key), either
# BITCOINDEEPA_PRIVATE_KEY_FILE (path to the PEM) or
# BITCOINDEEPA_PRIVATE_KEY_PEM (PEM text, multi-line or with literal \n).
# No X-Wallet-ID on this API.
# They are read from ENV_FILE (default .env), e.g. ENV_FILE=.env.dev for staging.
# DRY_RUN=1 prints the signed request without sending it.
# Requires OpenSSL 3+ (pkeyutl -rawin for Ed25519). macOS ships LibreSSL, which
# can't do it: Homebrew's openssl@3 is picked up automatically, or set OPENSSL.

set -euo pipefail

usage() {
    echo "Usage: $0 me      <telegram_id>"
    echo "       $0 send    <telegram_id> <to_telegram_id> <amount_sats> [memo] [idempotency_key]"
    echo "       $0 get     <telegram_id> <transfer_id>"
    echo "       $0 watch   <telegram_id> <transfer_id>"
    echo "       $0 approve <telegram_id> <collect_id>"
    echo "Example: ENV_FILE=.env.dev $0 send 7551840633 1234567890 1000 \"P2P test\""
    exit 1
}

[ "$#" -ge 2 ] || usage
ACTION=$1
USER_ID=$2
shift 2

json_escape() {
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    printf '%s' "$s"
}

# Signed and sent as X-BDB-User, so it has to be the plain numeric ID
if ! [[ "$USER_ID" =~ ^[1-9][0-9]*$ ]]; then
    echo "telegram_id must be a numeric Telegram ID, got: ${USER_ID}"
    exit 1
fi

BASE_ENDPOINT="/api/v1/p2p"
MAX_TIME=30

case "$ACTION" in
    me)
        METHOD="GET"
        ENDPOINT="${BASE_ENDPOINT}/me"
        REQUEST_BODY=''
        ;;
    send)
        [ "$#" -ge 2 ] || usage
        TO_ID=$1
        AMOUNT=$2
        MEMO=${3-"P2P API test"}
        IDEMPOTENCY_KEY=${4:-}

        # No leading zeros: both go into the JSON body as numbers
        if ! [[ "$TO_ID" =~ ^[1-9][0-9]*$ ]]; then
            echo "to_telegram_id must be a numeric Telegram ID, got: ${TO_ID}"
            exit 1
        fi
        if ! [[ "$AMOUNT" =~ ^[1-9][0-9]*$ ]]; then
            echo "amount_sats must be a whole number above 0, got: ${AMOUNT}"
            exit 1
        fi
        if [[ "$MEMO" =~ [[:cntrl:]] ]] || [ "${#MEMO}" -gt 280 ]; then
            echo "memo must be at most 280 characters, with no control characters or newlines"
            exit 1
        fi
        if [ -z "$IDEMPOTENCY_KEY" ]; then
            if command -v uuidgen > /dev/null; then
                IDEMPOTENCY_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')
            else
                IDEMPOTENCY_KEY="test-$(date +%s)-$RANDOM$RANDOM"
            fi
        fi
        if ! [[ "$IDEMPOTENCY_KEY" =~ ^[A-Za-z0-9._:-]{8,128}$ ]]; then
            echo "idempotency_key must be 8-128 characters of [A-Za-z0-9._:-], got: ${IDEMPOTENCY_KEY}"
            exit 1
        fi

        METHOD="POST"
        ENDPOINT="${BASE_ENDPOINT}/send"
        # Same fields and order as P2pService.send (the bot rejects unknown
        # fields); memo is left out when empty
        MEMO_JSON=""
        if [ -n "$MEMO" ]; then
            MEMO_JSON=$(printf '"memo":"%s",' "$(json_escape "$MEMO")")
        fi
        REQUEST_BODY=$(printf '{"to_telegram_id":%s,"amount":%s,%s"idempotency_key":"%s"}' \
            "$TO_ID" "$AMOUNT" "$MEMO_JSON" "$IDEMPOTENCY_KEY")
        # Internal sends run inside the request (the backend waits 60s)
        MAX_TIME=65
        ;;
    get|watch)
        [ "$#" -ge 1 ] || usage
        TRANSFER_ID=$1
        if ! [[ "$TRANSFER_ID" =~ ^p2p-[0-9a-f]{1,60}$ ]]; then
            echo "transfer_id looks wrong (expected p2p-<hex>), got: ${TRANSFER_ID}"
            exit 1
        fi
        METHOD="GET"
        ENDPOINT="${BASE_ENDPOINT}/transfers/${TRANSFER_ID}"
        REQUEST_BODY=''
        ;;
    approve)
        [ "$#" -ge 1 ] || usage
        COLLECT_ID=$1
        if ! [[ "$COLLECT_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
            echo "collect_id looks wrong (expected col-...), got: ${COLLECT_ID}"
            exit 1
        fi
        METHOD="POST"
        ENDPOINT="${BASE_ENDPOINT}/collect/${COLLECT_ID}/approve"
        REQUEST_BODY='{}'
        MAX_TIME=65
        ;;
    *)
        usage
        ;;
esac

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

if [ "$ACTION" = "watch" ] && ! command -v jq > /dev/null; then
    echo "watch needs jq (brew install jq)"
    exit 1
fi

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

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

KEY_FILE="${BITCOINDEEPA_PRIVATE_KEY_FILE:-}"
if [ -z "$KEY_FILE" ]; then
    : "${BITCOINDEEPA_PRIVATE_KEY_PEM:?Set BITCOINDEEPA_PRIVATE_KEY_FILE or BITCOINDEEPA_PRIVATE_KEY_PEM}"
    KEY_FILE="$TMP_DIR/key.pem"
    printf '%b\n' "${BITCOINDEEPA_PRIVATE_KEY_PEM}" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
fi

# Sign the request: every call gets a new timestamp and nonce (the bot rejects
# a reused nonce). The exact body bytes are hashed, signed and sent (8 lines):
#   BDB-P2P-ED25519-V2 \n METHOD \n PATH \n QUERY (empty) \n TS \n NONCE \n TELEGRAM ID \n sha256hex(body)
sign_request() {
    TIMESTAMP=$(date +%s)
    NONCE=$("$OPENSSL" rand -hex 16)
    BODY_HASH=$(printf '%s' "$REQUEST_BODY" | "$OPENSSL" dgst -sha256 -r | cut -d' ' -f1)
    printf 'BDB-P2P-ED25519-V2\n%s\n%s\n\n%s\n%s\n%s\n%s' \
        "$METHOD" "$ENDPOINT" "$TIMESTAMP" "$NONCE" "$USER_ID" "$BODY_HASH" > "$TMP_DIR/message"
    SIGNATURE=$("$OPENSSL" pkeyutl -sign -inkey "$KEY_FILE" -rawin -in "$TMP_DIR/message" | "$OPENSSL" base64 -A)
}

# A spend with no (full) answer may still have gone through
retry_hint() {
    case "$ACTION" in
        send)
            echo "   Outcome unknown: it may have gone through. Retrying with the SAME idempotency_key is safe:"
            echo "   $0 send ${USER_ID} ${TO_ID} ${AMOUNT} \"${MEMO}\" ${IDEMPOTENCY_KEY}"
            ;;
        approve)
            echo "   Outcome unknown: it may have gone through. Approving again returns the same transfer"
            ;;
    esac
}

# Sends the signed request. Headers and body go to files so the whole response
# can be printed untouched. Sets HTTP_CODE, TIME_TOTAL, SIZE_DOWNLOAD.
send_request() {
    local curl_status=0 curl_meta
    # X-BDB-User must equal the seventh line of the signed text
    local -a args=(-sS -X "$METHOD" "${BITCOINDEEPA_API_URL}${ENDPOINT}"
        -H "Content-Type: application/json"
        -H "X-BDB-User: ${USER_ID}"
        -H "X-Timestamp: ${TIMESTAMP}"
        -H "X-Nonce: ${NONCE}"
        -H "X-Signature: ${SIGNATURE}"
        --max-time "$MAX_TIME"
        -D "$TMP_DIR/headers"
        -o "$TMP_DIR/body"
        -w '%{http_code} %{time_total} %{size_download}')
    if [ -n "$REQUEST_BODY" ]; then
        args+=(--data-binary "$REQUEST_BODY")
    fi
    : > "$TMP_DIR/headers"
    : > "$TMP_DIR/body"
    curl_meta=$(curl "${args[@]}") || curl_status=$?

    if [ "$curl_status" -ne 0 ] && [ ! -s "$TMP_DIR/headers" ]; then
        echo "❌ Request failed (curl exit ${curl_status}, no response from ${BITCOINDEEPA_API_URL})"
        retry_hint
        exit 1
    fi
    read -r HTTP_CODE TIME_TOTAL SIZE_DOWNLOAD <<< "$curl_meta"
    if [ "$curl_status" -ne 0 ]; then
        echo "❌ Response was cut short (curl exit ${curl_status}, HTTP ${HTTP_CODE})"
        retry_hint
        exit 1
    fi
}

# A JSON object (a plain-text "Access denied" is not)
body_is_json() {
    command -v jq > /dev/null && jq -e 'type == "object"' "$TMP_DIR/body" > /dev/null 2>&1
}

# One line about the transfer in the response body
summary() {
    jq -r '"id=\(.id // "?") status=\(.status // "?")"
        + (if .amount != null then " amount=\(.amount)" else "" end)
        + (if .confirm_by then " confirm_by=\(.confirm_by)" else "" end)
        + (if .error then " error=\(.error)" else "" end)' "$TMP_DIR/body"
}

# 0 while the transfer can still change, 1 once final
still_open() {
    jq -e '.status | IN("awaiting_confirmation", "processing", "in_flight")' "$TMP_DIR/body" > /dev/null
}

sign_request

echo "========================================="
echo "BitcoinDeepa P2P Test: ${ACTION}"
echo "========================================="
echo "Env file:     ${ENV_FILE}"
echo "API URL:      ${METHOD} ${BITCOINDEEPA_API_URL}${ENDPOINT}"
echo "X-BDB-User:   ${USER_ID}"
case "$ACTION" in
    send)
        echo "To User:      ${TO_ID}"
        echo "Amount:       ${AMOUNT} sats"
        echo "Memo:         ${MEMO:-(none)}"
        echo "Idempotency:  ${IDEMPOTENCY_KEY}"
        ;;
    get|watch) echo "Transfer ID:  ${TRANSFER_ID}" ;;
    approve)   echo "Collect ID:   ${COLLECT_ID}" ;;
esac
echo "Timestamp:    ${TIMESTAMP}"
echo "Nonce:        ${NONCE}"
echo "Request Body: ${REQUEST_BODY:-(empty)}"
echo "Body SHA-256: ${BODY_HASH}"
echo "Signature:    ${SIGNATURE}"
echo "========================================="

if [ "${DRY_RUN:-}" = "1" ]; then
    echo "DRY_RUN=1: not sent"
    exit 0
fi

echo "Sending request..."
send_request

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
HAS_JSON=0
if body_is_json; then
    HAS_JSON=1
    echo "----- body (JSON) -----"
    jq '.' "$TMP_DIR/body"
fi
echo "========================================="

case "$HTTP_CODE" in
    200|201|202) ;;
    5??)
        echo "❓ ${ACTION} got status ${HTTP_CODE}"
        retry_hint
        exit 1
        ;;
    *)
        CODE=""
        if [ "$HAS_JSON" = "1" ]; then
            CODE=$(jq -r '.code // empty' "$TMP_DIR/body")
        fi
        # The same readings as P2pService.mapResponse
        case "${HTTP_CODE}:${CODE}" in
            403:login_required)         HINT="the user is not linked on the bot: they must log in through /api/v1/init" ;;
            401:bad_service_signature)  HINT="the key is not the bot's api.p2p.service_public_key (or the clock is off)" ;;
            401:*)                      HINT="X-BDB-User or the signature was refused: check the key and the clock" ;;
            403:forbidden)              HINT="the bot refused this service: check the key and the IP allowlist" ;;
            403:)                       HINT="plain 403: the IP allowlist" ;;
            *:recipient_not_found)      HINT="the recipient has no bot wallet" ;;
            *:rate_limited)             HINT="too many sends: wait a minute" ;;
            *:request_closed)           HINT="already answered, cancelled or expired" ;;
            *:not_found)                HINT="nothing with this id for this user" ;;
            *)                          HINT="" ;;
        esac
        echo "❌ ${ACTION} failed with status ${HTTP_CODE}${CODE:+ (${CODE})}${HINT:+: ${HINT}}"
        exit 1
        ;;
esac

if [ "$HAS_JSON" != "1" ]; then
    echo "✅ ${ACTION} ok (HTTP ${HTTP_CODE})"
    exit 0
fi

case "$ACTION" in
    me)
        echo "✅ $(jq -c '.' "$TMP_DIR/body")"
        ;;
    send|approve)
        STATUS=$(jq -r '.status // empty' "$TMP_DIR/body")
        NEW_ID=$(jq -r '.id // empty' "$TMP_DIR/body")
        case "$STATUS" in
            completed) echo "✅ Completed: $(summary)" ;;
            awaiting_confirmation)
                echo "⏳ The user must confirm in the bot chat: $(summary)"
                ;;
            processing|in_flight) echo "⏳ Not done yet: $(summary)" ;;
            *)
                echo "❌ Not sent: $(summary)"
                exit 1
                ;;
        esac
        if [ "$STATUS" != "completed" ] && [[ "$NEW_ID" =~ ^p2p-[0-9a-f]+$ ]]; then
            echo "   Watch: $0 watch ${USER_ID} ${NEW_ID}"
        fi
        ;;
    get)
        echo "✅ $(summary)"
        ;;
    watch)
        echo "$(date +%H:%M:%S) $(summary)"
        while still_open; do
            sleep 3
            sign_request
            send_request
            if [ "$HTTP_CODE" != "200" ] || ! body_is_json; then
                echo "❌ Poll failed with status ${HTTP_CODE}"
                cat "$TMP_DIR/body"
                echo
                exit 1
            fi
            echo "$(date +%H:%M:%S) $(summary)"
        done
        echo "========================================="
        jq '.' "$TMP_DIR/body"
        FINAL=$(jq -r '.status // "none"' "$TMP_DIR/body")
        if [ "$FINAL" = "completed" ]; then
            echo "✅ Completed"
        else
            echo "❌ Final without payment: status ${FINAL}"
            exit 1
        fi
        ;;
esac

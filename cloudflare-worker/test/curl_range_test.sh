#!/usr/bin/env bash
# ==============================================================================
# Telegram-Stremio Cloudflare Worker Range & Seeking Automated Test Suite
# ==============================================================================

set -euo pipefail

URL="${1:-}"

if [ -z "$URL" ]; then
  echo "Usage: $0 <SIGNED_STREAM_URL>"
  echo "Example: $0 'https://your-worker.workers.dev/dl/tok/fid/video.mkv?e=123&s=abc'"
  exit 1
fi

echo "======================================================================"
echo "Starting HTTP Byte-Range Test Suite against: $URL"
echo "======================================================================"

PASSED=0
FAILED=0

assert_test() {
  local name="$1"
  local expected_status="$2"
  local expected_cr_prefix="$3"
  local expected_bytes="$4"
  local range_header="$5"

  echo -n "Running: $name ... "

  local headers_file
  headers_file=$(mktemp)
  local body_file
  body_file=$(mktemp)

  if [ -n "$range_header" ]; then
    curl -s -S -D "$headers_file" -H "Range: $range_header" "$URL" -o "$body_file" || true
  else
    # Full request: fetch head or limit body
    curl -s -S -D "$headers_file" -I "$URL" -o /dev/null || true
  fi

  local status
  status=$(grep -i "HTTP/" "$headers_file" | tail -n 1 | awk '{print $2}')
  local actual_bytes
  actual_bytes=$(wc -c < "$body_file" 2>/dev/null || echo "0")

  local status_ok=true
  if [ "$status" != "$expected_status" ]; then
    status_ok=false
  fi

  local cr_ok=true
  if [ -n "$expected_cr_prefix" ]; then
    if ! grep -qi "Content-Range: bytes $expected_cr_prefix" "$headers_file"; then
      cr_ok=false
    fi
  fi

  local bytes_ok=true
  if [ "$expected_bytes" -ge 0 ]; then
    if [ "$actual_bytes" -ne "$expected_bytes" ]; then
      bytes_ok=false
    fi
  fi

  if [ "$status_ok" = true ] && [ "$cr_ok" = true ] && [ "$bytes_ok" = true ]; then
    echo "PASS (HTTP $status, Bytes: $actual_bytes)"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL (Expected HTTP $expected_status got $status; Expected $expected_bytes bytes got $actual_bytes)"
    cat "$headers_file"
    FAILED=$((FAILED + 1))
  fi

  rm -f "$headers_file" "$body_file"
}

# 1. Full request metadata
assert_test "FULL REQUEST (HEAD)" "200" "" "-1" ""

# 2. First 1 MiB (0-1048575)
assert_test "FIRST 1 MiB" "206" "0-1048575" "1048576" "bytes=0-1048575"

# 3. Middle 1 MiB (1073741824-1074790399)
assert_test "MIDDLE 1 MiB" "206" "1073741824-1074790399" "1048576" "bytes=1073741824-1074790399"

# 4. Open-ended seek
assert_test "OPEN-ENDED" "206" "1073741824-" "-1" "bytes=1073741824-"

# 5. Suffix range (last 1 MiB)
assert_test "SUFFIX RANGE" "206" "" "1048576" "bytes=-1048576"

# 6. Invalid out-of-bounds range
assert_test "INVALID RANGE (416)" "416" "*/" "0" "bytes=999999999999999-"

echo "======================================================================"
echo "Range Test Suite Complete: $PASSED passed, $FAILED failed"
echo "======================================================================"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

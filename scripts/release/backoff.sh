#!/usr/bin/env bash

# Reusable bounded backoff helper for release control workflows.

sl_backoff_sleep() {
  local context="${1:-generic}"
  local attempt_raw="${2:-1}"
  local attempt=1
  if [[ "${attempt_raw}" =~ ^[0-9]+$ ]] && (( attempt_raw > 0 )); then
    attempt="${attempt_raw}"
  fi
  local exponent="${attempt}"
  if (( exponent > 5 )); then
    exponent=5
  fi
  local base_ms=$((500 * (2 ** exponent)))
  local seed="${context}:${attempt}:${GITHUB_RUN_ID:-0}:${GITHUB_RUN_ATTEMPT:-0}"
  local seed_hash
  seed_hash="$(printf "%s" "${seed}" | sha256sum | awk '{print $1}')"
  local jitter_bucket=$((16#${seed_hash:0:4} % 1000))
  local delay_ms=$((base_ms + jitter_bucket))
  if (( delay_ms > 20000 )); then
    delay_ms=20000
  fi
  local delay_seconds
  delay_seconds="$(awk -v ms="${delay_ms}" 'BEGIN { printf "%.3f", ms / 1000 }')"
  echo "Backoff[${context}] attempt=${attempt} sleep=${delay_seconds}s"
  sleep "${delay_seconds}"
}

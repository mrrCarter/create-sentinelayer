#!/usr/bin/env bash

gh_api_json() {
  if [[ $# -lt 1 ]]; then
    echo "::error::gh_api_json requires an API endpoint argument." >&2
    return 2
  fi
  local endpoint="${1}"
  shift

  local timeout_seconds="${GH_API_TIMEOUT_SECONDS:-30}"
  local max_attempts="${GH_API_MAX_ATTEMPTS:-3}"
  local backoff_seconds="${GH_API_BACKOFF_SECONDS:-2}"

  case "${timeout_seconds}" in ''|*[!0-9]*) echo "::error::Invalid GH_API_TIMEOUT_SECONDS='${timeout_seconds}'." >&2; return 2 ;; esac
  case "${max_attempts}" in ''|*[!0-9]*) echo "::error::Invalid GH_API_MAX_ATTEMPTS='${max_attempts}'." >&2; return 2 ;; esac
  case "${backoff_seconds}" in ''|*[!0-9]*) echo "::error::Invalid GH_API_BACKOFF_SECONDS='${backoff_seconds}'." >&2; return 2 ;; esac
  if [[ "${max_attempts}" -lt 1 ]]; then
    echo "::error::GH_API_MAX_ATTEMPTS must be >= 1." >&2
    return 2
  fi
  if [[ "${timeout_seconds}" -lt 1 ]]; then
    echo "::error::GH_API_TIMEOUT_SECONDS must be >= 1." >&2
    return 2
  fi

  local attempt=1
  local status=0
  local output=""
  local error_file
  error_file="$(mktemp)"

  while [[ "${attempt}" -le "${max_attempts}" ]]; do
    if output="$(timeout --preserve-status "${timeout_seconds}s" gh api "${endpoint}" -H "Accept: application/vnd.github+json" "$@" 2>"${error_file}")"; then
      rm -f "${error_file}"
      printf '%s' "${output}"
      return 0
    fi
    status=$?
    local error_preview
    error_preview="$(tr '\n' ' ' < "${error_file}" | sed -E 's/[[:space:]]+/ /g' | cut -c1-400)"
    if [[ "${attempt}" -ge "${max_attempts}" ]]; then
      echo "::error::gh api '${endpoint}' failed after ${max_attempts} attempt(s) (exit=${status}). ${error_preview}" >&2
      rm -f "${error_file}"
      return "${status}"
    fi
    local wait_seconds=$((backoff_seconds * attempt))
    echo "::warning::gh api '${endpoint}' attempt ${attempt}/${max_attempts} failed (exit=${status}); retrying in ${wait_seconds}s. ${error_preview}" >&2
    sleep "${wait_seconds}"
    attempt=$((attempt + 1))
  done

  rm -f "${error_file}"
  return "${status}"
}

gh_api_json_soft() {
  gh_api_json "$@" || return 0
}

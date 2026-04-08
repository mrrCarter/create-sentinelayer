#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GITHUB_REPOSITORY:-}" ]; then
  echo "::error::GITHUB_REPOSITORY is required."
  exit 1
fi

if [ -z "${TARGET_SHA:-}" ]; then
  echo "::error::TARGET_SHA is required."
  exit 1
fi

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::error::GH_TOKEN is required."
  exit 1
fi

REQUIRED_CHECKS_JSON="${REQUIRED_CHECKS_JSON:-[]}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-900}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"

if ! echo "${REQUIRED_CHECKS_JSON}" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "::error::REQUIRED_CHECKS_JSON must be a JSON array."
  exit 1
fi

fetch_check_runs_json() {
  local page=1
  local all_runs='[]'
  while true; do
    page_json="$(curl -fsSL \
      -H "Authorization: Bearer ${GH_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${TARGET_SHA}/check-runs?per_page=100&page=${page}")"

    page_runs="$(echo "${page_json}" | jq '.check_runs // []')"
    all_runs="$(jq -s '.[0] + .[1]' \
      <(printf '%s' "${all_runs}") \
      <(printf '%s' "${page_runs}"))"

    page_size="$(echo "${page_runs}" | jq 'length')"
    if [ "${page_size}" -lt 100 ]; then
      break
    fi

    page="$((page + 1))"
    if [ "${page}" -gt 50 ]; then
      echo "::error::Aborting check-run pagination after 50 pages for commit ${TARGET_SHA}."
      exit 1
    fi
  done

  printf '%s' "${all_runs}"
}

deadline_epoch="$(( $(date +%s) + MAX_WAIT_SECONDS ))"
missing_or_pending=""

while true; do
  check_runs_json="$(fetch_check_runs_json)"
  missing_or_pending=""

  while IFS= read -r check_spec; do
    check_name="$(echo "${check_spec}" | jq -r '.name')"
    check_app="$(echo "${check_spec}" | jq -r '.app')"
    check_optional="$(echo "${check_spec}" | jq -r '.optional // false')"

    if [ -z "${check_name}" ] || [ "${check_name}" = "null" ]; then
      echo "::error::Invalid check spec: missing name."
      exit 1
    fi
    if [ -z "${check_app}" ] || [ "${check_app}" = "null" ]; then
      echo "::error::Invalid check spec for '${check_name}': missing app."
      exit 1
    fi

    latest_match="$(echo "${check_runs_json}" | jq -c \
      --arg name "${check_name}" \
      --arg app "${check_app}" '
        [
          .[]
          | select(.name == $name and .app.slug == $app)
          | {
              status: .status,
              conclusion: (.conclusion // ""),
              completed_at: (.completed_at // "")
            }
        ]
        | sort_by(.completed_at)
        | last // null
      ')"

    if [ "${latest_match}" = "null" ]; then
      if [ "${check_optional}" = "true" ]; then
        echo "::notice::Optional check '${check_name}' from app '${check_app}' not present on ${TARGET_SHA}."
        continue
      fi
      missing_or_pending="${missing_or_pending}${check_name}@${check_app} (missing), "
      continue
    fi

    latest_status="$(echo "${latest_match}" | jq -r '.status')"
    latest_conclusion="$(echo "${latest_match}" | jq -r '.conclusion')"

    if [ "${latest_status}" != "completed" ]; then
      missing_or_pending="${missing_or_pending}${check_name}@${check_app} (${latest_status}), "
      continue
    fi

    if [ "${latest_conclusion}" != "success" ]; then
      echo "::error::Required check '${check_name}' from app '${check_app}' concluded '${latest_conclusion}' for commit ${TARGET_SHA}."
      exit 1
    fi
  done < <(echo "${REQUIRED_CHECKS_JSON}" | jq -c '.[]')

  if [ -z "${missing_or_pending}" ]; then
    echo "All required checks succeeded for commit ${TARGET_SHA}."
    break
  fi

  now_epoch="$(date +%s)"
  if [ "${now_epoch}" -ge "${deadline_epoch}" ]; then
    echo "::error::Timed out waiting for required checks on ${TARGET_SHA}: ${missing_or_pending%, }"
    exit 1
  fi

  echo "Waiting for required checks: ${missing_or_pending%, }"
  sleep "${POLL_INTERVAL_SECONDS}"
done

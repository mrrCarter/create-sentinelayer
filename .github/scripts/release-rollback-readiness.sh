#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:-sentinelayer-cli}"
ROLLBACK_MODE="${ROLLBACK_MODE:-release}"
RELEASE_VERSION="${RELEASE_VERSION:-}"
ROLLBACK_TARGET_OVERRIDE="${ROLLBACK_TARGET_OVERRIDE:-}"
NON_BLOCKING_DIAGNOSTICS="${NON_BLOCKING_DIAGNOSTICS:-0}"
NPM_QUERY_TIMEOUT_SECONDS="${NPM_QUERY_TIMEOUT_SECONDS:-45}"
NPM_QUERY_MAX_ATTEMPTS="${NPM_QUERY_MAX_ATTEMPTS:-3}"
NPM_SMOKE_TIMEOUT_SECONDS="${NPM_SMOKE_TIMEOUT_SECONDS:-90}"
NPM_SMOKE_MAX_ATTEMPTS="${NPM_SMOKE_MAX_ATTEMPTS:-3}"
NPM_RETRY_BACKOFF_BASE_SECONDS="${NPM_RETRY_BACKOFF_BASE_SECONDS:-2}"

resolve_timeout_bin() {
  if command -v timeout >/dev/null 2>&1; then
    echo "timeout"
    return 0
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    echo "gtimeout"
    return 0
  fi
  echo ""
}

TIMEOUT_BIN="$(resolve_timeout_bin)"

npm_view_json() {
  local package_spec="$1"
  local field="$2"
  local label="$3"
  local fallback="$4"
  local output=""
  local attempt=0
  local exit_code=1
  local max_attempts="${NPM_QUERY_MAX_ATTEMPTS}"
  local timeout_seconds="${NPM_QUERY_TIMEOUT_SECONDS}"
  local backoff_base="${NPM_RETRY_BACKOFF_BASE_SECONDS}"

  if ! [[ "${max_attempts}" =~ ^[0-9]+$ ]] || [ "${max_attempts}" -lt 1 ]; then
    max_attempts=1
  fi
  if ! [[ "${timeout_seconds}" =~ ^[0-9]+$ ]] || [ "${timeout_seconds}" -lt 1 ]; then
    timeout_seconds=45
  fi
  if ! [[ "${backoff_base}" =~ ^[0-9]+$ ]] || [ "${backoff_base}" -lt 1 ]; then
    backoff_base=2
  fi

  for attempt in $(seq 1 "${max_attempts}"); do
    if [ -n "${TIMEOUT_BIN}" ]; then
      output="$("${TIMEOUT_BIN}" "${timeout_seconds}s" npm view "${package_spec}" "${field}" --json 2>/dev/null)" && {
        printf '%s' "${output}"
        return 0
      }
      exit_code=$?
    else
      output="$(npm view "${package_spec}" "${field}" --json 2>/dev/null)" && {
        printf '%s' "${output}"
        return 0
      }
      exit_code=$?
    fi
    if [ "${attempt}" -lt "${max_attempts}" ]; then
      # Exponential backoff with jitter (0-999ms). Linear + no jitter syncs
      # concurrent incident responses into a thundering herd against npm.
      base_ms=$(( attempt * backoff_base * 1000 ))
      jitter_ms=$(( RANDOM % 1000 ))
      sleep_ms=$(( base_ms + jitter_ms ))
      sleep_seconds_formatted="$(printf '%d.%03d' "$(( sleep_ms / 1000 ))" "$(( sleep_ms % 1000 ))")"
      echo "::warning::npm query failed for ${label} (attempt ${attempt}/${max_attempts}, exit=${exit_code}); retrying in ${sleep_seconds_formatted}s (with jitter)."
      sleep "${sleep_seconds_formatted}"
    fi
  done

  if [ "${NON_BLOCKING_DIAGNOSTICS}" = "1" ]; then
    echo "::warning::Non-blocking diagnostics enabled; npm query failed for ${label} (${package_spec} ${field}) after ${max_attempts} attempt(s)."
    printf '%s' "${fallback}"
    return 0
  fi

  echo "::error::npm query failed for ${label} (${package_spec} ${field}) after ${max_attempts} attempt(s)."
  exit 1
}

dist_tags_json="$(npm_view_json "${PACKAGE_NAME}" "dist-tags" "dist-tags" '{}')"
versions_json="$(npm_view_json "${PACKAGE_NAME}" "versions" "versions" '[]')"

if ! echo "${dist_tags_json}" | jq -e 'type == "object"' >/dev/null; then
  echo "::error::Unable to parse npm dist-tags for ${PACKAGE_NAME}."
  exit 1
fi

versions_array="$(
  echo "${versions_json}" \
    | jq -c '
      if type == "array" then .
      elif type == "string" then [.]
      else []
      end
    '
)"

latest_tag="$(echo "${dist_tags_json}" | jq -r '.latest // empty')"
previous_version="$(
  echo "${versions_array}" \
    | jq -r '
      if length >= 2 then .[-2]
      elif length == 1 then .[-1]
      else empty
      end
    '
)"

rollback_target="${previous_version:-${latest_tag}}"
if [ -n "${ROLLBACK_TARGET_OVERRIDE}" ]; then
  rollback_target="${ROLLBACK_TARGET_OVERRIDE}"
fi
release_already_published="false"
if [ -n "${RELEASE_VERSION}" ]; then
  if echo "${versions_array}" | jq -e --arg version "${RELEASE_VERSION}" 'index($version) != null' >/dev/null; then
    release_already_published="true"
  fi
fi

rollback_target_resolved="false"
rollback_target_installable="false"
rollback_target_tarball=""
rollback_target_integrity=""
rollback_target_smoke_checked="false"
rollback_target_smoke_install="false"
rollback_target_smoke_cli_checks="false"
rollback_target_smoke_failure_reason=""
rollback_smoke_tmp_dir=""

cleanup_rollback_smoke_dir() {
  if [ -n "${rollback_smoke_tmp_dir}" ] && [ -d "${rollback_smoke_tmp_dir}" ]; then
    rm -rf "${rollback_smoke_tmp_dir}"
  fi
}
trap cleanup_rollback_smoke_dir EXIT

run_rollback_smoke_check() {
  rollback_smoke_tmp_dir="$(mktemp -d)"
  local install_attempt=0
  local install_exit_code=1
  local install_max_attempts="${NPM_SMOKE_MAX_ATTEMPTS}"
  local install_timeout_seconds="${NPM_SMOKE_TIMEOUT_SECONDS}"
  local backoff_base="${NPM_RETRY_BACKOFF_BASE_SECONDS}"
  if ! [[ "${install_max_attempts}" =~ ^[0-9]+$ ]] || [ "${install_max_attempts}" -lt 1 ]; then
    install_max_attempts=1
  fi
  if ! [[ "${install_timeout_seconds}" =~ ^[0-9]+$ ]] || [ "${install_timeout_seconds}" -lt 1 ]; then
    install_timeout_seconds=90
  fi
  if ! [[ "${backoff_base}" =~ ^[0-9]+$ ]] || [ "${backoff_base}" -lt 1 ]; then
    backoff_base=2
  fi

  for install_attempt in $(seq 1 "${install_max_attempts}"); do
    if [ -n "${TIMEOUT_BIN}" ]; then
      if "${TIMEOUT_BIN}" "${install_timeout_seconds}s" npm install --prefix "${rollback_smoke_tmp_dir}" --ignore-scripts "${PACKAGE_NAME}@${rollback_target}" >/dev/null 2>&1; then
        install_exit_code=0
      else
        install_exit_code=$?
      fi
    else
      if npm install --prefix "${rollback_smoke_tmp_dir}" --ignore-scripts "${PACKAGE_NAME}@${rollback_target}" >/dev/null 2>&1; then
        install_exit_code=0
      else
        install_exit_code=$?
      fi
    fi
    if [ "${install_exit_code}" -eq 0 ]; then
      break
    fi
    if [ "${install_attempt}" -lt "${install_max_attempts}" ]; then
      sleep_seconds=$(( install_attempt * backoff_base ))
      echo "::warning::Rollback smoke npm install failed for ${PACKAGE_NAME}@${rollback_target} (attempt ${install_attempt}/${install_max_attempts}, exit=${install_exit_code}); retrying in ${sleep_seconds}s."
      sleep "${sleep_seconds}"
    fi
  done
  if [ "${install_exit_code}" -ne 0 ]; then
    rollback_target_smoke_failure_reason="npm install failed for ${PACKAGE_NAME}@${rollback_target} after ${install_max_attempts} attempt(s)"
    return 1
  fi

  local bin_dir="${rollback_smoke_tmp_dir}/node_modules/.bin"
  local bin_name=""
  local bins=(sentinelayer-cli create-sentinelayer sentinel sl)

  for bin_name in "${bins[@]}"; do
    if [ ! -x "${bin_dir}/${bin_name}" ]; then
      rollback_target_smoke_failure_reason="missing CLI binary: ${bin_name}"
      return 1
    fi
    if ! "${bin_dir}/${bin_name}" --version >/dev/null 2>&1; then
      rollback_target_smoke_failure_reason="CLI binary version check failed: ${bin_name}"
      return 1
    fi
  done

  rollback_target_smoke_install="true"
  rollback_target_smoke_cli_checks="true"
  return 0
}

if [ -n "${rollback_target}" ]; then
  if echo "${versions_array}" | jq -e --arg version "${rollback_target}" 'index($version) != null' >/dev/null; then
    rollback_target_resolved="true"
  fi
  if [ "${rollback_target_resolved}" = "true" ]; then
    rollback_dist_json="$(npm_view_json "${PACKAGE_NAME}@${rollback_target}" "dist" "rollback target dist metadata" '{}')"
    rollback_target_tarball="$(
      echo "${rollback_dist_json}" \
        | jq -r '
          if type == "object" then (.tarball // empty)
          else empty
          end
        '
    )"
    rollback_target_integrity="$(
      echo "${rollback_dist_json}" \
        | jq -r '
          if type == "object" then (.integrity // empty)
          else empty
          end
        '
    )"
  fi
  if [ -n "${rollback_target_tarball}" ] && [ -n "${rollback_target_integrity}" ] \
    && [ "${rollback_target_tarball}" != "null" ] && [ "${rollback_target_integrity}" != "null" ]; then
    rollback_target_installable="true"
  fi
fi

if [ "${rollback_target_resolved}" != "true" ]; then
  echo "::error::Rollback target version could not be resolved: ${PACKAGE_NAME}@${rollback_target:-<none>}."
  exit 1
fi

if [ "${rollback_target_installable}" != "true" ]; then
  echo "::error::Rollback target is missing dist metadata (tarball/integrity): ${PACKAGE_NAME}@${rollback_target}."
  exit 1
fi

rollback_target_smoke_checked="true"
if ! run_rollback_smoke_check; then
  if [ "${NON_BLOCKING_DIAGNOSTICS}" = "1" ]; then
    echo "::warning::Rollback smoke check failed in non-blocking diagnostics mode: ${rollback_target_smoke_failure_reason}."
  else
    echo "::error::Rollback smoke check failed: ${rollback_target_smoke_failure_reason}."
    exit 1
  fi
fi

echo "## Rollback Readiness (${ROLLBACK_MODE})" >> "${GITHUB_STEP_SUMMARY}"
echo "- package: \`${PACKAGE_NAME}\`" >> "${GITHUB_STEP_SUMMARY}"
if [ -n "${RELEASE_VERSION}" ]; then
  echo "- release_version: \`${RELEASE_VERSION}\`" >> "${GITHUB_STEP_SUMMARY}"
fi
echo "- latest_dist_tag: \`${latest_tag:-<none>}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- previous_version: \`${previous_version:-<none>}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- rollback_target: \`${rollback_target:-<none>}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- release_already_published: \`${release_already_published}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- rollback_target_resolved: \`${rollback_target_resolved}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- rollback_target_installable: \`${rollback_target_installable}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- rollback_target_tarball: \`${rollback_target_tarball:-<none>}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- rollback_target_smoke_checked: \`${rollback_target_smoke_checked}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- rollback_target_smoke_install: \`${rollback_target_smoke_install}\`" >> "${GITHUB_STEP_SUMMARY}"
echo "- rollback_target_smoke_cli_checks: \`${rollback_target_smoke_cli_checks}\`" >> "${GITHUB_STEP_SUMMARY}"
if [ -n "${rollback_target_smoke_failure_reason}" ]; then
  echo "- rollback_target_smoke_failure_reason: \`${rollback_target_smoke_failure_reason}\`" >> "${GITHUB_STEP_SUMMARY}"
fi
echo "- non_blocking_diagnostics: \`${NON_BLOCKING_DIAGNOSTICS}\`" >> "${GITHUB_STEP_SUMMARY}"

echo "" >> "${GITHUB_STEP_SUMMARY}"
echo "### Dry-Run Rollback Plan" >> "${GITHUB_STEP_SUMMARY}"
echo "1. \`npm dist-tag add ${PACKAGE_NAME}@${rollback_target} latest\`" >> "${GITHUB_STEP_SUMMARY}"
if [ -n "${RELEASE_VERSION}" ] && [ "${release_already_published}" = "true" ]; then
  echo "2. \`npm deprecate ${PACKAGE_NAME}@${RELEASE_VERSION} \\\"Superseded by rollback to ${rollback_target}\\\" \`" >> "${GITHUB_STEP_SUMMARY}"
else
  echo "2. No published target release version to deprecate in this run." >> "${GITHUB_STEP_SUMMARY}"
fi

jq -n \
  --arg package "${PACKAGE_NAME}" \
  --arg mode "${ROLLBACK_MODE}" \
  --arg release_version "${RELEASE_VERSION}" \
  --arg latest_dist_tag "${latest_tag}" \
  --arg previous_version "${previous_version}" \
  --arg rollback_target "${rollback_target}" \
  --arg release_already_published "${release_already_published}" \
  --arg rollback_target_resolved "${rollback_target_resolved}" \
  --arg rollback_target_installable "${rollback_target_installable}" \
  --arg rollback_target_tarball "${rollback_target_tarball}" \
  --arg rollback_target_integrity "${rollback_target_integrity}" \
  --arg rollback_target_smoke_checked "${rollback_target_smoke_checked}" \
  --arg rollback_target_smoke_install "${rollback_target_smoke_install}" \
  --arg rollback_target_smoke_cli_checks "${rollback_target_smoke_cli_checks}" \
  --arg rollback_target_smoke_failure_reason "${rollback_target_smoke_failure_reason}" \
  --arg non_blocking_diagnostics "${NON_BLOCKING_DIAGNOSTICS}" \
  '{
    package: $package,
    mode: $mode,
    release_version: ($release_version | if length > 0 then . else null end),
    latest_dist_tag: ($latest_dist_tag | if length > 0 then . else null end),
    previous_version: ($previous_version | if length > 0 then . else null end),
    rollback_target: ($rollback_target | if length > 0 then . else null end),
    release_already_published: ($release_already_published == "true"),
    checks: {
      rollback_target_resolved: ($rollback_target_resolved == "true"),
      rollback_target_installable: ($rollback_target_installable == "true"),
      rollback_target_tarball: ($rollback_target_tarball | if length > 0 then . else null end),
      rollback_target_integrity: ($rollback_target_integrity | if length > 0 then . else null end),
      rollback_target_smoke_checked: ($rollback_target_smoke_checked == "true"),
      rollback_target_smoke_install: ($rollback_target_smoke_install == "true"),
      rollback_target_smoke_cli_checks: ($rollback_target_smoke_cli_checks == "true"),
      rollback_target_smoke_failure_reason: ($rollback_target_smoke_failure_reason | if length > 0 then . else null end)
    },
    non_blocking_diagnostics: ($non_blocking_diagnostics == "1")
  }' > release-rollback-readiness.json

if [ -n "${RELEASE_VERSION}" ] && [ "${release_already_published}" = "true" ]; then
  echo "::warning::Release version ${PACKAGE_NAME}@${RELEASE_VERSION} is already published."
fi


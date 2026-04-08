#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:-sentinelayer-cli}"
ROLLBACK_MODE="${ROLLBACK_MODE:-release}"
RELEASE_VERSION="${RELEASE_VERSION:-}"

dist_tags_json="$(npm view "${PACKAGE_NAME}" dist-tags --json 2>/dev/null || echo '{}')"
versions_json="$(npm view "${PACKAGE_NAME}" versions --json 2>/dev/null || echo '[]')"

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
release_already_published="false"
if [ -n "${RELEASE_VERSION}" ]; then
  if npm view "${PACKAGE_NAME}@${RELEASE_VERSION}" version >/dev/null 2>&1; then
    release_already_published="true"
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

jq -n \
  --arg package "${PACKAGE_NAME}" \
  --arg mode "${ROLLBACK_MODE}" \
  --arg release_version "${RELEASE_VERSION}" \
  --arg latest_dist_tag "${latest_tag}" \
  --arg previous_version "${previous_version}" \
  --arg rollback_target "${rollback_target}" \
  --arg release_already_published "${release_already_published}" \
  '{
    package: $package,
    mode: $mode,
    release_version: ($release_version | if length > 0 then . else null end),
    latest_dist_tag: ($latest_dist_tag | if length > 0 then . else null end),
    previous_version: ($previous_version | if length > 0 then . else null end),
    rollback_target: ($rollback_target | if length > 0 then . else null end),
    release_already_published: ($release_already_published == "true")
  }' > release-rollback-readiness.json

if [ -n "${RELEASE_VERSION}" ] && [ "${release_already_published}" = "true" ]; then
  echo "::warning::Release version ${PACKAGE_NAME}@${RELEASE_VERSION} is already published."
fi

if [ -z "${rollback_target}" ]; then
  echo "::warning::No prior published version discovered for rollback target."
fi


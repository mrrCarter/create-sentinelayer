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

rollback_target_resolved="false"
rollback_target_installable="false"
rollback_target_tarball=""
rollback_target_integrity=""

if [ -n "${rollback_target}" ]; then
  resolved_version="$(npm view "${PACKAGE_NAME}@${rollback_target}" version 2>/dev/null || true)"
  if [ "${resolved_version}" = "${rollback_target}" ]; then
    rollback_target_resolved="true"
  fi
  rollback_target_tarball="$(npm view "${PACKAGE_NAME}@${rollback_target}" dist.tarball 2>/dev/null || true)"
  rollback_target_integrity="$(npm view "${PACKAGE_NAME}@${rollback_target}" dist.integrity 2>/dev/null || true)"
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
      rollback_target_integrity: ($rollback_target_integrity | if length > 0 then . else null end)
    }
  }' > release-rollback-readiness.json

if [ -n "${RELEASE_VERSION}" ] && [ "${release_already_published}" = "true" ]; then
  echo "::warning::Release version ${PACKAGE_NAME}@${RELEASE_VERSION} is already published."
fi


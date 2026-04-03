#!/usr/bin/env bash
set -euo pipefail

allowlist_file="${ACTION_SHA_ALLOWLIST_FILE:-.github/security/action-sha-allowlist.txt}"
if [[ ! -f "${allowlist_file}" ]]; then
  echo "::error::Missing action SHA allowlist file '${allowlist_file}'."
  exit 1
fi

declare -A allowlisted_shas=()
while IFS='=' read -r action_name pinned_sha; do
  normalized_action="$(echo "${action_name}" | xargs || true)"
  normalized_sha="$(echo "${pinned_sha}" | tr -d '[:space:]' || true)"
  if [[ -z "${normalized_action}" ]]; then
    continue
  fi
  if [[ "${normalized_action}" == \#* ]]; then
    continue
  fi
  if [[ ! "${normalized_sha}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::Invalid SHA '${normalized_sha}' for action '${normalized_action}' in ${allowlist_file}."
    exit 1
  fi
  allowlisted_shas["${normalized_action}"]="${normalized_sha}"
done < "${allowlist_file}"

if [[ "${#allowlisted_shas[@]}" -eq 0 ]]; then
  echo "::error::No allowlisted workflow actions defined in ${allowlist_file}."
  exit 1
fi

workflow_files=("$@")
if [[ "${#workflow_files[@]}" -eq 0 ]]; then
  mapfile -t workflow_files < <(find .github/workflows -maxdepth 1 -type f -name "*.yml" | LC_ALL=C sort)
fi

if [[ "${#workflow_files[@]}" -eq 0 ]]; then
  echo "::error::No workflow files found for action SHA validation."
  exit 1
fi

failures=0
for workflow_file in "${workflow_files[@]}"; do
  if [[ ! -f "${workflow_file}" ]]; then
    echo "::error::Workflow file '${workflow_file}' does not exist."
    failures=$((failures + 1))
    continue
  fi

  while IFS= read -r uses_line; do
    uses_value="$(echo "${uses_line}" | sed -E 's/^[[:space:]]*uses:[[:space:]]*//; s/[[:space:]]+#.*$//; s/[[:space:]]+$//')"
    if [[ -z "${uses_value}" ]]; then
      continue
    fi
    if [[ "${uses_value}" == ./* ]] || [[ "${uses_value}" == docker://* ]]; then
      continue
    fi
    if [[ ! "${uses_value}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$ ]]; then
      echo "::error file=${workflow_file}::Action reference '${uses_value}' must pin a full 40-character SHA."
      failures=$((failures + 1))
      continue
    fi
    action_key="${uses_value%@*}"
    workflow_sha="${uses_value##*@}"
    allowlisted_sha="${allowlisted_shas[${action_key}]-}"
    if [[ -z "${allowlisted_sha}" ]]; then
      echo "::error file=${workflow_file}::Missing allowlist entry for '${action_key}'."
      failures=$((failures + 1))
      continue
    fi
    if [[ "${workflow_sha}" != "${allowlisted_sha}" ]]; then
      echo "::error file=${workflow_file}::SHA mismatch for '${action_key}' (workflow=${workflow_sha}, allowlist=${allowlisted_sha})."
      failures=$((failures + 1))
    fi
  done < <(grep -E '^[[:space:]]*uses:[[:space:]]*' "${workflow_file}" || true)
done

if [[ "${failures}" -gt 0 ]]; then
  echo "::error::Workflow action SHA validation failed with ${failures} issue(s)."
  exit 1
fi

echo "Verified pinned workflow action SHAs for ${#workflow_files[@]} workflow file(s)."

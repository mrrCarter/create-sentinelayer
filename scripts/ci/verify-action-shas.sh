#!/usr/bin/env bash
set -euo pipefail

allowlist_file="${ACTION_SHA_ALLOWLIST_FILE:-.github/security/action-sha-allowlist.txt}"
if [[ ! -f "${allowlist_file}" ]]; then
  echo "::error::Missing action SHA allowlist file '${allowlist_file}'."
  exit 1
fi

remote_exec_allowlist_file="${ACTION_REMOTE_EXEC_ALLOWLIST_FILE:-.github/security/workflow-remote-exec-allowlist.txt}"
if [[ ! -f "${remote_exec_allowlist_file}" ]]; then
  echo "::error::Missing workflow remote-exec allowlist file '${remote_exec_allowlist_file}'."
  exit 1
fi

provenance_policy_file="${ACTION_SHA_PROVENANCE_POLICY_FILE:-.github/security/action-provenance-policy.json}"
if [[ ! -f "${provenance_policy_file}" ]]; then
  echo "::error::Missing action provenance policy file '${provenance_policy_file}'."
  exit 1
fi

mapfile -t trusted_action_owners < <(
  jq -r '.trustedOwners[]? // empty' "${provenance_policy_file}" | awk 'NF {print tolower($0)}'
)
if [[ "${#trusted_action_owners[@]}" -eq 0 ]]; then
  echo "::error::No trustedOwners configured in ${provenance_policy_file}."
  exit 1
fi

require_verified_commit_signatures_raw="$(
  jq -r '.requireVerifiedCommitSignatures // true' "${provenance_policy_file}"
)"
case "$(echo "${require_verified_commit_signatures_raw}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    require_verified_commit_signatures="true"
    ;;
  0|false|no|off)
    require_verified_commit_signatures="false"
    ;;
  *)
    echo "::error::Invalid requireVerifiedCommitSignatures value '${require_verified_commit_signatures_raw}' in ${provenance_policy_file}."
    exit 1
    ;;
esac

has_gh_api_auth="false"
if [[ -n "${GH_TOKEN:-}" ]] || [[ -n "${GITHUB_TOKEN:-}" ]]; then
  has_gh_api_auth="true"
fi
if [[ "${has_gh_api_auth}" != "true" ]]; then
  if [[ "$(echo "${CI:-false}" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
    echo "::error::GitHub API auth token is required in CI for action provenance validation."
    exit 1
  fi
  echo "::notice::Skipping action provenance API checks (no GH_TOKEN/GITHUB_TOKEN configured)."
fi

owner_in_list() {
  local candidate_owner
  candidate_owner="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs || true)"
  shift || true
  if [[ -z "${candidate_owner}" ]]; then
    return 1
  fi
  for listed_owner in "$@"; do
    if [[ "${candidate_owner}" == "${listed_owner}" ]]; then
      return 0
    fi
  done
  return 1
}

duplicate_allowlist_entries="$(
  awk -F'=' '
    /^[[:space:]]*($|#)/ { next }
    {
      key=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key == "") { next }
      if (!(key in first_line)) {
        first_line[key]=NR
        next
      }
      if (!(key in emitted)) {
        printf "%s (lines %d and %d)\n", key, first_line[key], NR
        emitted[key]=1
      }
    }
  ' "${allowlist_file}"
)"
if [[ -n "${duplicate_allowlist_entries}" ]]; then
  duplicate_preview="$(echo "${duplicate_allowlist_entries}" | tr '\n' '; ' | sed -E 's/[;[:space:]]+$//')"
  echo "::error::Duplicate action allowlist entries detected in ${allowlist_file}: ${duplicate_preview}"
  exit 1
fi

declare -A allowlisted_shas=()
declare -A allowlisted_line_numbers=()
allowlist_line_number=0
while IFS='=' read -r action_name pinned_sha; do
  allowlist_line_number=$((allowlist_line_number + 1))
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
  if [[ -n "${allowlisted_shas["${normalized_action}"]+set}" ]]; then
    original_line="${allowlisted_line_numbers["${normalized_action}"]}"
    echo "::error::Duplicate action allowlist entry '${normalized_action}' in ${allowlist_file} (lines ${original_line} and ${allowlist_line_number})."
    exit 1
  fi
  allowlisted_shas["${normalized_action}"]="${normalized_sha}"
  allowlisted_line_numbers["${normalized_action}"]="${allowlist_line_number}"
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

extract_workflow_uses() {
  local workflow_file="${1:-}"
  if [[ -z "${workflow_file}" ]]; then
    return 1
  fi
  node - "${workflow_file}" <<'NODE'
const fs = require("node:fs");
const YAML = require("yaml");

const workflowFile = process.argv[2];
if (!workflowFile) {
  process.stderr.write("Missing workflow file path for uses extraction.\n");
  process.exit(1);
}

let parsed;
try {
  const raw = fs.readFileSync(workflowFile, "utf8");
  const document = YAML.parseDocument(raw, {
    uniqueKeys: true,
    strict: true,
    merge: false,
    prettyErrors: true,
  });
  if (Array.isArray(document.errors) && document.errors.length > 0) {
    const errorSummary = document.errors
      .map((entry) => String(entry && entry.message ? entry.message : entry))
      .join("; ");
    process.stderr.write(`Failed to parse workflow YAML '${workflowFile}': ${errorSummary}\n`);
    process.exit(1);
  }
  if (Array.isArray(document.warnings) && document.warnings.length > 0) {
    const warningSummary = document.warnings
      .map((entry) => String(entry && entry.message ? entry.message : entry))
      .join("; ");
    process.stderr.write(`Workflow YAML '${workflowFile}' emitted parser warnings: ${warningSummary}\n`);
    process.exit(1);
  }
  parsed = document.toJS();
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`Failed to parse workflow YAML '${workflowFile}': ${message}\n`);
  process.exit(1);
}

const jobs =
  parsed &&
  typeof parsed === "object" &&
  parsed.jobs &&
  typeof parsed.jobs === "object"
    ? parsed.jobs
    : {};
for (const jobValue of Object.values(jobs)) {
  if (!jobValue || typeof jobValue !== "object") {
    continue;
  }
  const jobUses = typeof jobValue.uses === "string" ? jobValue.uses.trim() : "";
  if (jobUses) {
    process.stdout.write(`${jobUses}\n`);
  }
  const steps = Array.isArray(jobValue.steps) ? jobValue.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== "object") {
      continue;
    }
    const stepUses = typeof step.uses === "string" ? step.uses.trim() : "";
    if (stepUses) {
      process.stdout.write(`${stepUses}\n`);
    }
  }
}
NODE
}

failures=0
for workflow_file in "${workflow_files[@]}"; do
  if [[ ! -f "${workflow_file}" ]]; then
    echo "::error::Workflow file '${workflow_file}' does not exist."
    failures=$((failures + 1))
    continue
  fi
  uses_output=""
  if ! uses_output="$(extract_workflow_uses "${workflow_file}")"; then
    echo "::error file=${workflow_file}::Unable to parse workflow for pinned action verification."
    failures=$((failures + 1))
    continue
  fi
  mapfile -t uses_entries <<< "${uses_output}"
  for uses_value in "${uses_entries[@]}"; do
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
      continue
    fi
    action_owner="$(echo "${action_key}" | cut -d'/' -f1 | tr '[:upper:]' '[:lower:]' | xargs || true)"
    action_repo="$(echo "${action_key}" | cut -d'/' -f2 | tr '[:upper:]' '[:lower:]' | xargs || true)"
    if [[ -z "${action_owner}" ]] || [[ -z "${action_repo}" ]]; then
      echo "::error file=${workflow_file}::Unable to resolve action owner/repo from '${action_key}'."
      failures=$((failures + 1))
      continue
    fi
    if ! owner_in_list "${action_owner}" "${trusted_action_owners[@]}"; then
      echo "::error file=${workflow_file}::Action owner '${action_owner}' for '${action_key}' is not trusted by ${provenance_policy_file}."
      failures=$((failures + 1))
      continue
    fi
    if [[ "${has_gh_api_auth}" == "true" ]]; then
      commit_status=0
      commit_json="$(timeout --preserve-status 30s gh api "repos/${action_owner}/${action_repo}/commits/${workflow_sha}" -H "Accept: application/vnd.github+json")" || commit_status=$?
      if [[ "${commit_status}" -eq 0 ]]; then
        resolved_commit_sha="$(echo "${commit_json}" | jq -r '.sha // ""' | tr '[:upper:]' '[:lower:]' | xargs || true)"
        if [[ "${resolved_commit_sha}" != "${workflow_sha}" ]]; then
          echo "::error file=${workflow_file}::Action provenance mismatch for '${action_key}' (expected='${workflow_sha}', resolved='${resolved_commit_sha}')."
          failures=$((failures + 1))
          continue
        fi
        if [[ "${require_verified_commit_signatures}" == "true" ]]; then
          commit_verified="$(echo "${commit_json}" | jq -r '.commit.verification.verified // false')"
          if [[ "${commit_verified}" != "true" ]]; then
            echo "::error file=${workflow_file}::Action commit '${action_key}@${workflow_sha}' is not signature-verified."
            failures=$((failures + 1))
            continue
          fi
        fi
      else
        echo "::error file=${workflow_file}::Unable to resolve action provenance for '${action_key}@${workflow_sha}' via commits API."
        failures=$((failures + 1))
        continue
      fi
    fi
  done
done

if ! node scripts/ci/verify-workflow-remote-exec.js --allowlist "${remote_exec_allowlist_file}" "${workflow_files[@]}"; then
  failures=$((failures + 1))
fi

if [[ "${failures}" -gt 0 ]]; then
  echo "::error::Workflow action SHA validation failed with ${failures} issue(s)."
  exit 1
fi

echo "Verified pinned workflow action SHAs and remote-run policies for ${#workflow_files[@]} workflow file(s)."

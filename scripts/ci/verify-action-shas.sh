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
mapfile -t remote_exec_allowlist_patterns < <(grep -vE '^\s*($|#)' "${remote_exec_allowlist_file}" || true)

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

extract_workflow_entries() {
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

const entries = [];
const visited = new Set();
function walk(value) {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      walk(entry);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (visited.has(value)) {
    return;
  }
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "uses" && typeof child === "string") {
      const normalized = child.trim();
      if (normalized) {
        entries.push(`USES\t${normalized}`);
      }
      continue;
    }
    if (key === "run" && typeof child === "string") {
      const normalized = child.trim();
      if (normalized) {
        entries.push(`RUN\t${Buffer.from(normalized, "utf8").toString("base64")}`);
      }
      continue;
    }
    walk(child);
  }
}

walk(parsed);
for (const entry of entries) {
  process.stdout.write(`${entry}\n`);
}
NODE
}

network_fetch_pattern='(curl|wget|invoke-webrequest|iwr|irm)[[:space:]]'
shell_sink_pattern='[|;][[:space:]]*(env[[:space:]]+)?(bash|sh|zsh|ksh|pwsh|powershell|iex)([[:space:]]|$)'
process_substitution_pattern='(bash|sh|zsh|ksh)[[:space:]]*<\([[:space:]]*(curl|wget)[[:space:]]'
source_substitution_pattern='(source|\.)[[:space:]]*<\([[:space:]]*(curl|wget)[[:space:]]'
shell_c_fetch_pattern='(bash|sh|zsh|ksh)[[:space:]]+-c[[:space:]]*[^[:space:]]*(curl|wget)'
pwsh_pipe_iex_pattern='(powershell|pwsh)[^|;]*(iwr|invoke-webrequest|irm)[^|;]*\|[[:space:]]*iex'
iex_iwr_pattern='iex[[:space:]]*\([[:space:]]*(iwr|invoke-webrequest|irm)'

failures=0
for workflow_file in "${workflow_files[@]}"; do
  if [[ ! -f "${workflow_file}" ]]; then
    echo "::error::Workflow file '${workflow_file}' does not exist."
    failures=$((failures + 1))
    continue
  fi

  workflow_entries_output=""
  if ! workflow_entries_output="$(extract_workflow_entries "${workflow_file}")"; then
    echo "::error file=${workflow_file}::Unable to parse workflow for pinned action verification."
    failures=$((failures + 1))
    continue
  fi
  mapfile -t workflow_entries <<< "${workflow_entries_output}"
  uses_entries=()
  run_entries=()
  for workflow_entry in "${workflow_entries[@]}"; do
    if [[ -z "${workflow_entry}" ]]; then
      continue
    fi
    if [[ "${workflow_entry}" == USES$'\t'* ]]; then
      uses_entries+=("${workflow_entry#*$'\t'}")
      continue
    fi
    if [[ "${workflow_entry}" == RUN$'\t'* ]]; then
      encoded_run="${workflow_entry#*$'\t'}"
      decoded_run="$(printf '%s' "${encoded_run}" | base64 --decode 2>/dev/null || true)"
      if [[ -z "${decoded_run}" ]] && [[ -n "${encoded_run}" ]]; then
        echo "::error file=${workflow_file}::Unable to decode base64 run command payload."
        failures=$((failures + 1))
        continue
      fi
      run_entries+=("${decoded_run}")
    fi
  done

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
    fi
  done

  for run_value in "${run_entries[@]}"; do
    if [[ -z "${run_value}" ]]; then
      continue
    fi
    normalized_run="$(
      printf '%s' "${run_value}" \
        | tr '[:upper:]' '[:lower:]' \
        | tr '\n' ' ' \
        | sed -E 's/[[:space:]]+/ /g'
    )"
    remote_exec_detected="false"
    contains_network_fetch="false"
    contains_shell_sink="false"

    if [[ "${normalized_run}" =~ ${network_fetch_pattern} ]]; then
      contains_network_fetch="true"
    fi
    if [[ "${normalized_run}" =~ ${shell_sink_pattern} ]]; then
      contains_shell_sink="true"
    fi
    if [[ "${normalized_run}" =~ ${process_substitution_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${normalized_run}" =~ ${source_substitution_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${normalized_run}" =~ ${shell_c_fetch_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${normalized_run}" =~ ${pwsh_pipe_iex_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${normalized_run}" =~ ${iex_iwr_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${contains_network_fetch}" == "true" && "${contains_shell_sink}" == "true" ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${remote_exec_detected}" != "true" ]]; then
      continue
    fi
    remote_exec_allowlisted="false"
    for allow_pattern in "${remote_exec_allowlist_patterns[@]}"; do
      if [[ -n "${allow_pattern}" ]] && [[ "${normalized_run}" =~ ${allow_pattern} ]]; then
        remote_exec_allowlisted="true"
        break
      fi
    done
    if [[ "${remote_exec_allowlisted}" != "true" ]]; then
      command_preview="$(printf '%s' "${run_value}" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-180)"
      echo "::error file=${workflow_file}::Potential remote shell execution in run step is not allowlisted: ${command_preview}"
      failures=$((failures + 1))
    fi
  done
done

if [[ "${failures}" -gt 0 ]]; then
  echo "::error::Workflow action SHA validation failed with ${failures} issue(s)."
  exit 1
fi

echo "Verified pinned workflow action SHAs and remote-run policies for ${#workflow_files[@]} workflow file(s)."

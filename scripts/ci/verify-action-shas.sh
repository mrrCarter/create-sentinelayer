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
const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
const encode = (value) => Buffer.from(String(value || ""), "utf8").toString("base64");
const tokenizeRun = (script) =>
  String(script || "")
    .toLowerCase()
    .replace(/#.*/g, " ")
    .replace(/[()<>|;&]/g, " ")
    .replace(/["'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const jobs = parsed && typeof parsed === "object" && parsed.jobs && typeof parsed.jobs === "object"
  ? parsed.jobs
  : {};
for (const [jobIdRaw, jobValue] of Object.entries(jobs)) {
  const jobId = slugify(jobIdRaw) || "job";
  if (!jobValue || typeof jobValue !== "object") {
    continue;
  }
  const jobUses = typeof jobValue.uses === "string" ? jobValue.uses.trim() : "";
  if (jobUses) {
    entries.push(`USES\t${jobUses}\t${jobId}\tjob`);
  }
  const steps = Array.isArray(jobValue.steps) ? jobValue.steps : [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || typeof step !== "object") {
      continue;
    }
    const stepId =
      slugify(step.id) ||
      slugify(step.name) ||
      `step-${index + 1}`;
    const stepUses = typeof step.uses === "string" ? step.uses.trim() : "";
    if (stepUses) {
      entries.push(`USES\t${stepUses}\t${jobId}\t${stepId}`);
    }
    const stepRun = typeof step.run === "string" ? step.run.trim() : "";
    if (stepRun) {
      entries.push(
        `RUN\t${encode(stepRun)}\t${encode(tokenizeRun(stepRun))}\t${jobId}\t${stepId}`
      );
    }
  }
}

for (const entry of entries) {
  process.stdout.write(`${entry}\n`);
}
NODE
}

network_fetch_pattern='(curl|wget|invoke-webrequest|iwr|irm)[[:space:]]'
shell_sink_pattern='[|;][[:space:]]*(env[[:space:]]+)?(bash|sh|zsh|ksh|pwsh|powershell|iex)([[:space:]]|$)'
process_substitution_pattern='(bash|sh|zsh|ksh)[[:space:]]*<\([[:space:]]*(curl|wget|invoke-webrequest|iwr|irm)[[:space:]]'
source_substitution_pattern='(source|\.)[[:space:]]*<\([[:space:]]*(curl|wget|invoke-webrequest|iwr|irm)[[:space:]]'
shell_c_fetch_pattern='(bash|sh|zsh|ksh)[[:space:]]+-c[[:space:]]*[^[:space:]]*(curl|wget|invoke-webrequest|iwr|irm)'
pwsh_pipe_iex_pattern='(powershell|pwsh)[^|;]*(iwr|invoke-webrequest|irm)[^|;]*\|[[:space:]]*iex'
iex_iwr_pattern='iex[[:space:]]*\([[:space:]]*(iwr|invoke-webrequest|irm)'
obfuscation_indirection_pattern='(\$\(|`|eval[[:space:]]|bash[[:space:]]+-c[[:space:]]*\$|sh[[:space:]]+-c[[:space:]]*\$|pwsh[[:space:]]+-c[[:space:]]*\$|powershell[[:space:]]+-c[[:space:]]*\$)'
base64_pipe_shell_pattern='(base64|openssl[[:space:]]+base64)[^|;]*\|[[:space:]]*(bash|sh|zsh|ksh|pwsh|powershell|iex)([[:space:]]|$)'
network_variable_assignment_pattern='[a-z_][a-z0-9_]*[[:space:]]*=[[:space:]]*["'"'"'`]*(curl|wget|invoke-webrequest|iwr|irm)([[:space:]]|$)'
variable_exec_pattern='(eval|bash[[:space:]]+-c|sh[[:space:]]+-c|pwsh[[:space:]]+-c|powershell[[:space:]]+-c)[^[:cntrl:]]*\$[a-z_][a-z0-9_]*'
variable_eval_shell_pattern='eval[[:space:]]+["'"'"'`]*[^[:cntrl:]]*\$[a-z_][a-z0-9_]*[^[:cntrl:]]*(bash|sh|zsh|ksh|pwsh|powershell|iex)'
variable_eval_pipe_shell_pattern='eval[[:space:]]+[^[:cntrl:]]*\$[a-z_][a-z0-9_]*[^[:cntrl:]]*\|[[:space:]]*(bash|sh|zsh|ksh|pwsh|powershell|iex)(["'"'"'`]|[[:space:]]|$)'
eval_pipe_shell_pattern='eval[[:space:]]+[^[:cntrl:]]*\|[[:space:]]*(bash|sh|zsh|ksh|pwsh|powershell|iex)(["'"'"'`]|[[:space:]]|$)'
variable_pipe_shell_pattern='\$[a-z_][a-z0-9_]*[[:space:]]*\|[[:space:]]*(bash|sh|zsh|ksh|pwsh|powershell|iex)(["'"'"'`]|[[:space:]]|$)'
tokenized_network_pattern='(^| )(curl|wget|invoke-webrequest|iwr|irm)( |$)'
tokenized_shell_pattern='(^| )(bash|sh|zsh|ksh|pwsh|powershell|iex)( |$)'
tokenized_obfuscation_pattern='(^| )(eval|base64|openssl|bash -c|sh -c|pwsh -c|powershell -c)( |$)'

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
      IFS=$'\t' read -r _entry_type uses_value _job_id _step_id <<< "${workflow_entry}"
      uses_entries+=("${uses_value}")
      continue
    fi
    if [[ "${workflow_entry}" == RUN$'\t'* ]]; then
      IFS=$'\t' read -r _entry_type encoded_run encoded_tokenized_run run_job_id run_step_id <<< "${workflow_entry}"
      decoded_run="$(printf '%s' "${encoded_run}" | base64 --decode 2>/dev/null || true)"
      decoded_tokenized_run="$(printf '%s' "${encoded_tokenized_run}" | base64 --decode 2>/dev/null || true)"
      if [[ -z "${decoded_run}" ]] && [[ -n "${encoded_run}" ]]; then
        echo "::error file=${workflow_file}::Unable to decode base64 run command payload."
        failures=$((failures + 1))
        continue
      fi
      if [[ -z "${decoded_tokenized_run}" ]] && [[ -n "${encoded_tokenized_run}" ]]; then
        echo "::error file=${workflow_file}::Unable to decode tokenized run command payload."
        failures=$((failures + 1))
        continue
      fi
      run_entries+=("${decoded_run}"$'\x1f'"${decoded_tokenized_run}"$'\x1f'"${run_job_id}"$'\x1f'"${run_step_id}")
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

  for run_entry in "${run_entries[@]}"; do
    if [[ -z "${run_entry}" ]]; then
      continue
    fi
    IFS=$'\x1f' read -r run_value tokenized_run run_job_id run_step_id <<< "${run_entry}"
    if [[ -z "${run_value}" ]]; then
      continue
    fi
    normalized_run="$(
      printf '%s' "${run_value}" \
        | tr '[:upper:]' '[:lower:]' \
        | tr '\n' ' ' \
        | sed -E 's/[[:space:]]+/ /g'
    )"
    normalized_tokenized_run="$(
      printf '%s' "${tokenized_run:-}" \
        | tr '[:upper:]' '[:lower:]' \
        | tr '\n' ' ' \
        | sed -E 's/[[:space:]]+/ /g'
    )"
    run_job_id="$(echo "${run_job_id:-job}" | tr -d '\r' | xargs || true)"
    run_step_id="$(echo "${run_step_id:-step}" | tr -d '\r' | xargs || true)"
    if [[ -z "${run_job_id}" ]]; then
      run_job_id="job"
    fi
    if [[ -z "${run_step_id}" ]]; then
      run_step_id="step"
    fi
    allowlist_context="${workflow_file}#${run_job_id}.${run_step_id}"
    remote_exec_detected="false"
    contains_network_fetch="false"
    contains_shell_sink="false"
    tokenized_contains_network="false"
    tokenized_contains_shell="false"

    if [[ "${normalized_run}" =~ ${network_fetch_pattern} ]]; then
      contains_network_fetch="true"
    fi
    if [[ "${normalized_run}" =~ ${shell_sink_pattern} ]]; then
      contains_shell_sink="true"
    fi
    if [[ "${normalized_tokenized_run}" =~ ${tokenized_network_pattern} ]]; then
      tokenized_contains_network="true"
    fi
    if [[ "${normalized_tokenized_run}" =~ ${tokenized_shell_pattern} ]]; then
      tokenized_contains_shell="true"
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
    if [[ "${normalized_run}" =~ ${base64_pipe_shell_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${normalized_run}" =~ ${network_variable_assignment_pattern} ]] && [[ "${normalized_run}" =~ ${variable_exec_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${normalized_run}" =~ ${network_variable_assignment_pattern} ]] && [[ "${normalized_run}" =~ ${variable_eval_shell_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${contains_network_fetch}" == "true" && "${normalized_run}" =~ ${variable_eval_pipe_shell_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${contains_network_fetch}" == "true" && "${normalized_run}" =~ ${eval_pipe_shell_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${contains_network_fetch}" == "true" && "${normalized_run}" =~ ${variable_pipe_shell_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${contains_network_fetch}" == "true" ]] \
      && printf '%s\n' "${normalized_run}" \
        | grep -Eq 'eval[[:space:]]+["'"'"']?\$[a-z_][a-z0-9_]*[[:space:]]*\|[[:space:]]*(bash|sh|zsh|ksh|pwsh|powershell|iex)(["'"'"']|[[:space:]]|$)'; then
      remote_exec_detected="true"
    fi
    if [[ "${contains_network_fetch}" == "true" && "${normalized_run}" =~ ${obfuscation_indirection_pattern} ]]; then
      remote_exec_detected="true"
    fi
    if [[ "${tokenized_contains_network}" == "true" && "${tokenized_contains_shell}" == "true" && "${normalized_tokenized_run}" =~ ${tokenized_obfuscation_pattern} ]]; then
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
      if [[ -n "${allow_pattern}" ]] && ( [[ "${normalized_run}" =~ ${allow_pattern} ]] || [[ "${normalized_tokenized_run}" =~ ${allow_pattern} ]] || [[ "${allowlist_context}" =~ ${allow_pattern} ]] ); then
        remote_exec_allowlisted="true"
        break
      fi
    done
    if [[ "${remote_exec_allowlisted}" != "true" ]]; then
      command_preview="$(printf '%s' "${run_value}" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-180)"
      echo "::error file=${workflow_file}::Potential remote shell execution in run step is not allowlisted (${allowlist_context}): ${command_preview}"
      failures=$((failures + 1))
    fi
  done
done

if [[ "${failures}" -gt 0 ]]; then
  echo "::error::Workflow action SHA validation failed with ${failures} issue(s)."
  exit 1
fi

echo "Verified pinned workflow action SHAs and remote-run policies for ${#workflow_files[@]} workflow file(s)."

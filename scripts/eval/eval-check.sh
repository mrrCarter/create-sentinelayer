#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-HEAD~1}"
head_ref="${2:-HEAD}"

append_output() {
  local line="$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${line}" >> "$GITHUB_OUTPUT"
  fi
}

list_changed_files() {
  local base="$1"
  local head="$2"
  if git cat-file -e "${base}^{commit}" 2>/dev/null && git cat-file -e "${head}^{commit}" 2>/dev/null; then
    git diff --name-only "${base}" "${head}"
    return
  fi
  git diff --name-only HEAD~1 HEAD
}

changed_files="$(list_changed_files "${base_ref}" "${head_ref}")"
if [ -z "${changed_files}" ]; then
  append_output "eval_required=false"
  echo "Eval impact gate: no changed files detected."
  exit 0
fi

impact_regex='^(src/ai/|src/review/ai-review\.js$|src/commands/(ai|review|audit|swarm|chat)\.js$|src/prompt/|src/swarm/|src/spec/templates\.js$|\.github/instructions/.*\.instructions\.md$|AGENTS\.md$|CLAUDE\.md$)'
evidence_regex='^(tasks/evals/|\.sentinelayer/evals/|evals/|tests/evals/|docs/evals/|reports/evals/)'

impact_files="$(printf '%s\n' "${changed_files}" | grep -E "${impact_regex}" || true)"
if [ -z "${impact_files}" ]; then
  append_output "eval_required=false"
  echo "Eval impact gate: no AI-impacting files changed."
  exit 0
fi

evidence_files="$(printf '%s\n' "${changed_files}" | grep -E "${evidence_regex}" || true)"
if [ -z "${evidence_files}" ]; then
  {
    echo "Eval impact gate failed."
    echo "AI-impacting files changed without eval evidence."
    echo ""
    echo "Changed impact files:"
    printf '%s\n' "${impact_files}"
    echo ""
    echo "Add eval evidence under one of:"
    echo "- tasks/evals/"
    echo "- .sentinelayer/evals/"
    echo "- evals/"
    echo "- tests/evals/"
    echo "- docs/evals/"
    echo "- reports/evals/"
  } >&2

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "## Eval Impact Gate"
      echo "- status: \`failed\`"
      echo "- reason: AI-impacting files changed without eval evidence."
      echo ""
      echo "### Impact files"
      printf '%s\n' "${impact_files}" | sed 's/^/- `/' | sed 's/$/`/'
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  append_output "eval_required=true"
  append_output "eval_evidence_found=false"
  exit 2
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Eval Impact Gate"
    echo "- status: \`passed\`"
    echo "- eval_required: \`true\`"
    echo "- eval_evidence_found: \`true\`"
    echo ""
    echo "### Impact files"
    printf '%s\n' "${impact_files}" | sed 's/^/- `/' | sed 's/$/`/'
    echo ""
    echo "### Evidence files"
    printf '%s\n' "${evidence_files}" | sed 's/^/- `/' | sed 's/$/`/'
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "Eval impact gate passed: evidence files present."
append_output "eval_required=true"
append_output "eval_evidence_found=true"

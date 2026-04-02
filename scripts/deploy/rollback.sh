#!/usr/bin/env bash
set -euo pipefail

rollback_version=""
target_environment=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      rollback_version="${2:-}"
      shift 2
      ;;
    --environment)
      target_environment="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${rollback_version}" ]]; then
  echo "::error::Missing required --version argument." >&2
  exit 1
fi

case "${target_environment}" in
  production|staging)
    ;;
  *)
    echo "::error::Unsupported rollback environment '${target_environment}'. Expected production or staging." >&2
    exit 1
    ;;
esac

if [[ -n "${ROLLBACK_WEBHOOK_URL:-}" ]]; then
  timeout 60s curl --fail --silent --show-error \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"version\":\"${rollback_version}\",\"environment\":\"${target_environment}\"}" \
    "${ROLLBACK_WEBHOOK_URL}" > /dev/null
else
  echo "::notice::ROLLBACK_WEBHOOK_URL is not configured; rollback script executed in simulation mode."
fi

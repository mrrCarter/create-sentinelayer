#!/usr/bin/env bash
set -euo pipefail

tarball_path=""
healthcheck_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball)
      tarball_path="${2:-}"
      shift 2
      ;;
    --healthcheck-url)
      healthcheck_url="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${tarball_path}" ]]; then
  echo "::error::Missing required --tarball argument." >&2
  exit 1
fi
if [[ ! -f "${tarball_path}" ]]; then
  echo "::error::Tarball path does not exist: ${tarball_path}" >&2
  exit 1
fi

timeout 120s npm install --global "${tarball_path}"
timeout 30s create-sentinelayer --version
timeout 30s sentinel --version

if [[ -n "${healthcheck_url}" ]]; then
  case "${healthcheck_url}" in
    https://*|http://localhost*|http://127.0.0.1*|http://[::1]*)
      ;;
    *)
      echo "::error::Unsupported healthcheck URL scheme/host: ${healthcheck_url}" >&2
      exit 1
      ;;
  esac
  timeout 30s curl --fail --silent --show-error "${healthcheck_url}" > /dev/null
fi

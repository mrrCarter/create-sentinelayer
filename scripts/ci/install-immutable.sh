#!/usr/bin/env bash
set -euo pipefail

target_dir="${1:-.}"
timeout_budget="${NPM_CI_TIMEOUT:-8m}"

if [[ ! -d "${target_dir}" ]]; then
  echo "::error::Immutable install target directory '${target_dir}' does not exist."
  exit 1
fi

pushd "${target_dir}" >/dev/null
if [[ ! -f package-lock.json ]]; then
  echo "::error::Immutable install requires package-lock.json in '${target_dir}'."
  exit 1
fi

lock_hash_before="$(sha256sum package-lock.json | awk '{print $1}')"
timeout --preserve-status "${timeout_budget}" npm ci --ignore-scripts
lock_hash_after="$(sha256sum package-lock.json | awk '{print $1}')"

if [[ "${lock_hash_before}" != "${lock_hash_after}" ]]; then
  echo "::error::package-lock.json mutated during immutable install (before='${lock_hash_before}', after='${lock_hash_after}')."
  exit 1
fi

popd >/dev/null
echo "Immutable install succeeded for '${target_dir}'."

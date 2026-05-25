#!/usr/bin/env bash
set -euo pipefail

policy_file="${RELEASE_PROVENANCE_POLICY_FILE:-.github/policies/release-provenance-policy.json}"

if [ ! -f "${policy_file}" ]; then
  echo "::error::Missing release provenance policy file: ${policy_file}."
  exit 1
fi

jq -e '
  . as $policy
  | type == "object"
  and .schema_version == 1
  and .package_name == "sentinelayer-cli"
  and (.quality.workflow_path == ".github/workflows/quality-gates.yml")
  and (.quality.package_artifact_name == "quality-package-artifacts")
  and (.quality.summary_manifest_artifact_name == "quality-summary-manifest")
  and (.attestation.workflow_path == ".github/workflows/attestations.yml")
  and (.attestation.build_artifact_name == "attestation-build-artifacts")
  and (.release.workflow_path == ".github/workflows/release.yml")
  and (.release.artifact_name == "release-artifact")
  and (.release.trusted_ref_pattern == "refs/tags/v*")
  and (.quality.required_manifest_fields | type == "array" and length >= 9)
  and (.attestation.required_manifest_fields | type == "array" and length >= 9)
  and (.release.required_manifest_fields | type == "array" and length >= 10)
  and ([
      "tarball",
      "sha256",
      "commit_sha",
      "workflow_ref",
      "run_id",
      "release_provenance_policy_sha256"
    ] as $required
    | all($required[]; . as $field | ($policy.quality.required_manifest_fields | index($field)) != null))
  and ([
      "tarball",
      "sha256",
      "commit_sha",
      "workflow_ref",
      "workflow_sha256",
      "run_id",
      "release_provenance_policy_sha256"
    ] as $required
    | all($required[]; . as $field | ($policy.attestation.required_manifest_fields | index($field)) != null))
  and ([
      "tarball",
      "sha256",
      "source_workflow_ref",
      "source_run_id",
      "source_commit_sha",
      "release_workflow_sha256",
      "release_provenance_policy_sha256"
    ] as $required
    | all($required[]; . as $field | ($policy.release.required_manifest_fields | index($field)) != null))
' "${policy_file}" >/dev/null

echo "Release provenance policy validated: ${policy_file}"

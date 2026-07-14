from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


class OmarWorkflowContractError(ValueError):
    pass


ACTION_SHA = "52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5"
ACTION_REF = f"mrrCarter/sentinelayer-v1-action@{ACTION_SHA}"
VALIDATOR_PATH = "src/scan/omar-action-evidence-validator.mjs"
CHECKOUT_REF = "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd"
UPLOAD_REF = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"
DOWNLOAD_REF = "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"

FORBIDDEN_MARKERS = (
    "a496be33a466c0cc3f8616d66bbd7d78f7d3c31d",
    "llm_failure_policy: deterministic_only",
    "artifact_name_suffix:",
    "playwright_mode:",
    "sbom_mode:",
    "wait_for_completion:",
    "Run deterministic Omar Gate fallback",
    "provider_outage_break_glass",
    "Select Omar Gate result",
)

REQUIRED_ACTION_INPUTS = {
    "publish_github": '"false"',
    "comment_tag": "${{ format('omar-gate-{0}-{1}', github.run_id, github.run_attempt) }}",
    "severity_gate": "none",
    "llm_failure_policy": "block",
    "rate_limit_fail_mode": "closed",
}

REQUIRED_EVIDENCE_OUTPUTS = (
    "llm_attempted",
    "llm_success",
    "llm_output_valid",
    "llm_no_findings_reported",
    "llm_findings_count",
    "llm_parse_error_count",
    "llm_failure_class",
    "findings_artifact",
    "pack_summary_artifact",
    "idempotency_key",
    "scan_mode",
    "policy_pack",
    "policy_pack_version",
)


def _is_job_start(line: str) -> bool:
    stripped = line.strip()
    return (
        line.startswith("  ")
        and not line.startswith("    ")
        and stripped.endswith(":")
        and stripped[:-1].replace("_", "").replace("-", "").isalnum()
    )


def _find_job_lines(lines: list[str], job_name: str) -> list[str]:
    expected = f"  {job_name}:"
    try:
        start = next(index for index, line in enumerate(lines) if line.rstrip() == expected)
    except StopIteration as exc:
        raise OmarWorkflowContractError(f"omar-gate.yml is missing jobs.{job_name}") from exc

    end = len(lines)
    for index in range(start + 1, len(lines)):
        if _is_job_start(lines[index]):
            end = index
            break
    return lines[start:end]


def _permissions_block_has(
    lines: list[str], header: str, indent: str, permission: str
) -> bool:
    try:
        start = next(index for index, line in enumerate(lines) if line.rstrip() == header)
    except StopIteration:
        return False

    for line in lines[start + 1 :]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith(indent):
            break
        if line.split("#", 1)[0].strip() == permission:
            return True
    return False


def _extract_action_step(lines: list[str]) -> tuple[list[str], dict[str, str]]:
    action_indexes = [
        index
        for index, line in enumerate(lines)
        if line.split("#", 1)[0].strip() == f"uses: {ACTION_REF}"
    ]
    if len(action_indexes) != 1:
        raise OmarWorkflowContractError(
            f"Omar workflow must invoke the exact Action once (found {len(action_indexes)})"
        )

    action_index = action_indexes[0]
    step_start = action_index
    while step_start > 0 and not lines[step_start].lstrip().startswith("- name:"):
        step_start -= 1

    step_end = len(lines)
    step_indent = len(lines[step_start]) - len(lines[step_start].lstrip())
    for index in range(action_index + 1, len(lines)):
        stripped = lines[index].lstrip()
        indent = len(lines[index]) - len(stripped)
        if indent == step_indent and stripped.startswith("- name:"):
            step_end = index
            break

    step = lines[step_start:step_end]
    with_index = next(
        (index for index, line in enumerate(step) if line.strip() == "with:"), None
    )
    if with_index is None:
        raise OmarWorkflowContractError("Omar Action step is missing its with block")

    with_indent = len(step[with_index]) - len(step[with_index].lstrip())
    inputs: dict[str, str] = {}
    for line in step[with_index + 1 :]:
        stripped = line.split("#", 1)[0].strip()
        if not stripped:
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= with_indent:
            break
        if ":" not in stripped:
            continue
        name, value = stripped.split(":", 1)
        inputs[name.strip()] = value.strip()
    return step, inputs


def _extract_named_step(lines: list[str], name: str) -> list[str]:
    target = f"- name: {name}"
    indexes = [
        index
        for index, line in enumerate(lines)
        if line.split("#", 1)[0].strip() == target
    ]
    if len(indexes) != 1:
        raise OmarWorkflowContractError(
            f"Omar workflow must contain exactly one {name!r} step"
        )
    start = indexes[0]
    step_indent = len(lines[start]) - len(lines[start].lstrip())
    end = len(lines)
    for index in range(start + 1, len(lines)):
        stripped = lines[index].lstrip()
        indent = len(lines[index]) - len(stripped)
        if indent == step_indent and stripped.startswith("- "):
            end = index
            break
    return lines[start:end]


def _extract_run_script(step: list[str], name: str) -> str:
    run_indexes = [index for index, line in enumerate(step) if line.strip() == "run: |"]
    if len(run_indexes) != 1:
        raise OmarWorkflowContractError(f"{name!r} must use one literal run block")
    run_index = run_indexes[0]
    run_indent = len(step[run_index]) - len(step[run_index].lstrip())
    commands: list[str] = []
    for line in step[run_index + 1 :]:
        if line.strip() and len(line) - len(line.lstrip()) <= run_indent:
            break
        command = line[run_indent + 2 :] if len(line) > run_indent + 2 else ""
        command = command.split("#", 1)[0].rstrip()
        if command.strip():
            commands.append(command)
    return "\n".join(commands)


def _require_step_script_fragments(
    lines: list[str], name: str, fragments: tuple[str, ...]
) -> None:
    script = _extract_run_script(_extract_named_step(lines, name), name)
    for fragment in fragments:
        if fragment not in script:
            raise OmarWorkflowContractError(
                f"{name!r} command is missing required enforcement: {fragment}"
            )


def _require_fragments(text: str, fragments: tuple[str, ...]) -> None:
    for fragment in fragments:
        if fragment not in text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml is missing evidence-contract fragment: {fragment}"
            )


def validate_omar_contract(workflow_text: str) -> None:
    for marker in FORBIDDEN_MARKERS:
        if marker in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml contains retired or non-authoritative surface: {marker}"
            )

    lines = workflow_text.splitlines()
    if not _permissions_block_has(lines, "permissions:", "  ", "id-token: write"):
        raise OmarWorkflowContractError("top-level permissions must include id-token: write")

    omar_scan_lines = _find_job_lines(lines, "omar_scan")
    omar_scan_text = "\n".join(omar_scan_lines)
    if "    name: Omar Gate (Deep Scan)" not in omar_scan_text:
        raise OmarWorkflowContractError(
            "jobs.omar_scan.name must remain 'Omar Gate (Deep Scan)'"
        )
    if not _permissions_block_has(
        omar_scan_lines, "    permissions:", "      ", "id-token: write"
    ):
        raise OmarWorkflowContractError("jobs.omar_scan.permissions must include id-token: write")

    action_step, action_inputs = _extract_action_step(omar_scan_lines)
    if "continue-on-error: true" not in "\n".join(action_step):
        raise OmarWorkflowContractError(
            "Omar Action must continue so invalid evidence can be retained before final failure"
        )
    for name, expected in REQUIRED_ACTION_INPUTS.items():
        actual = action_inputs.get(name)
        if actual != expected:
            raise OmarWorkflowContractError(
                f"Omar Action input {name} must be {expected!r} (got {actual!r})"
            )

    mode_options = set(
        re.findall(r"^\s{10}-\s+(pr-diff|deep|nightly|baseline|audit|full-depth)\s*$", workflow_text, re.MULTILINE)
    )
    if mode_options != {"pr-diff", "deep", "nightly"}:
        raise OmarWorkflowContractError(
            "workflow_dispatch scan modes must be exactly pr-diff, deep, and nightly"
        )

    _require_fragments(
        workflow_text,
        (
            "Validate Omar configuration invariants",
            "Validate Omar workflow contract",
            "check_omar_workflow_contract.py --self-test",
            "Bind Omar scan provenance",
            "persist-credentials: false",
            "github.event.pull_request.head.sha",
            "github.workflow_sha",
            "workflow_file_sha256",
            "validator_sha256",
            "OMAR_EVENT_NAME: ${{ github.event_name }}",
            'event_name: env("OMAR_EVENT_NAME")',
            "Build Omar evidence manifest",
            "action-evidence-input.json",
            "idempotency_key: ${{ steps.omar_result.outputs.idempotency_key }}",
            "Validate live Omar evidence",
            f"node {VALIDATOR_PATH}",
            "--input omar-validation/action-evidence-input.json",
            '--workspace-root "${GITHUB_WORKSPACE}"',
            '--expected-subject-sha "${EXPECTED_SUBJECT_SHA}"',
            '--expected-workflow-sha "${EXPECTED_WORKFLOW_SHA}"',
            '--expected-workflow-ref "${EXPECTED_WORKFLOW_REF}"',
            "--summary-out omar-validation/validated-evidence.json",
            '--github-output "${GITHUB_OUTPUT}"',
            "Stage Omar artifacts",
            "omar-artifacts/original/PACK_SUMMARY.json",
            "omar-artifacts/original/FINDINGS.jsonl",
            "staged_pack_sha256",
            "staged_findings_sha256",
            "Seal and scan staged Omar artifacts",
            '--manifest "${manifest}"',
            '--expected-manifest "${embedded_manifest}"',
            "archive-files.nul",
            "--verbatim-files-from",
            "--no-recursion",
            "extracted_pack_sha256",
            "extracted_findings_sha256",
            'archive_path="omar-upload/omar-gate-artifacts-${archive_sha256}.tar"',
            "path: ${{ steps.artifact_secret_scan.outputs.archive_path }}",
            "if-no-files-found: error",
            "compression-level: 0",
            "Verify sealed artifact handoff",
            "Download uploaded Omar artifact for verification",
            "artifact-ids: ${{ steps.artifact_upload.outputs.artifact-id }}",
            "merge-multiple: true",
            "downloaded_sha256",
            "OMAR_UPLOAD_DIGEST",
            "OMAR_ARTIFACT_DOWNLOAD_OUTCOME",
            "OMAR_ARTIFACT_HANDOFF_OUTCOME",
            "archive_sha256: ${{ steps.artifact_secret_scan.outputs.archive_sha256 }}",
            "artifact_id: ${{ steps.artifact_upload.outputs.artifact-id }}",
            "upload_digest: ${{ steps.artifact_upload.outputs.artifact-digest }}",
            "Enforce validated Omar evidence",
            "Omar Action evidence validation failed closed",
            "Fork Omar scan is diagnostic only",
            "Trusted exact-subject promotion is required before merge",
            ACTION_REF,
        ),
    )
    for helper_ref in (CHECKOUT_REF, UPLOAD_REF, DOWNLOAD_REF):
        helper_count = sum(
            1
            for line in omar_scan_lines
            if line.split("#", 1)[0].strip().removeprefix("- ")
            == f"uses: {helper_ref}"
        )
        if helper_count != 1:
            raise OmarWorkflowContractError(
                f"jobs.omar_scan must invoke exact helper Action {helper_ref} once"
            )
    _require_step_script_fragments(
        omar_scan_lines,
        "Enforce validated Omar evidence",
        (
            'if [ "${OMAR_ACTION_OUTCOME}" != "success" ]; then',
            'if [ "${OMAR_VALIDATION_OUTCOME}" != "success" ]; then',
            "OMAR_SECRET_SCAN_OUTCOME",
            "OMAR_ARTIFACT_UPLOAD_OUTCOME",
            "OMAR_ARTIFACT_DOWNLOAD_OUTCOME",
            "OMAR_ARTIFACT_HANDOFF_OUTCOME",
            "exit 1",
        ),
    )
    for output in REQUIRED_EVIDENCE_OUTPUTS:
        if f"steps.omar.outputs.{output}" not in workflow_text:
            raise OmarWorkflowContractError(
                f"Omar workflow does not consume Action evidence output {output}"
            )

    if workflow_text.index("Validate Omar workflow contract") > workflow_text.index(
        "Run Omar Gate"
    ):
        raise OmarWorkflowContractError(
            "workflow contract validation must run before Omar consumes scan quota"
        )
    if workflow_text.index("Enforce validated Omar evidence") < workflow_text.index(
        "Verify sealed artifact handoff"
    ):
        raise OmarWorkflowContractError(
            "final evidence enforcement must run after safe artifact retention"
        )

    enforcer = "\n".join(_find_job_lines(lines, "omar_enforce"))
    _require_fragments(
        enforcer,
        (
            "if: ${{ always() }}",
            "Require authoritative Omar scan success",
            "Trusted Omar scan did not succeed",
            "Fork Omar scan is diagnostic only",
        ),
    )
    _require_step_script_fragments(
        _find_job_lines(lines, "omar_enforce"),
        "Enforce Omar reviewer merge thresholds",
        (
            'case "${effective_gate}" in',
            '"${p0}"',
            '"${p1}"',
            '"${p2}"',
            "exit 1",
        ),
    )


def _assert_fails(workflow_text: str, label: str) -> None:
    try:
        validate_omar_contract(workflow_text)
    except OmarWorkflowContractError:
        return
    raise AssertionError(f"invalid Omar workflow should fail validation: {label}")


def _replace_step_run_with_noop(workflow_text: str, name: str) -> str:
    lines = workflow_text.splitlines()
    step = _extract_named_step(lines, name)
    target = f"- name: {name}"
    start = next(index for index, line in enumerate(lines) if line.strip() == target)
    run_relative = next(index for index, line in enumerate(step) if line.strip() == "run: |")
    run_index = start + run_relative
    run_indent = len(lines[run_index]) - len(lines[run_index].lstrip())
    end = run_index + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and len(line) - len(line.lstrip()) <= run_indent:
            break
        end += 1
    replacement = [*lines[: run_index + 1], f"{' ' * (run_indent + 2)}true", *lines[end:]]
    return "\n".join(replacement) + "\n"


def _run_self_tests() -> None:
    path = Path(".github/workflows/omar-gate.yml")
    if not path.is_file():
        raise AssertionError("self-test requires .github/workflows/omar-gate.yml")
    valid_workflow = path.read_text(encoding="utf-8")
    validate_omar_contract(valid_workflow)

    mutations = (
        ("old action pin", valid_workflow.replace(ACTION_SHA, "a496be33a466c0cc3f8616d66bbd7d78f7d3c31d")),
        ("action severity", valid_workflow.replace("severity_gate: none", "severity_gate: P1")),
        ("deterministic fallback", valid_workflow.replace("llm_failure_policy: block", "llm_failure_policy: deterministic_only")),
        ("action publishing", valid_workflow.replace('publish_github: "false"', 'publish_github: "true"')),
        ("static comment tag", valid_workflow.replace("${{ format('omar-gate-{0}-{1}', github.run_id, github.run_attempt) }}", "omar-gate")),
        ("missing idempotency evidence", valid_workflow.replace("OMAR_IDEMPOTENCY_KEY: ${{ steps.omar.outputs.idempotency_key || '' }}", "")),
        ("missing evidence output", valid_workflow.replace("OMAR_LLM_OUTPUT_VALID: ${{ steps.omar.outputs.llm_output_valid || '' }}", "")),
        ("validator replacement", valid_workflow.replace(f"node {VALIDATOR_PATH}", "node scripts/fake-validator.mjs")),
        ("optional artifact", valid_workflow.replace("if-no-files-found: error", "if-no-files-found: ignore")),
        ("mutable artifact upload", valid_workflow.replace("path: ${{ steps.artifact_secret_scan.outputs.archive_path }}", "path: omar-artifacts/**")),
        ("unstaged validated digest", valid_workflow.replace("staged_pack_sha256", "unchecked_pack_sha256")),
        ("unbound artifact download", valid_workflow.replace("artifact-ids: ${{ steps.artifact_upload.outputs.artifact-id }}", "name: omar-gate-artifacts")),
        ("missing downloaded byte verification", valid_workflow.replace("downloaded_sha256", "unchecked_download_sha256")),
        ("missing archive manifest verification", valid_workflow.replace('--expected-manifest "${embedded_manifest}"', "")),
        ("missing archive handoff enforcement", valid_workflow.replace("OMAR_ARTIFACT_HANDOFF_OUTCOME", "OMAR_ARTIFACT_HANDOFF_BYPASS")),
        ("fork authority", valid_workflow.replace("Fork Omar scan is diagnostic only", "Fork Omar scan passed")),
        ("invalid hosted mode", valid_workflow.replace("          - pr-diff\n", "          - baseline\n")),
        ("unsupported action input", valid_workflow.replace("          llm_failure_policy: block\n", "          llm_failure_policy: block\n          artifact_name_suffix: fallback\n")),
        (
            "no-op evidence gate",
            _replace_step_run_with_noop(valid_workflow, "Enforce validated Omar evidence"),
        ),
        (
            "no-op severity gate",
            _replace_step_run_with_noop(
                valid_workflow,
                "Enforce Omar reviewer merge thresholds",
            ),
        ),
        ("mutable checkout", valid_workflow.replace(CHECKOUT_REF, "actions/checkout@v4")),
        ("mutable upload", valid_workflow.replace(UPLOAD_REF, "actions/upload-artifact@v4")),
        ("mutable download", valid_workflow.replace(DOWNLOAD_REF, "actions/download-artifact@v4")),
    )
    for label, mutated in mutations:
        _assert_fails(mutated, label)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify create-sentinelayer consumes exact live Omar evidence."
    )
    parser.add_argument("--workflow", default=".github/workflows/omar-gate.yml")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.self_test:
            _run_self_tests()
        validate_omar_contract(Path(args.workflow).read_text(encoding="utf-8"))
    except (OmarWorkflowContractError, AssertionError) as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

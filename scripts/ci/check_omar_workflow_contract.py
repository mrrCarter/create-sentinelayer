from __future__ import annotations

import argparse
import sys
from pathlib import Path


class OmarWorkflowContractError(ValueError):
    pass


BRIDGE_OR_BROKEN_MARKERS = (
    "GitHub App bridge",
    "thin GitHub App bridge",
    "Playwright + SBOM + model policy",
    "721bc7efe1402fcce416becea3d247b838119ed2",
    "fc444dee5bab4c79136775eb6930f1dea020d07c",
    "c82f840313be35fd74f88c7b0c62e7769f806042",
)


def _line_has_managed_llm_enabled(line: str) -> bool:
    normalized = line.split("#", 1)[0].strip().lower().replace("'", '"')
    return normalized in {
        'sentinelayer_managed_llm: "true"',
        "sentinelayer_managed_llm: true",
    }


def _is_job_start(line: str) -> bool:
    stripped = line.strip()
    return (
        line.startswith("  ")
        and not line.startswith("    ")
        and stripped.endswith(":")
        and stripped[:-1].replace("_", "").replace("-", "").isalnum()
    )


def _find_job_lines(lines: list[str], job_name: str) -> list[str]:
    start = None
    expected = f"  {job_name}:"
    for index, line in enumerate(lines):
        if line.rstrip() == expected:
            start = index
            break

    if start is None:
        raise OmarWorkflowContractError(f"omar-gate.yml is missing jobs.{job_name}")

    end = len(lines)
    for index in range(start + 1, len(lines)):
        if _is_job_start(lines[index]):
            end = index
            break

    return lines[start:end]


def _permissions_block_has(lines: list[str], header: str, indent: str, permission: str) -> bool:
    permissions_start = None
    for index, line in enumerate(lines):
        if line.rstrip() == header:
            permissions_start = index
            break

    if permissions_start is None:
        return False

    for line in lines[permissions_start + 1 :]:
        if line.strip() == "" or line.lstrip().startswith("#"):
            continue
        if not line.startswith(indent):
            break
        if line.split("#", 1)[0].strip() == permission:
            return True

    return False


def _reject_bridge_or_provider_inputs(text: str) -> None:
    for marker in BRIDGE_OR_BROKEN_MARKERS:
        if marker in text:
            raise OmarWorkflowContractError(
                f"Omar workflow references bridge or broken Omar marker: {marker}"
            )

    for line in text.splitlines():
        stripped = line.split("#", 1)[0].strip()
        if stripped.startswith("pr_number:"):
            raise OmarWorkflowContractError(
                "full Omar action workflow must not pass bridge-only pr_number"
            )
        if stripped.startswith(
            (
                "openai_api_key:",
                "anthropic_api_key:",
                "google_api_key:",
                "xai_api_key:",
                "llm_provider:",
            )
        ):
            raise OmarWorkflowContractError(
                "full Omar action workflow must not pass unsupported provider-key inputs"
            )
        if stripped.startswith("sentinelayer_managed_llm:") and "${{" in stripped:
            raise OmarWorkflowContractError("sentinelayer_managed_llm must be literal")


def validate_omar_contract(workflow_text: str) -> None:
    _reject_bridge_or_provider_inputs(workflow_text)

    if "./.github/actions/omar-gate" in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must call sentinelayer-v1-action directly, not a local wrapper"
        )
    if "mrrCarter/sentinelayer-v1-action@4cb3063e04e3b899981b25f6918b26f70d35a8d4" not in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must use the pinned sentinelayer-v1-action directly"
        )
    if not any(_line_has_managed_llm_enabled(line) for line in workflow_text.splitlines()):
        raise OmarWorkflowContractError(
            'Omar workflow must configure sentinelayer_managed_llm: "true"'
        )

    workflow_lines = workflow_text.splitlines()
    if not _permissions_block_has(workflow_lines, "permissions:", "  ", "id-token: write"):
        raise OmarWorkflowContractError("top-level permissions must include id-token: write")

    omar_scan_lines = _find_job_lines(workflow_lines, "omar_scan")
    if "    name: Omar Gate (Deep Scan)" not in "\n".join(omar_scan_lines):
        raise OmarWorkflowContractError(
            "jobs.omar_scan.name must be 'Omar Gate (Deep Scan)' for GitHub visibility"
        )
    if not _permissions_block_has(omar_scan_lines, "    permissions:", "      ", "id-token: write"):
        raise OmarWorkflowContractError("jobs.omar_scan.permissions must include id-token: write")

    forbidden_comment_fragments = (
        "Wait for authoritative Omar Gate review surface",
        "wait_for_" + "authoritative" + "_omar_review.py",
        "sentinelayer-omar-" + "summary",
        "--summary-out",
        "--upsert" + "-comment",
    )
    for fragment in forbidden_comment_fragments:
        if fragment in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml must not require PR summary-comment evidence: {fragment}"
            )

    required_direct_fragments = (
        "Validate Omar configuration invariants",
        "OMAR_SPEC_ID must be a 64-character lowercase hex digest",
        "Validate Omar workflow contract",
        "check_omar_workflow_contract.py --self-test",
        "check_forbidden_omar_surface.py --self-test",
        "check_forbidden_omar_surface.py",
        "Run Omar Gate",
        "Assert Omar LLM model contract is active",
        'REQUESTED_MANAGED_LLM: "true"',
        "REQUESTED_FAILURE_POLICY: block",
        "Omar LLM model outputs missing",
        "Omar LLM model contract active",
        "Stage Omar artifacts",
        "Upload Omar artifacts",
        "actions/upload-artifact",
        "omar-artifacts/**",
    )
    for fragment in required_direct_fragments:
        if fragment not in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml is missing direct Omar Gate evidence fragment: {fragment}"
            )

    required_enforcer_fragments = (
        "omar_enforce:",
        "if: ${{ always() }}",
        "Require selected Omar scan success",
        "Trusted Omar scan did not succeed",
        "Untrusted Omar scan did not succeed",
    )
    for fragment in required_enforcer_fragments:
        if fragment not in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml is missing fail-closed Omar enforcer fragment: {fragment}"
            )

    if workflow_text.index("Validate Omar workflow contract") > workflow_text.index("Run Omar Gate"):
        raise OmarWorkflowContractError(
            "workflow contract validation must run before Omar consumes scan quota"
        )
    if workflow_text.index("Validate Omar configuration invariants") > workflow_text.index("Run Omar Gate"):
        raise OmarWorkflowContractError(
            "workflow configuration validation must run before Omar consumes scan quota"
        )


def _assert_fails(workflow_text: str) -> None:
    try:
        validate_omar_contract(workflow_text)
    except OmarWorkflowContractError:
        return
    raise AssertionError("invalid Omar workflow should fail validation")


def _run_self_tests() -> None:
    valid_workflow = """
name: Omar Gate
permissions:
  contents: read
  id-token: write
jobs:
  omar_scan:
    name: Omar Gate (Deep Scan)
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Validate Omar workflow contract
        run: |
          python3 scripts/ci/check_omar_workflow_contract.py --self-test
          python3 scripts/ci/check_forbidden_omar_surface.py --self-test
          python3 scripts/ci/check_forbidden_omar_surface.py
      - name: Validate Omar configuration invariants
        run: |
          echo "OMAR_SPEC_ID must be a 64-character lowercase hex digest"
      - name: Run Omar Gate
        id: omar
        uses: mrrCarter/sentinelayer-v1-action@4cb3063e04e3b899981b25f6918b26f70d35a8d4
        with:
          sentinelayer_managed_llm: "true"
      - name: Assert Omar LLM model contract is active
        env:
          REQUESTED_MANAGED_LLM: "true"
          REQUESTED_FAILURE_POLICY: block
        run: |
          echo "Omar LLM model outputs missing"
          echo "Omar LLM model contract active"
      - name: Stage Omar artifacts
        run: echo stage
      - name: Upload Omar artifacts
        uses: actions/upload-artifact@50769540e7f4bd5e21e526ee35c689e35e0d6874
        with:
          path: omar-artifacts/**
  omar_enforce:
    name: Omar Gate
    if: ${{ always() }}
    steps:
      - name: Require selected Omar scan success
        run: |
          echo "Trusted Omar scan did not succeed"
          echo "Untrusted Omar scan did not succeed"
"""
    validate_omar_contract(valid_workflow)

    _assert_fails(
        valid_workflow.replace('sentinelayer_managed_llm: "true"', ""),
    )
    _assert_fails(
        valid_workflow.replace("if: ${{ always() }}", "if: ${{ needs.omar_scan.result == 'success' }}"),
    )
    _assert_fails(valid_workflow.replace("Omar Gate (Deep Scan)", "Omar Gate Scan"))
    _assert_fails(valid_workflow.replace("actions/upload-artifact", "actions/cache"))
    _assert_fails(valid_workflow.replace("mrrCarter/sentinelayer-v1-action@", "./.github/actions/omar-gate # "))
    _assert_fails(
        valid_workflow.replace(
            'sentinelayer_managed_llm: "true"',
            "google_api_key: ${{ secrets.GOOGLE_API_KEY }}\n          sentinelayer_managed_llm: \"false\"",
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify create-sentinelayer Omar workflow uses authoritative managed Omar directly."
    )
    parser.add_argument("--workflow", default=".github/workflows/omar-gate.yml")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        _run_self_tests()

    try:
        validate_omar_contract(Path(args.workflow).read_text(encoding="utf-8"))
    except OmarWorkflowContractError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

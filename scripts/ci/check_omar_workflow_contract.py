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


def validate_omar_contract(workflow_text: str, wrapper_text: str) -> None:
    _reject_bridge_or_provider_inputs(workflow_text)
    _reject_bridge_or_provider_inputs(wrapper_text)

    if not any(_line_has_managed_llm_enabled(line) for line in wrapper_text.splitlines()):
        raise OmarWorkflowContractError(
            'local Omar wrapper must configure sentinelayer_managed_llm: "true"'
        )

    workflow_lines = workflow_text.splitlines()
    if not _permissions_block_has(workflow_lines, "permissions:", "  ", "id-token: write"):
        raise OmarWorkflowContractError("top-level permissions must include id-token: write")

    omar_scan_lines = _find_job_lines(workflow_lines, "omar_scan")
    for permission in ("id-token: write", "issues: write"):
        if not _permissions_block_has(omar_scan_lines, "    permissions:", "      ", permission):
            raise OmarWorkflowContractError(
                f"jobs.omar_scan.permissions must include {permission}"
            )

    required_authoritative_fragments = (
        "Validate authoritative Omar helper syntax",
        "check_omar_workflow_contract.py --self-test",
        "wait_for_authoritative_omar_review.py --self-test",
        "Wait for authoritative Omar Gate review surface",
        "wait_for_authoritative_omar_review.py",
        "--summary-out",
        "--upsert-comment",
    )
    for fragment in required_authoritative_fragments:
        if fragment not in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml is missing authoritative Omar review fragment: {fragment}"
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

    if workflow_text.index("Validate authoritative Omar helper syntax") > workflow_text.index("Run Omar Gate"):
        raise OmarWorkflowContractError(
            "authoritative helper validation must run before Omar consumes scan quota"
        )


def _assert_fails(workflow_text: str, wrapper_text: str) -> None:
    try:
        validate_omar_contract(workflow_text, wrapper_text)
    except OmarWorkflowContractError:
        return
    raise AssertionError("invalid Omar workflow should fail validation")


def _run_self_tests() -> None:
    wrapper = """
name: Omar Gate Wrapper
runs:
  using: composite
  steps:
    - uses: mrrCarter/sentinelayer-v1-action@4cb3063e04e3b899981b25f6918b26f70d35a8d4
      with:
        sentinelayer_managed_llm: "true"
"""
    valid_workflow = """
name: Omar Gate
permissions:
  contents: read
  id-token: write
jobs:
  omar_scan:
    permissions:
      contents: read
      id-token: write
      issues: write
    steps:
      - name: Validate authoritative Omar helper syntax
        run: |
          python3 scripts/ci/check_omar_workflow_contract.py --self-test
          python3 scripts/ci/wait_for_authoritative_omar_review.py --self-test
      - name: Run Omar Gate
        id: omar
        uses: ./.github/actions/omar-gate
      - name: Wait for authoritative Omar Gate review surface
        run: python3 scripts/ci/wait_for_authoritative_omar_review.py --summary-out /tmp/summary.json --upsert-comment
  omar_enforce:
    name: Omar Gate
    if: ${{ always() }}
    steps:
      - name: Require selected Omar scan success
        run: |
          echo "Trusted Omar scan did not succeed"
          echo "Untrusted Omar scan did not succeed"
"""
    validate_omar_contract(valid_workflow, wrapper)

    _assert_fails(valid_workflow, wrapper.replace('sentinelayer_managed_llm: "true"', ""))
    _assert_fails(
        valid_workflow.replace("if: ${{ always() }}", "if: ${{ needs.omar_scan.result == 'success' }}"),
        wrapper,
    )
    _assert_fails(valid_workflow.replace("Wait for authoritative Omar Gate review surface", ""), wrapper)
    _assert_fails(
        valid_workflow,
        wrapper.replace(
            "sentinelayer_managed_llm: \"true\"",
            "google_api_key: ${{ secrets.GOOGLE_API_KEY }}\n        sentinelayer_managed_llm: \"false\"",
        ),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify create-sentinelayer Omar workflow/wrapper uses authoritative managed Omar."
    )
    parser.add_argument("--workflow", default=".github/workflows/omar-gate.yml")
    parser.add_argument("--wrapper", default=".github/actions/omar-gate/action.yml")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        _run_self_tests()

    try:
        validate_omar_contract(
            Path(args.workflow).read_text(encoding="utf-8"),
            Path(args.wrapper).read_text(encoding="utf-8"),
        )
    except OmarWorkflowContractError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

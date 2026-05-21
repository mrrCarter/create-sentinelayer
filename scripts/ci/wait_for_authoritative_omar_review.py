from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


AUTHORITATIVE_COMMENT_MARKER = "<!-- sentinelayer:omar-gate:authoritative-review -->"
MAM_CHECK_NAME = "Omar Multi-Agent Review"
SENTINELAYER_SUMMARY_MARKER = "<!-- sentinelayer-omar-summary"
LEGACY_OMAR_MARKER = "<!-- sentinelayer:omar-gate:"
SENTINELAYER_COMMENT_AUTHORS = {"sentinelayer", "sentinelayer[bot]"}
BRIDGE_ONLY_MARKERS = (
    "Omar Gate Action v1 is a thin GitHub App bridge",
    "Execute Omar Gate Compatibility Bridge",
    "Compatibility action that delegates scans",
)


class OmarReviewError(RuntimeError):
    pass


class OmarReviewPending(RuntimeError):
    pass


@dataclass(frozen=True)
class AuthoritativeReview:
    run_id: str
    check_name: str
    check_conclusion: str
    check_details_url: str
    check_summary: str
    comment_id: int
    comment_url: str
    comment_body: str
    comment_updated_at: str
    severity_counts: dict[str, int]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_time(value: str | None) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=timezone.utc)
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _extract_severity_counts(text: str) -> dict[str, int]:
    counts = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
    for key in counts:
        match = re.search(rf"\b{key}\s*=\s*(\d+)\b", text or "", flags=re.IGNORECASE)
        if match:
            counts[key] = int(match.group(1))
    return counts


def _comment_references_run(body: str, run_id: str) -> bool:
    if not run_id:
        return True
    return run_id.lower() in body.lower()


def _is_authoritative_summary_comment(body: str, run_id: str = "") -> bool:
    normalized = body or ""
    if not normalized.strip():
        return False
    if any(marker.lower() in normalized.lower() for marker in BRIDGE_ONLY_MARKERS):
        return False
    has_summary_marker = SENTINELAYER_SUMMARY_MARKER in normalized
    has_legacy_marker = LEGACY_OMAR_MARKER in normalized
    if not (has_summary_marker or has_legacy_marker):
        return False
    has_supported_heading = (
        "### Omar Gate Review" in normalized
        or "### Omar Multi-Agent Review" in normalized
    )
    required_fragments = (
        "**Status:**",
        "**Findings:**",
        "#### Top Findings",
        "#### Coverage",
    )
    if not has_supported_heading:
        return False
    if not all(fragment in normalized for fragment in required_fragments):
        return False
    return _comment_references_run(normalized, run_id)


def _is_sentinelayer_comment_author(comment: dict[str, Any]) -> bool:
    user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
    login = str(user.get("login") or "").strip().lower()
    return login in SENTINELAYER_COMMENT_AUTHORS


def select_mam_check(check_runs: list[dict[str, Any]], run_id: str = "") -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []
    for check in check_runs:
        if str(check.get("name") or "") != MAM_CHECK_NAME:
            continue
        app = check.get("app") if isinstance(check.get("app"), dict) else {}
        if str(app.get("slug") or "") != "sentinelayer":
            continue
        candidates.append(check)

    if not candidates:
        return None

    def _score(check: dict[str, Any]) -> tuple[int, int, datetime]:
        details_url = str(check.get("details_url") or "")
        output = check.get("output") if isinstance(check.get("output"), dict) else {}
        summary = str(output.get("summary") or "")
        run_match = 1 if run_id and run_id.lower() in f"{details_url}\n{summary}".lower() else 0
        success = 1 if str(check.get("conclusion") or "").lower() == "success" else 0
        timestamp = _parse_time(str(check.get("completed_at") or check.get("started_at") or ""))
        return (run_match, success, timestamp)

    return sorted(candidates, key=_score, reverse=True)[0]


def select_summary_comment(comments: list[dict[str, Any]], run_id: str = "") -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []
    for comment in comments:
        body = str(comment.get("body") or "")
        if _is_sentinelayer_comment_author(comment) and _is_authoritative_summary_comment(
            body,
            run_id=run_id,
        ):
            candidates.append(comment)

    if not candidates:
        return None

    return sorted(
        candidates,
        key=lambda comment: _parse_time(str(comment.get("updated_at") or comment.get("created_at") or "")),
        reverse=True,
    )[0]


def evaluate_authoritative_review(
    *,
    check_runs: list[dict[str, Any]],
    comments: list[dict[str, Any]],
    run_id: str,
) -> AuthoritativeReview:
    check = select_mam_check(check_runs, run_id=run_id)
    if check is None:
        raise OmarReviewPending(f"waiting for Sentinelayer `{MAM_CHECK_NAME}` check")

    status = str(check.get("status") or "").lower()
    conclusion = str(check.get("conclusion") or "").lower()
    if status != "completed":
        raise OmarReviewPending(f"`{MAM_CHECK_NAME}` check is {status or 'not completed'}")
    if conclusion != "success":
        if conclusion in {"", "neutral", "skipped"}:
            raise OmarReviewPending(
                f"`{MAM_CHECK_NAME}` check has non-authoritative `{conclusion or 'unknown'}` conclusion"
            )
        raise OmarReviewError(f"`{MAM_CHECK_NAME}` check concluded `{conclusion or 'unknown'}`")

    comment = select_summary_comment(comments, run_id=run_id)
    if comment is None:
        raise OmarReviewPending("waiting for authoritative Sentinelayer Omar summary PR comment")

    output = check.get("output") if isinstance(check.get("output"), dict) else {}
    summary = str(output.get("summary") or "")
    counts = _extract_severity_counts(summary)
    comment_body = str(comment.get("body") or "")
    if not any(counts.values()):
        counts = _extract_severity_counts(comment_body)

    return AuthoritativeReview(
        run_id=run_id,
        check_name=str(check.get("name") or MAM_CHECK_NAME),
        check_conclusion=conclusion,
        check_details_url=str(check.get("details_url") or ""),
        check_summary=summary,
        comment_id=_safe_int(comment.get("id")),
        comment_url=str(comment.get("html_url") or ""),
        comment_body=comment_body,
        comment_updated_at=str(comment.get("updated_at") or comment.get("created_at") or ""),
        severity_counts=counts,
    )


def build_authoritative_comment(
    *,
    review: AuthoritativeReview,
    repo: str,
    sha: str,
    workflow_url: str,
) -> str:
    counts = review.severity_counts
    return "\n".join(
        [
            AUTHORITATIVE_COMMENT_MARKER,
            "### Omar Gate Authoritative Review",
            "",
            "**Status:** passed after Sentinelayer review completion",
            "",
            f"- Repository: `{repo}`",
            f"- Head SHA: `{sha}`",
            f"- Sentinelayer review check: `{review.check_conclusion}`",
            f"- Findings: `P0={counts.get('P0', 0)} P1={counts.get('P1', 0)} P2={counts.get('P2', 0)} P3={counts.get('P3', 0)}`",
            f"- Sentinelayer run: `{review.run_id}`",
            f"- Review comment: {review.comment_url}",
            f"- Review dashboard: {review.check_details_url}",
            f"- Workflow run: {workflow_url}",
            "",
            "This comment is posted only after the workflow observes the Sentinelayer-owned review check and matching Omar Gate summary comment. Bridge-only/stub comments are ignored by the gate.",
            f"<!-- sentinelayer:omar-gate:authoritative-review:{review.run_id} -->",
            "",
        ]
    )


def run_self_test() -> None:
    run_id = "ghdeep_mrrcarter-create-sentinelayer_7007815d2f0ccbc6"
    check_runs = [
        {
            "name": MAM_CHECK_NAME,
            "app": {"slug": "sentinelayer"},
            "status": "completed",
            "conclusion": "success",
            "details_url": f"https://sentinelayer.com/dashboard/runs/{run_id}",
            "output": {
                "summary": f"Run {run_id} status=completed. P0=0 P1=1 P2=2 P3=3.",
            },
            "completed_at": "2026-05-21T08:42:58Z",
        }
    ]
    comments = [
        {
            "id": 4506267940,
            "user": {"login": "sentinelayer[bot]"},
            "html_url": "https://github.com/mrrCarter/create-sentinelayer/pull/491#issuecomment-4506267940",
            "updated_at": "2026-05-21T08:43:00Z",
            "body": f"""<!-- sentinelayer-omar-summary -->
### Omar Gate Review

**Status:** completed
**Findings:** 0 critical | 1 high | 2 medium | 3 low
**Confidence:** 74% (medium)
**Service Trust:** L3_persona_adjudicated

#### Top Findings
- Finding one

#### Coverage
- Investigation run: `{run_id}`

[View Full Report](https://sentinelayer.com/dashboard/runs/{run_id})

<!-- sentinelayer-omar-summary:{run_id} -->
""",
        }
    ]
    review = evaluate_authoritative_review(
        check_runs=check_runs,
        comments=comments,
        run_id=run_id,
    )
    neutral_check = dict(check_runs[0])
    neutral_check["conclusion"] = "neutral"
    try:
        evaluate_authoritative_review(
            check_runs=[neutral_check],
            comments=comments,
            run_id=run_id,
        )
    except OmarReviewPending:
        pass
    else:
        raise OmarReviewError("self-test failed: neutral MAM check was accepted")
    body = build_authoritative_comment(
        review=review,
        repo="mrrCarter/create-sentinelayer",
        sha="181fd6f3e5b37c674064bbde7f03f3a1e2cb6b0c",
        workflow_url="https://github.com/mrrCarter/create-sentinelayer/actions/runs/26219040672",
    )
    if AUTHORITATIVE_COMMENT_MARKER not in body:
        raise OmarReviewError("self-test failed: authoritative marker missing")
    if "MAM" in body or "Omar Multi-Agent Review" in body:
        raise OmarReviewError("self-test failed: old review wording leaked into authoritative comment")
    bridge_comment = dict(comments[0])
    bridge_comment["body"] += "\nOmar Gate Action v1 is a thin GitHub App bridge.\n"
    try:
        evaluate_authoritative_review(
            check_runs=check_runs,
            comments=[bridge_comment],
            run_id=run_id,
        )
    except OmarReviewPending:
        pass
    else:
        raise OmarReviewError("self-test failed: bridge-only summary was accepted")


class GitHubClient:
    def __init__(self, *, token: str, api_url: str = "https://api.github.com") -> None:
        self.token = token
        self.api_url = api_url.rstrip("/")

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        url = path if path.startswith("https://") else f"{self.api_url}{path}"
        data = None
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "create-sentinelayer-authoritative-omar-review",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=30) as response:
                text = response.read().decode("utf-8")
                if not text.strip():
                    return {}
                return json.loads(text)
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise OmarReviewError(f"GitHub API {method} {path} failed: HTTP {exc.code}: {body[:500]}") from exc
        except URLError as exc:
            raise OmarReviewError(f"GitHub API {method} {path} failed: {exc}") from exc

    def get_paginated(self, path: str, *, list_key: str | None = None) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page = 1
        while True:
            separator = "&" if "?" in path else "?"
            page_path = f"{path}{separator}{urlencode({'per_page': 100, 'page': page})}"
            payload = self._request("GET", page_path)
            batch = payload.get(list_key) if list_key else payload
            if not isinstance(batch, list):
                raise OmarReviewError(f"GitHub API response for {path} did not contain a list")
            items.extend(batch)
            if len(batch) < 100:
                return items
            page += 1

    def patch_comment(self, *, repo: str, comment_id: int, body: str) -> None:
        self._request("PATCH", f"/repos/{repo}/issues/comments/{comment_id}", {"body": body})

    def create_comment(self, *, repo: str, pr_number: int, body: str) -> None:
        self._request("POST", f"/repos/{repo}/issues/{pr_number}/comments", {"body": body})


def upsert_authoritative_comment(
    *,
    client: GitHubClient,
    repo: str,
    pr_number: int,
    body: str,
    comments: list[dict[str, Any]],
) -> str:
    existing = [
        comment
        for comment in comments
        if AUTHORITATIVE_COMMENT_MARKER in str(comment.get("body") or "")
    ]
    if existing:
        latest = sorted(
            existing,
            key=lambda comment: _parse_time(str(comment.get("updated_at") or comment.get("created_at") or "")),
            reverse=True,
        )[0]
        client.patch_comment(repo=repo, comment_id=_safe_int(latest.get("id")), body=body)
        return "updated"

    client.create_comment(repo=repo, pr_number=pr_number, body=body)
    return "created"


def _write_text(path: str, value: str) -> None:
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, encoding="utf-8")


def _write_json(path: str, value: dict[str, Any]) -> None:
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_current_state(*, client: GitHubClient, repo: str, sha: str, pr_number: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    check_runs = client.get_paginated(
        f"/repos/{repo}/commits/{sha}/check-runs?filter=latest",
        list_key="check_runs",
    )
    comments = client.get_paginated(f"/repos/{repo}/issues/{pr_number}/comments")
    return check_runs, comments


def wait_for_review(
    *,
    client: GitHubClient,
    repo: str,
    sha: str,
    pr_number: int,
    run_id: str,
    timeout_seconds: int,
    poll_seconds: int,
) -> tuple[AuthoritativeReview, list[dict[str, Any]]]:
    deadline = time.monotonic() + timeout_seconds
    last_pending = ""
    while True:
        check_runs, comments = _load_current_state(client=client, repo=repo, sha=sha, pr_number=pr_number)
        try:
            return evaluate_authoritative_review(check_runs=check_runs, comments=comments, run_id=run_id), comments
        except OmarReviewPending as exc:
            last_pending = str(exc)
            if time.monotonic() >= deadline:
                raise OmarReviewError(f"Timed out waiting for authoritative Omar review: {last_pending}") from exc
            print(f"Waiting for authoritative Omar review: {last_pending}", file=sys.stderr)
            time.sleep(max(1, poll_seconds))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Wait for the authoritative Sentinelayer Omar/MAM PR review surface.")
    parser.add_argument("--self-test", action="store_true", help="Run dependency-free contract checks and exit.")
    parser.add_argument("--repo", default="", help="GitHub repository, for example owner/name.")
    parser.add_argument("--sha", default="", help="PR head SHA to inspect for check-runs.")
    parser.add_argument("--pr-number", type=int, default=0, help="Pull request number.")
    parser.add_argument("--run-id", default="", help="Expected Sentinelayer Omar run id.")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--poll-seconds", type=int, default=15)
    parser.add_argument("--comment-out", default="")
    parser.add_argument("--summary-out", default="")
    parser.add_argument("--upsert-comment", action="store_true")
    parser.add_argument("--workflow-url", default=os.getenv("GITHUB_SERVER_URL", "https://github.com"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.self_test:
        run_self_test()
        print(json.dumps({"ok": True, "self_test": True}, sort_keys=True))
        return 0
    if not args.repo or not args.sha or not args.pr_number:
        raise OmarReviewError("--repo, --sha, and --pr-number are required unless --self-test is used")
    token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN")
    if not token:
        raise OmarReviewError("GH_TOKEN or GITHUB_TOKEN is required")

    client = GitHubClient(token=token, api_url=os.getenv("GITHUB_API_URL", "https://api.github.com"))
    review, comments = wait_for_review(
        client=client,
        repo=args.repo,
        sha=args.sha,
        pr_number=args.pr_number,
        run_id=args.run_id,
        timeout_seconds=max(1, args.timeout_seconds),
        poll_seconds=max(1, args.poll_seconds),
    )
    workflow_url = args.workflow_url
    if workflow_url == "https://github.com":
        run_id = os.getenv("GITHUB_RUN_ID", "")
        if run_id:
            workflow_url = f"https://github.com/{args.repo}/actions/runs/{run_id}"

    authoritative_body = build_authoritative_comment(
        review=review,
        repo=args.repo,
        sha=args.sha,
        workflow_url=workflow_url,
    )
    upsert_status = "skipped"
    if args.upsert_comment:
        upsert_status = upsert_authoritative_comment(
            client=client,
            repo=args.repo,
            pr_number=args.pr_number,
            body=authoritative_body,
            comments=comments,
        )

    _write_text(args.comment_out, review.comment_body)
    _write_json(
        args.summary_out,
        {
            "ok": True,
            "observed_at": _utc_now_iso(),
            "run_id": review.run_id,
            "check": {
                "name": review.check_name,
                "conclusion": review.check_conclusion,
                "details_url": review.check_details_url,
                "summary": review.check_summary,
            },
            "comment": {
                "id": review.comment_id,
                "url": review.comment_url,
                "updated_at": review.comment_updated_at,
            },
            "severity_counts": review.severity_counts,
            "workflow_comment": upsert_status,
        },
    )
    print(
        json.dumps(
            {
                "ok": True,
                "run_id": review.run_id,
                "check_conclusion": review.check_conclusion,
                "comment_url": review.comment_url,
                "workflow_comment": upsert_status,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OmarReviewError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        raise SystemExit(1)

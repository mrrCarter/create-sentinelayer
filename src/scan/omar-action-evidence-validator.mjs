import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  appendFile,
  link,
  lstat,
  open,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { pathToFileURL } from "node:url";

export const MANIFEST_SCHEMA_VERSION = "1.0";
export const PINNED_ACTION_SHA = "52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5";
export const PINNED_ACTION_REF =
  "mrrCarter/sentinelayer-v1-action@52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5";
export const VALIDATOR_LIMITS = Object.freeze({
  manifest_bytes: 1024 * 1024,
  pack_summary_bytes: 2 * 1024 * 1024,
  findings_bytes: 64 * 1024 * 1024,
  findings_count: 1_000_000,
});

const MAX_RUN_ID_LENGTH = 128;
const MAX_ARTIFACT_PATH_LENGTH = 4096;
const MAX_FINDING_RECORD_CHARS = 256 * 1024;
const MAX_FINDING_JSON_DEPTH = 16;
const MAX_FINDING_JSON_NODES = 10_000;
const MAX_FINDING_JSON_STRING_CHARS = 128 * 1024;
const SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
const SUPPORTED_EVENTS = Object.freeze([
  "pull_request",
  "push",
  "workflow_dispatch",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TOP_LEVEL_KEYS = Object.freeze(["action", "provenance", "schema_version"]);
const ACTION_KEYS = Object.freeze([
  "findings_artifact",
  "gate_status",
  "idempotency_key",
  "llm_attempted",
  "llm_failure_class",
  "llm_findings_count",
  "llm_no_findings_reported",
  "llm_output_valid",
  "llm_parse_error_count",
  "llm_success",
  "outcome",
  "p0_count",
  "p1_count",
  "p2_count",
  "p3_count",
  "pack_summary_artifact",
  "policy_pack",
  "policy_pack_version",
  "ref",
  "run_id",
  "scan_mode",
]);
const PROVENANCE_KEYS = Object.freeze([
  "comment_tag",
  "event_name",
  "github_run_attempt",
  "github_run_id",
  "pull_request_number",
  "repository",
  "subject_sha",
  "validator_sha256",
  "workflow_file_sha256",
  "workflow_ref",
  "workflow_sha",
]);

export class OmarActionEvidenceValidationError extends Error {
  constructor(code, field, message, exitCode = 1) {
    super(message);
    this.name = "OmarActionEvidenceValidationError";
    this.code = code;
    this.field = field;
    this.exitCode = exitCode;
  }

  toJSON() {
    return { code: this.code, field: this.field, message: this.message };
  }
}

function fail(code, field, message, exitCode = 1) {
  throw new OmarActionEvidenceValidationError(code, field, message, exitCode);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, field) {
  if (!isRecord(value)) {
    fail("TYPE_INVALID", field, "Expected a JSON object.");
  }
  return value;
}

function requireExactKeys(value, expected, field) {
  const actual = Object.keys(requireRecord(value, field)).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail("KEYS_INVALID", field, "Object keys do not match the required contract.");
  }
}

function requireString(value, field) {
  if (typeof value !== "string") {
    fail("TYPE_INVALID", field, "Expected a string.");
  }
  return value;
}

function requireCanonicalText(value, field, maximumLength) {
  const text = requireString(value, field);
  if (
    text.length === 0 ||
    text.length > maximumLength ||
    text !== text.trim() ||
    /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    fail("VALUE_UNSAFE", field, "Value is empty, unbounded, or contains unsafe characters.");
  }
  return text;
}

function parseGitHubBoolean(value, field) {
  const text = requireString(value, field);
  if (text !== "true" && text !== "false") {
    fail("BOOLEAN_INVALID", field, "Expected the canonical GitHub output string true or false.");
  }
  return text === "true";
}

function parseGitHubCount(value, field) {
  const text = requireString(value, field);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    fail("COUNT_INVALID", field, "Expected a canonical non-negative integer string.");
  }
  const count = Number(text);
  if (
    !Number.isSafeInteger(count) ||
    count > VALIDATOR_LIMITS.findings_count
  ) {
    fail("COUNT_INVALID", field, "Count is outside the supported bound.");
  }
  return count;
}

function parsePackCount(value, field) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > VALIDATOR_LIMITS.findings_count
  ) {
    fail("COUNT_INVALID", field, "Expected a bounded non-negative JSON integer.");
  }
  return value;
}

function normalizeHex(value, field, length) {
  const text = requireString(value, field);
  const pattern = new RegExp(`^[0-9a-fA-F]{${length}}$`, "u");
  if (!pattern.test(text)) {
    fail(
      "HASH_INVALID",
      field,
      `Expected a full ${length}-character hexadecimal hash.`,
    );
  }
  return text.toLowerCase();
}

function normalizePositiveDecimal(value, field) {
  const text = requireString(value, field);
  if (!/^[1-9][0-9]{0,19}$/u.test(text)) {
    fail("IDENTIFIER_INVALID", field, "Expected a bounded positive decimal string.");
  }
  return text;
}

function normalizeEventName(value) {
  const eventName = requireString(value, "provenance.event_name");
  if (!SUPPORTED_EVENTS.includes(eventName)) {
    fail(
      "EVENT_NAME_INVALID",
      "provenance.event_name",
      "Event name is not supported by the evidence contract.",
    );
  }
  return eventName;
}

function normalizePullRequestNumber(value, eventName) {
  const field = "provenance.pull_request_number";
  const text = requireString(value, field);
  if (eventName === "pull_request") {
    if (!/^[1-9][0-9]{0,19}$/u.test(text)) {
      fail(
        "PULL_REQUEST_NUMBER_INVALID",
        field,
        "Pull request events require a canonical positive pull request number.",
      );
    }
  } else if (text !== "0") {
    fail(
      "PULL_REQUEST_NUMBER_INVALID",
      field,
      "Push and workflow dispatch events require pull request number zero.",
    );
  }
  return text;
}

function normalizeRepository(value) {
  const repository = requireCanonicalText(value, "provenance.repository", 201);
  const parts = repository.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u.test(part),
    )
  ) {
    fail("REPOSITORY_INVALID", "provenance.repository", "Expected a canonical owner/repository.");
  }
  return repository;
}

function normalizeWorkflowRef(value, repository, field = "provenance.workflow_ref") {
  const workflowRef = requireCanonicalText(value, field, 512);
  const prefix = `${repository}/`;
  if (!workflowRef.startsWith(prefix)) {
    fail(
      "WORKFLOW_REF_INVALID",
      field,
      "Workflow reference must bind this repository.",
    );
  }
  const qualified = workflowRef.slice(prefix.length);
  const delimiter = qualified.lastIndexOf("@");
  const workflowPath = delimiter === -1 ? "" : qualified.slice(0, delimiter);
  const ref = delimiter === -1 ? "" : qualified.slice(delimiter + 1);
  const workflowSegments = workflowPath.split("/");
  if (
    !workflowPath.startsWith(".github/workflows/") ||
    !/\.ya?ml$/iu.test(workflowPath) ||
    workflowSegments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
  ) {
    fail("WORKFLOW_REF_INVALID", field, "Workflow path is outside the supported workflow root.");
  }
  if (
    ref.length === 0 ||
    ref.length > 255 ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("\\") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    !/^[A-Za-z0-9_./@-]+$/u.test(ref)
  ) {
    fail("WORKFLOW_REF_INVALID", field, "Workflow ref suffix is unsafe.");
  }
  return workflowRef;
}

function normalizeObservedValue(value, field) {
  const text = requireCanonicalText(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$/u.test(text)) {
    fail("OBSERVED_EVIDENCE_INVALID", field, "Observed evidence value is malformed.");
  }
  return text;
}

function normalizeCommentTag(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "");
}

export function computePinnedActionIdempotencyKey({
  repository,
  pullRequestNumber,
  headSha,
  scanMode,
  policyPack = "omar",
  policyPackVersion = "v1",
  commentTag = "",
}) {
  const payload = [
    repository,
    pullRequestNumber,
    headSha,
    scanMode,
    policyPack,
    policyPackVersion,
    "1",
    "llm-evidence-v1",
  ].join(":");
  const normalizedTag = normalizeCommentTag(commentTag);
  return sha256Hex(
    Buffer.from(normalizedTag ? `${payload}:${normalizedTag}` : payload, "utf8"),
  );
}

function normalizeManifest(manifest, options) {
  requireExactKeys(manifest, TOP_LEVEL_KEYS, "manifest");
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) {
    fail("SCHEMA_UNSUPPORTED", "schema_version", "Manifest schema version is unsupported.");
  }
  requireExactKeys(manifest.action, ACTION_KEYS, "action");
  const action = manifest.action;
  for (const key of ACTION_KEYS) {
    requireString(action[key], `action.${key}`);
  }
  if (action.ref !== PINNED_ACTION_REF) {
    fail("ACTION_REF_INVALID", "action.ref", "Action reference is not the required immutable pin.");
  }
  if (action.outcome !== "success") {
    fail("ACTION_OUTCOME_INVALID", "action.outcome", "Action step did not complete successfully.");
  }
  if (action.gate_status !== "passed") {
    fail("ACTION_GATE_INVALID", "action.gate_status", "Action gate status is not passed.");
  }

  const runId = requireString(action.run_id, "action.run_id");
  if (
    runId.length === 0 ||
    runId.length > MAX_RUN_ID_LENGTH ||
    runId !== runId.trim() ||
    /[\u0000-\u001f\u007f]/u.test(runId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)
  ) {
    fail("RUN_ID_INVALID", "action.run_id", "Run id is outside the bounded grammar.");
  }
  const idempotencyKey = normalizeHex(
    action.idempotency_key,
    "action.idempotency_key",
    64,
  );
  const scanMode = requireCanonicalText(action.scan_mode, "action.scan_mode", 16);
  if (!["pr-diff", "deep", "nightly"].includes(scanMode)) {
    fail("SCAN_MODE_INVALID", "action.scan_mode", "Hosted Action scan mode is unsupported.");
  }
  const policyPack = requireCanonicalText(action.policy_pack, "action.policy_pack", 64);
  const policyPackVersion = requireCanonicalText(
    action.policy_pack_version,
    "action.policy_pack_version",
    64,
  );
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(policyPack) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(policyPackVersion)
  ) {
    fail("POLICY_PACK_INVALID", "action", "Policy pack metadata is malformed.");
  }
  const counts = {};
  for (const severity of SEVERITIES) {
    const key = `${severity.toLowerCase()}_count`;
    counts[severity] = parseGitHubCount(action[key], `action.${key}`);
  }

  const attempted = parseGitHubBoolean(action.llm_attempted, "action.llm_attempted");
  const success = parseGitHubBoolean(action.llm_success, "action.llm_success");
  const outputValid = parseGitHubBoolean(
    action.llm_output_valid,
    "action.llm_output_valid",
  );
  const noFindingsReported = parseGitHubBoolean(
    action.llm_no_findings_reported,
    "action.llm_no_findings_reported",
  );
  const reportedFindingCount = parseGitHubCount(
    action.llm_findings_count,
    "action.llm_findings_count",
  );
  const parseErrorCount = parseGitHubCount(
    action.llm_parse_error_count,
    "action.llm_parse_error_count",
  );
  if (!attempted || !success || !outputValid) {
    fail("ACTION_LIVENESS_INVALID", "action", "Required live LLM outputs are not successful.");
  }
  if (parseErrorCount !== 0) {
    fail("ACTION_PARSE_ERRORS", "action.llm_parse_error_count", "Live output contains parse errors.");
  }
  const resultShapeValid =
    (reportedFindingCount > 0 && noFindingsReported === false) ||
    (reportedFindingCount === 0 && noFindingsReported === true);
  if (!resultShapeValid) {
    fail("ACTION_RESULT_SHAPE_INVALID", "action", "Live result shape is contradictory.");
  }
  if (action.llm_failure_class !== "") {
    fail(
      "ACTION_FAILURE_CONTRADICTION",
      "action.llm_failure_class",
      "A successful live result cannot retain a failure class.",
    );
  }
  requireCanonicalText(
    action.findings_artifact,
    "action.findings_artifact",
    MAX_ARTIFACT_PATH_LENGTH,
  );
  requireCanonicalText(
    action.pack_summary_artifact,
    "action.pack_summary_artifact",
    MAX_ARTIFACT_PATH_LENGTH,
  );

  requireExactKeys(manifest.provenance, PROVENANCE_KEYS, "provenance");
  const provenance = manifest.provenance;
  for (const key of PROVENANCE_KEYS) {
    requireString(provenance[key], `provenance.${key}`);
  }
  const subjectSha = normalizeHex(provenance.subject_sha, "provenance.subject_sha", 40);
  const workflowSha = normalizeHex(provenance.workflow_sha, "provenance.workflow_sha", 40);
  const repository = normalizeRepository(provenance.repository);
  const githubRunId = normalizePositiveDecimal(
    provenance.github_run_id,
    "provenance.github_run_id",
  );
  const runAttempt = normalizePositiveDecimal(
    provenance.github_run_attempt,
    "provenance.github_run_attempt",
  );
  const eventName = normalizeEventName(provenance.event_name);
  const pullRequestNumber = normalizePullRequestNumber(
    provenance.pull_request_number,
    eventName,
  );
  const commentTag = requireCanonicalText(
    provenance.comment_tag,
    "provenance.comment_tag",
    256,
  );
  if (commentTag !== `omar-gate-${githubRunId}-${runAttempt}`) {
    fail(
      "COMMENT_TAG_INVALID",
      "provenance.comment_tag",
      "Comment tag does not uniquely bind the Action run and attempt.",
    );
  }
  const workflowRef = normalizeWorkflowRef(provenance.workflow_ref, repository);
  const normalizedProvenance = {
    subject_sha: subjectSha,
    workflow_sha: workflowSha,
    workflow_ref: workflowRef,
    workflow_file_sha256: normalizeHex(
      provenance.workflow_file_sha256,
      "provenance.workflow_file_sha256",
      64,
    ),
    validator_sha256: normalizeHex(
      provenance.validator_sha256,
      "provenance.validator_sha256",
      64,
    ),
    repository,
    event_name: eventName,
    pull_request_number: pullRequestNumber,
    comment_tag: commentTag,
    github_run_id: githubRunId,
    github_run_attempt: runAttempt,
  };

  if (
    options.expectedSubjectSha === undefined ||
    options.expectedWorkflowSha === undefined ||
    options.expectedWorkflowRef === undefined
  ) {
    fail(
      "EXPECTED_PROVENANCE_REQUIRED",
      "options",
      "Independent expected subject SHA, workflow SHA, and workflow ref are required.",
    );
  }
  const expectedSubjectSha = normalizeHex(
    options.expectedSubjectSha,
    "expected_subject_sha",
    40,
  );
  const expectedWorkflowSha = normalizeHex(
    options.expectedWorkflowSha,
    "expected_workflow_sha",
    40,
  );
  const expectedWorkflowRef = normalizeWorkflowRef(
    options.expectedWorkflowRef,
    repository,
    "expected_workflow_ref",
  );
  if (subjectSha !== expectedSubjectSha) {
    fail(
      "SUBJECT_SHA_MISMATCH",
      "provenance.subject_sha",
      "Subject SHA does not match the independently expected commit.",
    );
  }
  if (workflowSha !== expectedWorkflowSha) {
    fail(
      "WORKFLOW_SHA_MISMATCH",
      "provenance.workflow_sha",
      "Workflow SHA does not match the independently expected commit.",
    );
  }
  if (workflowRef !== expectedWorkflowRef) {
    fail(
      "WORKFLOW_REF_MISMATCH",
      "provenance.workflow_ref",
      "Workflow ref does not match the independently expected workflow ref.",
    );
  }
  const recomputedIdempotencyKey = computePinnedActionIdempotencyKey({
    repository,
    pullRequestNumber,
    headSha: subjectSha,
    scanMode,
    policyPack,
    policyPackVersion,
    commentTag,
  });
  if (idempotencyKey !== recomputedIdempotencyKey) {
    fail(
      "IDEMPOTENCY_KEY_INVALID",
      "action.idempotency_key",
      "Action idempotency key does not match immutable invocation inputs.",
    );
  }

  return {
    action: {
      ...action,
      runId,
      idempotencyKey,
      scanMode,
      policyPack,
      policyPackVersion,
      counts,
      attempted,
      success,
      outputValid,
      noFindingsReported,
      reportedFindingCount,
      parseErrorCount,
    },
    provenance: normalizedProvenance,
  };
}

function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function samePath(left, right) {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

async function safeLstat(targetPath, code, field, message) {
  try {
    return await lstat(targetPath);
  } catch {
    fail(code, field, message);
  }
}

async function safeRealpath(targetPath, code, field, message) {
  try {
    return await realpath(targetPath);
  } catch {
    fail(code, field, message);
  }
}

async function resolveWorkspace(workspaceRoot) {
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.length === 0 ||
    workspaceRoot.includes("\0")
  ) {
    fail("WORKSPACE_INVALID", "workspace_root", "Workspace root is missing or invalid.");
  }
  const canonical = await safeRealpath(
    path.resolve(workspaceRoot),
    "WORKSPACE_INVALID",
    "workspace_root",
    "Workspace root cannot be canonicalized.",
  );
  let metadata;
  try {
    metadata = await stat(canonical);
  } catch {
    fail("WORKSPACE_INVALID", "workspace_root", "Workspace root cannot be inspected.");
  }
  if (!metadata.isDirectory()) {
    fail("WORKSPACE_INVALID", "workspace_root", "Workspace root is not a directory.");
  }
  return canonical;
}

async function assertNoSymlinkSegments(rootPath, targetPath, field, finalKind) {
  if (!isWithin(rootPath, targetPath)) {
    fail("ARTIFACT_OUTSIDE_RUN", field, "Artifact path escapes the trusted root.");
  }
  const relative = path.relative(rootPath, targetPath);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let cursor = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const metadata = await safeLstat(
      cursor,
      "ARTIFACT_MISSING",
      field,
      "Required artifact path does not exist.",
    );
    if (metadata.isSymbolicLink()) {
      fail("ARTIFACT_SYMLINK", field, "Symlinks are not accepted in artifact paths.");
    }
    const isFinal = index === segments.length - 1;
    if (!isFinal && !metadata.isDirectory()) {
      fail("ARTIFACT_PATH_INVALID", field, "Artifact parent is not a directory.");
    }
    if (isFinal && finalKind === "file" && !metadata.isFile()) {
      fail("ARTIFACT_NOT_REGULAR", field, "Artifact is not a regular file.");
    }
    if (isFinal && finalKind === "directory" && !metadata.isDirectory()) {
      fail("RUN_ROOT_INVALID", field, "Expected run root is not a directory.");
    }
  }
}

function relativeArtifactSegments(rawPath, field) {
  const value = requireCanonicalText(rawPath, field, MAX_ARTIFACT_PATH_LENGTH);
  if (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    fail("ARTIFACT_ABSOLUTE", field, "Absolute artifact paths are not accepted.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
  ) {
    fail("ARTIFACT_TRAVERSAL", field, "Artifact path contains unsafe path segments.");
  }
  return segments;
}

async function resolveActionArtifact({
  rawPath,
  field,
  expectedName,
  workspacePath,
  runPath,
  canonicalRunPath,
}) {
  const segments = relativeArtifactSegments(rawPath, field);
  if (segments.at(-1) !== expectedName) {
    fail("ARTIFACT_NAME_INVALID", field, "Artifact does not use the required filename.");
  }
  const candidate = path.resolve(workspacePath, ...segments);
  if (!isWithin(runPath, candidate)) {
    fail("ARTIFACT_OUTSIDE_RUN", field, "Artifact is outside the expected run directory.");
  }
  await assertNoSymlinkSegments(workspacePath, candidate, field, "file");
  const canonical = await safeRealpath(
    candidate,
    "ARTIFACT_MISSING",
    field,
    "Required artifact cannot be canonicalized.",
  );
  if (!isWithin(canonicalRunPath, canonical)) {
    fail("ARTIFACT_OUTSIDE_RUN", field, "Canonical artifact escapes the run directory.");
  }
  return {
    canonical,
    relative: path.relative(workspacePath, canonical).split(path.sep).join("/"),
  };
}

async function readBoundedFile(filePath, maximumBytes, field) {
  let handle;
  try {
    const flags = process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    handle = await open(filePath, flags);
  } catch {
    fail("ARTIFACT_READ_FAILED", field, "Required artifact could not be opened safely.");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      fail("ARTIFACT_NOT_REGULAR", field, "Artifact is not a regular file.");
    }
    if (metadata.size > maximumBytes) {
      fail("ARTIFACT_TOO_LARGE", field, "Artifact exceeds the supported size bound.");
    }
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) {
        fail("ARTIFACT_CHANGED", field, "Artifact changed while it was being validated.");
      }
      offset += result.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const extra = await handle.read(overflow, 0, 1, offset);
    const finalMetadata = await handle.stat();
    if (
      extra.bytesRead !== 0 ||
      finalMetadata.size !== metadata.size ||
      finalMetadata.dev !== metadata.dev ||
      finalMetadata.ino !== metadata.ino
    ) {
      fail("ARTIFACT_CHANGED", field, "Artifact changed while it was being validated.");
    }
    return bytes;
  } catch (error) {
    if (error instanceof OmarActionEvidenceValidationError) {
      throw error;
    }
    fail("ARTIFACT_READ_FAILED", field, "Artifact could not be read safely.");
  } finally {
    await handle.close().catch(() => {});
  }
}

function decodeUtf8(bytes, field) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail("UTF8_INVALID", field, "Artifact is not valid UTF-8.");
  }
}

function parseJsonObject(bytes, field) {
  let value;
  try {
    value = JSON.parse(decodeUtf8(bytes, field));
  } catch (error) {
    if (error instanceof OmarActionEvidenceValidationError) {
      throw error;
    }
    fail("JSON_INVALID", field, "Artifact does not contain valid JSON.");
  }
  return requireRecord(value, field);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertBoundedFindingStructure(value, field) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > MAX_FINDING_JSON_NODES || current.depth > MAX_FINDING_JSON_DEPTH) {
      fail("FINDING_STRUCTURE_INVALID", field, "Finding JSON structure exceeds its bound.");
    }
    if (typeof current.value === "string") {
      if (current.value.length > MAX_FINDING_JSON_STRING_CHARS) {
        fail("FINDING_STRUCTURE_INVALID", field, "Finding string metadata exceeds its bound.");
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function validateFinding(value, index) {
  const field = `findings[${index}]`;
  requireRecord(value, field);
  assertBoundedFindingStructure(value, field);
  const required = [
    "category",
    "file_path",
    "fingerprint",
    "line_end",
    "line_start",
    "message",
    "recommendation",
    "severity",
  ];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("FINDING_METADATA_INVALID", field, "Finding metadata is incomplete.");
    }
  }
  if (!SEVERITIES.includes(value.severity)) {
    fail("FINDING_SEVERITY_INVALID", `${field}.severity`, "Finding severity is unsupported.");
  }
  for (const key of ["category", "file_path", "message"]) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      fail("FINDING_METADATA_INVALID", `${field}.${key}`, "Finding text metadata is invalid.");
    }
  }
  if (typeof value.recommendation !== "string") {
    fail(
      "FINDING_METADATA_INVALID",
      `${field}.recommendation`,
      "Finding recommendation must be a string.",
    );
  }
  if (
    !Number.isSafeInteger(value.line_start) ||
    !Number.isSafeInteger(value.line_end) ||
    value.line_start < 0 ||
    value.line_end < value.line_start
  ) {
    fail("FINDING_METADATA_INVALID", field, "Finding line metadata is invalid.");
  }
  if (
    typeof value.fingerprint !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.fingerprint)
  ) {
    fail(
      "FINDING_METADATA_INVALID",
      `${field}.fingerprint`,
      "Finding fingerprint is invalid.",
    );
  }
  if (
    Object.hasOwn(value, "confidence") &&
    (typeof value.confidence !== "number" ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1)
  ) {
    fail(
      "FINDING_METADATA_INVALID",
      `${field}.confidence`,
      "Finding confidence is invalid.",
    );
  }
  return value.severity;
}

function parseFindings(bytes) {
  const text = decodeUtf8(bytes, "FINDINGS.jsonl");
  if (text.startsWith("\uFEFF")) {
    fail("FINDINGS_JSONL_INVALID", "FINDINGS.jsonl", "Byte-order marks are not accepted.");
  }
  let recordCount = text.length === 0 ? 0 : 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      recordCount += 1;
    }
  }
  if (text.endsWith("\n")) {
    recordCount -= 1;
  }
  if (recordCount > VALIDATOR_LIMITS.findings_count) {
    fail("COUNT_INVALID", "FINDINGS.jsonl", "Findings count exceeds the supported bound.");
  }
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  let fingerprintCount = 0;
  let lineStart = 0;
  for (let index = 0; index < recordCount; index += 1) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    if (line.trim().length === 0) {
      fail("FINDINGS_JSONL_INVALID", "FINDINGS.jsonl", "A blank record was found.");
    }
    if (line.length > MAX_FINDING_RECORD_CHARS) {
      fail("FINDINGS_JSONL_INVALID", "FINDINGS.jsonl", "A finding record exceeds its size bound.");
    }
    let finding;
    try {
      finding = JSON.parse(line);
    } catch {
      fail("FINDINGS_JSONL_INVALID", "FINDINGS.jsonl", "A record is not valid JSON.");
    }
    const severity = validateFinding(finding, index);
    counts[severity] += 1;
    fingerprintCount += 1;
  }
  return { counts, count: recordCount, fingerprintCount };
}

function validatePack(pack, normalized, findingsData) {
  if (pack.schema_version !== "1.0") {
    fail("PACK_SCHEMA_INVALID", "PACK_SUMMARY.json.schema_version", "Pack schema is unsupported.");
  }
  if (pack.writer_complete !== true) {
    fail("PACK_INCOMPLETE", "PACK_SUMMARY.json.writer_complete", "Pack writer did not complete.");
  }
  if (pack.run_id !== normalized.action.runId) {
    fail("RUN_ID_MISMATCH", "PACK_SUMMARY.json.run_id", "Pack run id does not match Action output.");
  }
  if (
    pack.scan_mode !== normalized.action.scanMode ||
    pack.policy_pack !== normalized.action.policyPack ||
    pack.policy_pack_version !== normalized.action.policyPackVersion
  ) {
    fail(
      "PACK_INVOCATION_MISMATCH",
      "PACK_SUMMARY.json",
      "Pack invocation metadata does not match Action outputs.",
    );
  }
  const packIdempotencyKey = normalizeHex(
    pack.dedupe_key,
    "PACK_SUMMARY.json.dedupe_key",
    64,
  );
  if (packIdempotencyKey !== normalized.action.idempotencyKey) {
    fail(
      "IDEMPOTENCY_KEY_MISMATCH",
      "PACK_SUMMARY.json.dedupe_key",
      "Pack dedupe key does not match Action output.",
    );
  }

  const packCountsObject = requireRecord(pack.counts, "PACK_SUMMARY.json.counts");
  const packCounts = {};
  for (const severity of SEVERITIES) {
    packCounts[severity] = parsePackCount(
      packCountsObject[severity],
      `PACK_SUMMARY.json.counts.${severity}`,
    );
    if (packCounts[severity] !== normalized.action.counts[severity]) {
      fail(
        "COUNT_MISMATCH",
        `PACK_SUMMARY.json.counts.${severity}`,
        "Counts disagree across channels.",
      );
    }
    if (packCounts[severity] !== findingsData.counts[severity]) {
      fail(
        "SEVERITY_COUNT_MISMATCH",
        `FINDINGS.jsonl.${severity}`,
        "Parsed severities disagree with pack counts.",
      );
    }
  }
  const total = SEVERITIES.reduce((sum, severity) => sum + packCounts[severity], 0);
  if (
    parsePackCount(packCountsObject.total, "PACK_SUMMARY.json.counts.total") !== total ||
    total !== findingsData.count
  ) {
    fail(
      "TOTAL_COUNT_MISMATCH",
      "PACK_SUMMARY.json.counts.total",
      "Total finding counts disagree.",
    );
  }
  const fingerprintCount = parsePackCount(
    pack.fingerprint_count,
    "PACK_SUMMARY.json.fingerprint_count",
  );
  if (fingerprintCount !== findingsData.fingerprintCount) {
    fail(
      "FINDING_METADATA_MISMATCH",
      "PACK_SUMMARY.json.fingerprint_count",
      "Pack finding metadata does not match FINDINGS.jsonl.",
    );
  }

  const evidence = requireRecord(pack.llm_evidence, "PACK_SUMMARY.json.llm_evidence");
  if (evidence.schema_version !== "1.0") {
    fail(
      "EVIDENCE_SCHEMA_INVALID",
      "PACK_SUMMARY.json.llm_evidence.schema_version",
      "Live evidence schema is unsupported.",
    );
  }
  for (const key of ["attempted", "success", "output_valid", "usage_recorded"]) {
    if (evidence[key] !== true) {
      fail(
        "PACK_LIVENESS_INVALID",
        `PACK_SUMMARY.json.llm_evidence.${key}`,
        "Live evidence is incomplete.",
      );
    }
  }
  const parseErrorCount = parsePackCount(
    evidence.parse_error_count,
    "PACK_SUMMARY.json.llm_evidence.parse_error_count",
  );
  if (parseErrorCount !== 0) {
    fail(
      "PACK_PARSE_ERRORS",
      "PACK_SUMMARY.json.llm_evidence.parse_error_count",
      "Pack records parse errors.",
    );
  }
  const reportedFindingCount = parsePackCount(
    evidence.reported_finding_count,
    "PACK_SUMMARY.json.llm_evidence.reported_finding_count",
  );
  const acceptedFindingCount = parsePackCount(
    evidence.accepted_finding_count,
    "PACK_SUMMARY.json.llm_evidence.accepted_finding_count",
  );
  if (acceptedFindingCount > reportedFindingCount) {
    fail(
      "PACK_FINDING_METADATA_INVALID",
      "PACK_SUMMARY.json.llm_evidence.accepted_finding_count",
      "Accepted live finding count exceeds the reported count.",
    );
  }
  if (typeof evidence.no_findings_reported !== "boolean") {
    fail(
      "PACK_RESULT_SHAPE_INVALID",
      "PACK_SUMMARY.json.llm_evidence.no_findings_reported",
      "Explicit-clean evidence is not a boolean.",
    );
  }
  const packResultShapeValid =
    (reportedFindingCount > 0 && evidence.no_findings_reported === false) ||
    (reportedFindingCount === 0 && evidence.no_findings_reported === true);
  if (!packResultShapeValid) {
    fail(
      "PACK_RESULT_SHAPE_INVALID",
      "PACK_SUMMARY.json.llm_evidence",
      "Pack live result shape is contradictory.",
    );
  }
  if (
    evidence.attempted !== normalized.action.attempted ||
    evidence.success !== normalized.action.success ||
    evidence.output_valid !== normalized.action.outputValid ||
    evidence.no_findings_reported !== normalized.action.noFindingsReported ||
    reportedFindingCount !== normalized.action.reportedFindingCount ||
    parseErrorCount !== normalized.action.parseErrorCount
  ) {
    fail(
      "EVIDENCE_MISMATCH",
      "PACK_SUMMARY.json.llm_evidence",
      "Live evidence disagrees with Action outputs.",
    );
  }
  if (
    !Object.hasOwn(evidence, "failure_class") ||
    (evidence.failure_class !== null && evidence.failure_class !== "")
  ) {
    fail(
      "PACK_FAILURE_CONTRADICTION",
      "PACK_SUMMARY.json.llm_evidence.failure_class",
      "Successful pack evidence retains a failure class.",
    );
  }

  const usage = requireRecord(pack.llm_usage, "PACK_SUMMARY.json.llm_usage");
  if (Object.keys(usage).length === 0) {
    fail("USAGE_INVALID", "PACK_SUMMARY.json.llm_usage", "Observed usage metadata is empty.");
  }
  const usageProvider = normalizeObservedValue(
    usage.provider,
    "PACK_SUMMARY.json.llm_usage.provider",
  );
  const usageModel = normalizeObservedValue(
    usage.model,
    "PACK_SUMMARY.json.llm_usage.model",
  );
  if (
    typeof usage.latency_ms !== "number" ||
    !Number.isFinite(usage.latency_ms) ||
    usage.latency_ms <= 0
  ) {
    fail(
      "USAGE_INVALID",
      "PACK_SUMMARY.json.llm_usage.latency_ms",
      "Raw observed usage latency must be positive and finite.",
    );
  }
  const usageEngine =
    usage.engine === undefined || usage.engine === null
      ? usageProvider
      : normalizeObservedValue(usage.engine, "PACK_SUMMARY.json.llm_usage.engine");
  const usageRoute =
    usage.route === undefined || usage.route === null
      ? null
      : normalizeObservedValue(usage.route, "PACK_SUMMARY.json.llm_usage.route");

  const engine = normalizeObservedValue(
    evidence.engine,
    "PACK_SUMMARY.json.llm_evidence.engine",
  );
  const provider = normalizeObservedValue(
    evidence.provider,
    "PACK_SUMMARY.json.llm_evidence.provider",
  );
  const model = normalizeObservedValue(
    evidence.model,
    "PACK_SUMMARY.json.llm_evidence.model",
  );
  if (
    typeof evidence.latency_ms !== "number" ||
    !Number.isFinite(evidence.latency_ms) ||
    evidence.latency_ms <= 0
  ) {
    fail(
      "LATENCY_INVALID",
      "PACK_SUMMARY.json.llm_evidence.latency_ms",
      "Observed live latency must be positive and finite.",
    );
  }
  const route =
    evidence.route === null
      ? null
      : normalizeObservedValue(
          evidence.route,
          "PACK_SUMMARY.json.llm_evidence.route",
        );
  if (
    usageProvider !== provider ||
    usageModel !== model ||
    usageEngine !== engine ||
    usageRoute !== route ||
    usage.latency_ms !== evidence.latency_ms
  ) {
    fail(
      "USAGE_MISMATCH",
      "PACK_SUMMARY.json.llm_usage",
      "Raw observed usage does not support derived live evidence.",
    );
  }

  return {
    counts: packCounts,
    total,
    idempotencyKey: packIdempotencyKey,
    liveEvidence: {
      schema_version: "1.0",
      attempted: true,
      success: true,
      output_valid: true,
      no_findings_reported: evidence.no_findings_reported,
      reported_finding_count: reportedFindingCount,
      accepted_finding_count: acceptedFindingCount,
      parse_error_count: 0,
      usage_recorded: true,
      engine,
      provider,
      model,
      route,
      latency_ms: evidence.latency_ms,
    },
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export async function validateOmarActionEvidence(manifest, options = {}) {
  const normalized = normalizeManifest(manifest, options);
  const workspacePath = await resolveWorkspace(
    options.workspaceRoot ?? process.env.GITHUB_WORKSPACE ?? process.cwd(),
  );
  const runPath = path.join(
    workspacePath,
    ".sentinelayer",
    "runs",
    normalized.action.runId,
  );
  await assertNoSymlinkSegments(workspacePath, runPath, "run_root", "directory");
  const canonicalRunPath = await safeRealpath(
    runPath,
    "RUN_ROOT_INVALID",
    "run_root",
    "Expected run root cannot be canonicalized.",
  );
  if (!isWithin(workspacePath, canonicalRunPath)) {
    fail("RUN_ROOT_INVALID", "run_root", "Canonical run root escapes the workspace.");
  }

  const packArtifact = await resolveActionArtifact({
    rawPath: normalized.action.pack_summary_artifact,
    field: "action.pack_summary_artifact",
    expectedName: "PACK_SUMMARY.json",
    workspacePath,
    runPath,
    canonicalRunPath,
  });
  const findingsArtifact = await resolveActionArtifact({
    rawPath: normalized.action.findings_artifact,
    field: "action.findings_artifact",
    expectedName: "FINDINGS.jsonl",
    workspacePath,
    runPath,
    canonicalRunPath,
  });

  const packBytes = await readBoundedFile(
    packArtifact.canonical,
    VALIDATOR_LIMITS.pack_summary_bytes,
    "PACK_SUMMARY.json",
  );
  const pack = parseJsonObject(packBytes, "PACK_SUMMARY.json");
  if (pack.findings_file !== "FINDINGS.jsonl") {
    fail(
      "PACK_FINDINGS_PATH_INVALID",
      "PACK_SUMMARY.json.findings_file",
      "Pack does not identify the canonical findings filename.",
    );
  }
  const packFindingsCandidate = path.join(
    path.dirname(packArtifact.canonical),
    pack.findings_file,
  );
  await assertNoSymlinkSegments(
    canonicalRunPath,
    packFindingsCandidate,
    "PACK_SUMMARY.json.findings_file",
    "file",
  );
  const packFindingsCanonical = await safeRealpath(
    packFindingsCandidate,
    "PACK_FINDINGS_PATH_INVALID",
    "PACK_SUMMARY.json.findings_file",
    "Pack findings path cannot be canonicalized.",
  );
  if (
    !isWithin(canonicalRunPath, packFindingsCanonical) ||
    !samePath(packFindingsCanonical, findingsArtifact.canonical)
  ) {
    fail(
      "FINDINGS_PATH_MISMATCH",
      "PACK_SUMMARY.json.findings_file",
      "Action and pack findings paths do not identify the same file.",
    );
  }

  const findingsBytes = await readBoundedFile(
    findingsArtifact.canonical,
    VALIDATOR_LIMITS.findings_bytes,
    "FINDINGS.jsonl",
  );
  const findingsSha256 = sha256Hex(findingsBytes);
  const expectedFindingsSha256 = normalizeHex(
    pack.findings_file_sha256,
    "PACK_SUMMARY.json.findings_file_sha256",
    64,
  );
  if (findingsSha256 !== expectedFindingsSha256) {
    fail(
      "FINDINGS_HASH_MISMATCH",
      "PACK_SUMMARY.json.findings_file_sha256",
      "FINDINGS.jsonl bytes do not match the pack digest.",
    );
  }

  const findingsData = parseFindings(findingsBytes);
  const validatedPack = validatePack(pack, normalized, findingsData);
  const packSha256 = sha256Hex(packBytes);
  const coreSummary = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    validation_status: "passed",
    action: {
      ref: PINNED_ACTION_REF,
      sha: PINNED_ACTION_SHA,
      outcome: "success",
      gate_status: "passed",
      run_id: normalized.action.runId,
      scan_mode: normalized.action.scanMode,
      policy_pack: normalized.action.policyPack,
      policy_pack_version: normalized.action.policyPackVersion,
      idempotency_key: validatedPack.idempotencyKey,
      counts: validatedPack.counts,
    },
    live_evidence: validatedPack.liveEvidence,
    artifacts: {
      pack_summary_path: packArtifact.relative,
      findings_path: findingsArtifact.relative,
      pack_sha256: packSha256,
      findings_sha256: findingsSha256,
    },
    findings: {
      count: findingsData.count,
      fingerprint_count: findingsData.fingerprintCount,
      severity_counts: findingsData.counts,
    },
    provenance: normalized.provenance,
  };
  return {
    ...coreSummary,
    evidence_digest: sha256Hex(Buffer.from(canonicalJson(coreSummary), "utf8")),
  };
}

export function githubOutputsForValidatedSummary(summary) {
  return {
    run_id: summary.action.run_id,
    gate_status: summary.action.gate_status,
    p0_count: String(summary.action.counts.P0),
    p1_count: String(summary.action.counts.P1),
    p2_count: String(summary.action.counts.P2),
    p3_count: String(summary.action.counts.P3),
    scan_mode: summary.action.scan_mode,
    policy_pack: summary.action.policy_pack,
    policy_pack_version: summary.action.policy_pack_version,
    idempotency_key: summary.action.idempotency_key,
    pack_summary_path: summary.artifacts.pack_summary_path,
    findings_path: summary.artifacts.findings_path,
    pack_sha256: summary.artifacts.pack_sha256,
    findings_sha256: summary.artifacts.findings_sha256,
    evidence_digest: summary.evidence_digest,
    subject_sha: summary.provenance.subject_sha,
    workflow_sha: summary.provenance.workflow_sha,
    workflow_ref: summary.provenance.workflow_ref,
    workflow_file_sha256: summary.provenance.workflow_file_sha256,
    validator_sha256: summary.provenance.validator_sha256,
    observed_engine: summary.live_evidence.engine,
    observed_provider: summary.live_evidence.provider,
    observed_model: summary.live_evidence.model,
  };
}

function formatGitHubOutputs(summary) {
  return (
    Object.entries(githubOutputsForValidatedSummary(summary))
      .map(([key, value]) => {
        const text = String(value);
        if (/[\r\n]/u.test(text)) {
          fail("OUTPUT_UNSAFE", key, "Generated GitHub output contains unsafe characters.");
        }
        return `${key}=${text}`;
      })
      .join("\n") + "\n"
  );
}

function parseCliArguments(argv) {
  const values = {};
  const supported = new Set([
    "--expected-subject-sha",
    "--expected-workflow-ref",
    "--expected-workflow-sha",
    "--github-output",
    "--input",
    "--summary-out",
    "--workspace-root",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      return { help: true };
    }
    if (!supported.has(flag) || Object.hasOwn(values, flag)) {
      fail("CLI_ARGUMENT_INVALID", "cli", "Unknown or duplicate CLI argument.", 2);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("CLI_ARGUMENT_INVALID", "cli", "CLI option is missing its value.", 2);
    }
    values[flag] = value;
    index += 1;
  }
  for (const required of [
    "--input",
    "--summary-out",
    "--github-output",
    "--expected-subject-sha",
    "--expected-workflow-ref",
    "--expected-workflow-sha",
  ]) {
    if (!Object.hasOwn(values, required)) {
      fail("CLI_ARGUMENT_MISSING", "cli", "A required CLI option is missing.", 2);
    }
  }
  return {
    help: false,
    input: values["--input"],
    summaryOut: values["--summary-out"],
    githubOutput: values["--github-output"],
    workspaceRoot: values["--workspace-root"],
    expectedSubjectSha: values["--expected-subject-sha"],
    expectedWorkflowRef: values["--expected-workflow-ref"],
    expectedWorkflowSha: values["--expected-workflow-sha"],
  };
}

async function loadInputManifest(inputPath, cwd) {
  if (
    typeof inputPath !== "string" ||
    inputPath.length === 0 ||
    inputPath.includes("\0")
  ) {
    fail("INPUT_INVALID", "input", "Input manifest path is invalid.", 2);
  }
  const absolute = path.resolve(cwd, inputPath);
  const metadata = await safeLstat(
    absolute,
    "INPUT_INVALID",
    "input",
    "Input manifest does not exist.",
  );
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > VALIDATOR_LIMITS.manifest_bytes
  ) {
    fail("INPUT_INVALID", "input", "Input manifest must be a bounded regular file.");
  }
  const bytes = await readBoundedFile(
    absolute,
    VALIDATOR_LIMITS.manifest_bytes,
    "input",
  );
  return parseJsonObject(bytes, "input");
}

async function prepareDestination(rawPath, field, cwd, allowExisting) {
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.includes("\0")
  ) {
    fail("OUTPUT_DESTINATION_INVALID", field, "Output destination is invalid.", 2);
  }
  const requested = path.resolve(cwd, rawPath);
  const parent = await safeRealpath(
    path.dirname(requested),
    "OUTPUT_DESTINATION_INVALID",
    field,
    "Output destination parent does not exist.",
  );
  const destination = path.join(parent, path.basename(requested));
  let metadata = null;
  try {
    metadata = await lstat(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail("OUTPUT_DESTINATION_INVALID", field, "Output destination cannot be inspected.");
    }
  }
  if (metadata?.isSymbolicLink() || (metadata && !metadata.isFile())) {
    fail("OUTPUT_DESTINATION_INVALID", field, "Output destination is not a regular file.");
  }
  if (!allowExisting && metadata) {
    fail("OUTPUT_DESTINATION_EXISTS", field, "Summary output already exists.");
  }
  return {
    path: destination,
    existed: Boolean(metadata),
    size: metadata?.size ?? 0,
  };
}

async function writeSuccessOutputs({
  summary,
  summaryOut,
  githubOutput,
  inputPath,
  cwd,
}) {
  const summaryDestination = await prepareDestination(
    summaryOut,
    "summary_out",
    cwd,
    false,
  );
  const githubDestination = await prepareDestination(
    githubOutput,
    "github_output",
    cwd,
    true,
  );
  const inputAbsolute = path.resolve(cwd, inputPath);
  if (
    samePath(summaryDestination.path, githubDestination.path) ||
    samePath(summaryDestination.path, inputAbsolute) ||
    samePath(githubDestination.path, inputAbsolute)
  ) {
    fail("OUTPUT_DESTINATION_INVALID", "output", "Input and outputs must be distinct.");
  }

  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  const githubText = formatGitHubOutputs(summary);
  const temporarySummary = path.join(
    path.dirname(summaryDestination.path),
    `.${path.basename(summaryDestination.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let githubTouched = false;
  try {
    await writeFile(temporarySummary, summaryText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    githubTouched = true;
    await appendFile(githubDestination.path, githubText, {
      encoding: "utf8",
      mode: 0o600,
    });
    await link(temporarySummary, summaryDestination.path);
    await rm(temporarySummary, { force: true }).catch(() => {});
  } catch {
    await rm(temporarySummary, { force: true }).catch(() => {});
    if (githubTouched) {
      if (githubDestination.existed) {
        await truncate(githubDestination.path, githubDestination.size).catch(() => {});
      } else {
        await rm(githubDestination.path, { force: true }).catch(() => {});
      }
    }
    fail("OUTPUT_WRITE_FAILED", "output", "Validated output files could not be written.");
  }
}

function usageText() {
  return [
    "Usage: node omar-action-evidence-validator.mjs",
    "  --input <manifest.json>",
    "  --summary-out <validated.json>",
    "  --github-output <path>",
    "  --expected-subject-sha <40hex>",
    "  --expected-workflow-sha <40hex>",
    "  --expected-workflow-ref <owner/repo/.github/workflows/file.yml@ref>",
    "  [--workspace-root <path>]",
    "",
  ].join("\n");
}

function publicErrorPayload(error) {
  const safeError =
    error instanceof OmarActionEvidenceValidationError
      ? error
      : new OmarActionEvidenceValidationError(
          "INTERNAL_ERROR",
          "validator",
          "Validator failed without emitting untrusted details.",
        );
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    validation_status: "failed",
    error: safeError.toJSON(),
  };
}

export async function runOmarActionEvidenceCli(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  try {
    const cli = parseCliArguments(argv);
    if (cli.help) {
      stdout.write(usageText());
      return 0;
    }
    const manifest = await loadInputManifest(cli.input, cwd);
    const summary = await validateOmarActionEvidence(manifest, {
      workspaceRoot: cli.workspaceRoot ?? env.GITHUB_WORKSPACE ?? cwd,
      expectedSubjectSha: cli.expectedSubjectSha,
      expectedWorkflowRef: cli.expectedWorkflowRef,
      expectedWorkflowSha: cli.expectedWorkflowSha,
    });
    await writeSuccessOutputs({
      summary,
      summaryOut: cli.summaryOut,
      githubOutput: cli.githubOutput,
      inputPath: cli.input,
      cwd,
    });
    stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(publicErrorPayload(error))}\n`);
    return error instanceof OmarActionEvidenceValidationError ? error.exitCode : 1;
  }
}

const isDirectInvocation =
  typeof process.argv[1] === "string" &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectInvocation) {
  runOmarActionEvidenceCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

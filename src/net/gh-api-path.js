// gh-api-path.js — the values the CLI puts into GitHub API paths that gh requests.
//
// gh sends every request with the signed-in user's GitHub token. The CLI builds `gh api` paths
// (repos/<owner>/<repo>/...) and passes --repo values that gh turns into paths of its own, so each
// value is checked for its role before any gh process starts:
//
//   ghRepoSlug     exactly "owner/repo". The owner starts with a letter or digit, then letters,
//                  digits, "-" or "_" (Enterprise Managed User names end in "_shortcode"), at most
//                  39 characters. The repository is letters, digits, ".", "_" or "-", at most 100
//                  characters, and not "." or "..".
//   ghCommitSha    7 to 40 hexadecimal characters.
//   ghRefSegment   a git branch, tag or ref name under git's ref-name rules, not starting with "-",
//                  percent-encoded as ONE path segment. A branch name may contain "/", and git also
//                  allows "#", "%", "{" and other characters that mean something in a URL or to gh;
//                  encoded, they stay inside the segment. GitHub's compare ({base}...{head}) and
//                  commits/{ref} endpoints accept a branch name with "/" encoded as %2F.
//
// Each returns the value to put in the path, or throws an Error saying what the value must be.
// These are GitHub-specific rather than a general one-segment encoder: a branch name may contain
// "/" and still be one segment once encoded, and a slug or a commit SHA has a shape of its own.

const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[0-9A-Fa-f]{7,40}$/;
// Control characters, space, and the other characters git does not allow in a ref name.
const REF_FORBIDDEN = /[\u0000-\u0020\u007f-\u009f~^:?*[\\]/;

/** True when `value` is exactly "owner/repo" as GitHub names them. */
export function isGhRepoSlug(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return OWNER.test(owner) && REPO.test(repo) && repo !== "." && repo !== "..";
}

/** True when `value` is a valid git branch, tag or ref name that does not start with "-". */
export function isGitRefName(value) {
  if (typeof value !== "string" || !value || !value.isWellFormed()) return false;
  if (value === "@" || value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (REF_FORBIDDEN.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  return value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** `value` as an owner/repo path, or throws. */
export function ghRepoSlug(value, { label = "repo" } = {}) {
  if (!isGhRepoSlug(value)) {
    throw new Error(`${label} must be a GitHub repository in owner/repo form.`);
  }
  return value;
}

/** `value` as a commit SHA path segment, or throws. */
export function ghCommitSha(value, { label = "sha" } = {}) {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    throw new Error(`${label} must be a commit SHA of 7 to 40 hexadecimal characters.`);
  }
  return value;
}

/** `value` (a git branch, tag or ref name) percent-encoded as one path segment, or throws. */
export function ghRefSegment(value, { label = "ref" } = {}) {
  if (!isGitRefName(value)) {
    throw new Error(`${label} must be a valid git branch, tag or ref name.`);
  }
  return encodeURIComponent(value);
}

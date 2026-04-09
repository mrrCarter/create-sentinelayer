const PRIVATE_HOST_SUFFIXES = [".internal", ".local", ".localhost"];
const BLOCKED_LITERAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.google.internal.",
]);

function isNumericIpv4(hostname) {
  const parts = String(hostname || "").split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isPrivateIpv4(hostname) {
  if (!isNumericIpv4(hostname)) {
    return false;
  }
  const parts = hostname.split(".").map((part) => Number(part));
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const normalized = String(hostname || "").toLowerCase().split("%")[0];
  if (!normalized.includes(":")) {
    return false;
  }
  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  return false;
}

function isPrivateHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (!normalized) {
    return true;
  }
  if (BLOCKED_LITERAL_HOSTS.has(normalized)) {
    return true;
  }
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }
  if (isPrivateIpv4(normalized) || isPrivateIpv6(normalized)) {
    return true;
  }
  return false;
}

function isPrivateTargetBypassEnabled(allowPrivateTargets) {
  if (allowPrivateTargets === true) {
    return true;
  }
  if (process.env.SENTINELAYER_ALLOW_PRIVATE_AUDIT_TARGETS === "1") {
    return true;
  }
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  return false;
}

export function assertPermittedAuditTarget(urlValue, options = {}) {
  const { operation = "audit", allowPrivateTargets = false } = options;
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error("Invalid URL: " + urlValue);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid URL: " + parsed.toString());
  }
  if (!isPrivateTargetBypassEnabled(allowPrivateTargets) && isPrivateHostname(parsed.hostname)) {
    throw new Error(
      `Blocked private audit target for ${operation}: ${parsed.hostname}. ` +
      "Set allowPrivateTargets=true or SENTINELAYER_ALLOW_PRIVATE_AUDIT_TARGETS=1 to override."
    );
  }
  return parsed;
}

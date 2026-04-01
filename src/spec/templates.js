export const SPEC_TEMPLATES = Object.freeze([
  {
    id: "saas-app",
    name: "SaaS App",
    description: "Web SaaS product with backend APIs and admin operations.",
    architectureFocus: [
      "Service/API boundaries and data contracts",
      "Tenant and authorization boundaries",
      "Observability and rollback paths",
    ],
    securityChecklist: [
      "AuthN/AuthZ controls are explicit",
      "Secrets and tokens are never hardcoded",
      "Audit logging covers critical admin actions",
      "Rate limits and abuse controls are defined",
    ],
  },
  {
    id: "api-service",
    name: "API Service",
    description: "Backend-first service with deterministic API behavior and reliability guardrails.",
    architectureFocus: [
      "Request validation and response schema contracts",
      "Resilience strategy (timeouts, retries, idempotency)",
      "Deployment and migration safety",
    ],
    securityChecklist: [
      "Input validation on all external boundaries",
      "AuthN/AuthZ policy enforced per endpoint",
      "Dependency and supply-chain controls",
      "Structured error handling avoids sensitive leakage",
    ],
  },
  {
    id: "cli-tool",
    name: "CLI Tool",
    description: "Deterministic developer CLI with predictable outputs and CI automation support.",
    architectureFocus: [
      "Subcommand and flag ergonomics",
      "Idempotent filesystem operations",
      "Machine-readable output contracts",
    ],
    securityChecklist: [
      "Safe path handling and traversal guards",
      "No secret echo in logs or command history",
      "Destructive actions require explicit confirmation/gates",
      "Budget and timeout controls for long-running tasks",
    ],
  },
  {
    id: "library",
    name: "Library",
    description: "Reusable package focused on API stability and testability.",
    architectureFocus: [
      "Public API surface and versioning strategy",
      "Backward compatibility guarantees",
      "Reference tests and fixtures",
    ],
    securityChecklist: [
      "Input sanitization and safe defaults",
      "Dependency vulnerability monitoring",
      "Breaking changes require migration guidance",
      "Error messages avoid exposing internals",
    ],
  },
  {
    id: "mobile-app",
    name: "Mobile App",
    description: "Mobile-first client with secure device/session handling and backend integration.",
    architectureFocus: [
      "Offline behavior and sync rules",
      "Auth/session lifecycle on-device",
      "API contract and version coordination",
    ],
    securityChecklist: [
      "Secure token storage and rotation",
      "PII handling and redaction policies",
      "Transport security and certificate pinning strategy",
      "Crash/log pipelines avoid sensitive user data",
    ],
  },
]);

export function getTemplateById(templateId) {
  const normalized = String(templateId || "").trim().toLowerCase();
  return SPEC_TEMPLATES.find((template) => template.id === normalized) || null;
}

export function getDefaultTemplate() {
  return getTemplateById("api-service");
}

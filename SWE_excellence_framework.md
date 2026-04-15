# PLEXAURA TECHNICAL DD PROTOCOL - ADDENDUM v1.2
## Engineering Excellence Deep Dive Sections
### Beyond Security: Code Logic, Performance, and System Wiring

---

## INTRODUCTION

The base protocol focuses heavily on security (25% weight). This addendum adds comprehensive sections for evaluating **engineering excellence** that FAANG acquirers and sophisticated investors assess:

- Frontend-specific patterns and anti-patterns
- Backend architecture and query optimization
- State management and React-specific issues
- Performance and Core Web Vitals
- Infrastructure consistency and configuration drift
- Data flow, caching, and system wiring
- Dependency and bundle analysis
- Responsive design and mobile UX reliability
- Traffic scaling and capacity readiness
- QA lifecycle coverage with low-friction gates

---

# SECTION A: FRONTEND ENGINEERING ASSESSMENT

## A.1 React/Next.js Specific Patterns

### A.1.1 State Management Anti-Patterns

**Search for these problematic patterns:**

```javascript
// ANTI-PATTERN: State updates in loops
array.forEach(item => setState(...))  // ❌ Causes N re-renders

// ANTI-PATTERN: Stale closure in useEffect
useEffect(() => {
  setInterval(() => {
    console.log(count)  // ❌ Will always log initial value
  }, 1000)
}, [])  // Empty deps = stale closure

// ANTI-PATTERN: Missing cleanup in useEffect
useEffect(() => {
  const subscription = api.subscribe(...)
  // ❌ No return cleanup function = memory leak
}, [])

// ANTI-PATTERN: Object/array in dependency array
useEffect(() => {
  // This runs every render because {} !== {}
}, [{ someKey: value }])  // ❌ New object reference each render

// ANTI-PATTERN: Prop drilling > 3 levels
<GrandParent>
  <Parent prop={data}>
    <Child prop={data}>
      <GrandChild prop={data}>  // ❌ Consider Context or state library
```

**Checklist:**
| Pattern | Count Found | Files Affected | Severity |
|---------|-------------|----------------|----------|
| State updates in loops | | | HIGH |
| Missing useEffect cleanup | | | HIGH |
| Stale closures | | | HIGH |
| Object/array dependency bugs | | | MEDIUM |
| Prop drilling > 3 levels | | | MEDIUM |
| useState for derived data | | | LOW |

---

### A.1.2 Component Architecture

**Count useState hooks per component:**
```bash
# Find components with too many useState calls
grep -rn "useState" --include="*.tsx" | 
  awk -F: '{print $1}' | 
  sort | uniq -c | 
  sort -rn | head -20
```

| Threshold | Assessment |
|-----------|------------|
| 0-5 useState per component | ✅ Good |
| 6-10 useState | ⚠️ Consider useReducer |
| 11-15 useState | ❌ Refactor required |
| 16+ useState | 🚨 God component - split immediately |

**Document god components:**
| File | useState Count | Lines | Action Required |
|------|----------------|-------|-----------------|

---

### A.1.3 Rendering Optimization

**Search for missing optimizations:**

```javascript
// Missing React.memo on frequently re-rendered components
// Check: Are child components wrapped in memo()?

// Missing useCallback for functions passed as props
// Check: Are callback props stable?

// Missing useMemo for expensive calculations
// Check: Are complex computations memoized?

// Inline object/function in JSX
<Component style={{ color: 'red' }} />  // ❌ New object each render
<Component onClick={() => handleClick(id)} />  // ❌ New function each render
```

**Checklist:**
| Check | Status | Notes |
|-------|--------|-------|
| React.memo on pure components | | |
| useCallback for callback props | | |
| useMemo for expensive calculations | | |
| No inline objects in JSX | | |
| No inline functions in JSX (hot paths) | | |
| React DevTools shows minimal re-renders | | |

---

### A.1.4 Data Fetching Patterns

**Evaluate data fetching approach:**

| Pattern | Status | Implementation |
|---------|--------|----------------|
| Request deduplication | | |
| Proper loading states | | |
| Error boundary coverage | | |
| Suspense usage (React 18+) | | |
| Optimistic updates | | |
| Stale-while-revalidate | | |
| Abort controller for cleanup | | |

**Search for race conditions:**
```javascript
// BAD: No cleanup, race condition possible
useEffect(() => {
  fetch(url).then(data => setData(data))
}, [url])

// GOOD: With cleanup
useEffect(() => {
  let cancelled = false
  fetch(url).then(data => {
    if (!cancelled) setData(data)
  })
  return () => { cancelled = true }
}, [url])
```

**Count instances without cleanup:**
| File | Fetch without cleanup | Severity |
|------|----------------------|----------|

---

### A.1.5 dangerouslySetInnerHTML Audit

**Every instance must be reviewed:**
```bash
grep -rn "dangerouslySetInnerHTML" --include="*.tsx" --include="*.jsx"
```

| File:Line | Content Source | Sanitized? | Risk Level |
|-----------|----------------|------------|------------|

**Sanitization requirements:**
- [ ] DOMPurify or similar library used
- [ ] Server-side sanitization in place
- [ ] Content source is trusted (not user input)

---

## A.2 Core Web Vitals Assessment

### A.2.1 Metrics Targets

| Metric | Good | Needs Improvement | Poor | Current |
|--------|------|-------------------|------|---------|
| **LCP** (Largest Contentful Paint) | ≤2.5s | 2.5-4.0s | >4.0s | |
| **INP** (Interaction to Next Paint) | ≤200ms | 200-500ms | >500ms | |
| **CLS** (Cumulative Layout Shift) | ≤0.1 | 0.1-0.25 | >0.25 | |
| **FCP** (First Contentful Paint) | ≤1.8s | 1.8-3.0s | >3.0s | |
| **TTFB** (Time to First Byte) | ≤800ms | 800-1800ms | >1800ms | |
| **TBT** (Total Blocking Time) | ≤200ms | 200-600ms | >600ms | |

**Run PageSpeed Insights:**
- Mobile score: ___/100
- Desktop score: ___/100

---

### A.2.2 LCP Optimization Checklist

| Factor | Status | Evidence |
|--------|--------|----------|
| Largest element identified | | |
| Critical CSS inlined | | |
| Hero image preloaded | | |
| Render-blocking resources minimized | | |
| Server response time < 200ms | | |
| CDN configured | | |

---

### A.2.3 INP Optimization Checklist

| Factor | Status | Evidence |
|--------|--------|----------|
| No long tasks (>50ms) on main thread | | |
| Event handlers are lightweight | | |
| Heavy JS deferred/code-split | | |
| Third-party scripts minimized | | |
| Web workers for CPU-intensive tasks | | |

---

### A.2.4 CLS Optimization Checklist

| Factor | Status | Evidence |
|--------|--------|----------|
| Images have width/height attributes | | |
| Fonts use font-display: optional/swap | | |
| Dynamic content has reserved space | | |
| Ads/embeds have size containers | | |
| No layout shifts on interaction | | |

---

## A.3 Bundle Analysis

### A.3.1 Bundle Size Thresholds

| Bundle Type | Target | Warning | Critical | Current |
|-------------|--------|---------|----------|---------|
| Initial JS | <200KB | 200-500KB | >500KB | |
| Initial CSS | <50KB | 50-100KB | >100KB | |
| Per-route chunk | <100KB | 100-200KB | >200KB | |
| Total JS (all routes) | <1MB | 1-2MB | >2MB | |

**Run bundle analyzer:**
```bash
# Next.js
ANALYZE=true npm run build

# Or use source-map-explorer
npx source-map-explorer 'build/static/js/*.js'
```

---

### A.3.2 Code Splitting Verification

| Check | Status | Notes |
|-------|--------|-------|
| Dynamic imports for routes | | |
| Heavy libraries lazy loaded | | |
| Images lazy loaded (below fold) | | |
| Third-party scripts deferred | | |
| Unused exports tree-shaken | | |

---

### A.3.3 Dependency Bloat Detection

**Identify oversized dependencies:**
```bash
npx depcheck  # Find unused dependencies
npx bundlephobia <package>  # Check bundle impact
```

| Dependency | Size | Used? | Lighter Alternative? |
|------------|------|-------|---------------------|
| moment | ~70KB | | date-fns (~13KB) |
| lodash | ~70KB | | lodash-es + cherry-pick |
| axios | ~13KB | | fetch (0KB) |

---

## A.4 HTTP Caching Headers

### A.4.1 Static Asset Caching

**Google requires 30+ days for static assets:**

| Asset Type | Required TTL | Current TTL | Status |
|------------|--------------|-------------|--------|
| JS bundles (hashed) | 1 year | | |
| CSS files (hashed) | 1 year | | |
| Images | 30+ days | | |
| Fonts | 1 year | | |
| favicon.ico | 1 week | | |

**Correct headers for immutable assets:**
```
Cache-Control: public, max-age=31536000, immutable
```

**Verify headers:**
```bash
curl -I https://yourdomain.com/_next/static/chunks/main.js | grep -i cache
```

---

### A.4.2 API Response Caching

| Endpoint Type | Recommended TTL | Current | Status |
|---------------|-----------------|---------|--------|
| Static content API | 1 hour+ | | |
| User-specific data | no-store or private | | |
| Public data | 5-60 minutes | | |
| Real-time data | no-cache | | |

---

## A.5 Accessibility (A11Y) Basics

| Check | Status | Tool |
|-------|--------|------|
| All images have alt text | | axe |
| Form inputs have labels | | axe |
| Color contrast ratio ≥ 4.5:1 | | WebAIM |
| Keyboard navigation works | | Manual |
| Focus indicators visible | | Manual |
| ARIA labels on interactive elements | | axe |
| Skip navigation link | | Manual |

**Run automated audit:**
```bash
npx @axe-core/cli https://yoursite.com
```

---

## A.6 Responsive Design & Device Resilience

### A.6.1 Breakpoint Coverage (Low Friction)

| Viewport | Minimum Width | Required Validation |
|----------|---------------|---------------------|
| Mobile | 360px | Core user flow completes without horizontal scroll |
| Tablet | 768px | Navigation, forms, and tables remain usable |
| Desktop | 1280px+ | Dense layouts remain readable and keyboard accessible |

**Quick smoke checks (must pass):**
| Check | Status | Notes |
|-------|--------|-------|
| No horizontal scroll on core pages | | |
| Tap targets >= 44x44 px | | |
| Modals/drawers usable on mobile | | |
| Data tables have mobile fallback (stack/scroll/card) | | |
| Form errors visible and announced | | |

### A.6.2 Responsive Media and Layout Stability

| Pattern | Required? | Evidence |
|--------|-----------|----------|
| Responsive images (`srcset` or Next/Image) | Yes | |
| Fluid typography (`clamp`) or defined scale | Yes | |
| Safe area handling (notch devices) | Recommended | |
| Orientation change handling | Recommended | |
| No overlap/truncation at common breakpoints | Yes | |

**Optional automation (recommended, non-blocking):**
```bash
npx playwright test --project="Mobile Chrome"
```

---

# SECTION B: BACKEND ENGINEERING ASSESSMENT

## B.1 Database Query Optimization

### B.1.1 N+1 Query Detection

**Search for N+1 patterns in ORM code:**

```javascript
// BAD: N+1 pattern
const users = await prisma.user.findMany()
for (const user of users) {
  const posts = await prisma.post.findMany({ where: { userId: user.id } })
  // ❌ This runs N additional queries
}

// GOOD: Eager loading
const users = await prisma.user.findMany({
  include: { posts: true }  // ✅ Single query with JOIN
})
```

**Count N+1 instances:**
| File:Line | Pattern | Records Affected | Severity |
|-----------|---------|------------------|----------|

---

### B.1.2 Query Performance Analysis

**Run EXPLAIN ANALYZE on critical queries:**

| Query | Execution Time | Index Used? | Optimization Needed |
|-------|----------------|-------------|---------------------|

**Query latency targets:**
| Percentile | Target | Current |
|------------|--------|---------|
| p50 | <10ms | |
| p95 | <50ms | |
| p99 | <100ms | |

---

### B.1.3 Index Analysis

**Verify indexes exist for:**
| Column/Pattern | Index Exists? | Query Using It |
|----------------|---------------|----------------|
| Foreign keys | | |
| WHERE clause columns | | |
| ORDER BY columns | | |
| JOIN conditions | | |
| Composite frequently used | | |

---

### B.1.4 Connection Pooling

| Setting | Recommended | Current | Status |
|---------|-------------|---------|--------|
| Pool size | 10-20 per instance | | |
| Connection timeout | 5-10 seconds | | |
| Idle timeout | 10-30 minutes | | |
| Max lifetime | 30-60 minutes | | |

**For serverless (Prisma):**
```javascript
// Check for connection limit
connection_limit=10  // Per serverless function
```

---

## B.2 API Design Quality

### B.2.1 REST Maturity Assessment

| Level | Description | Achieved? |
|-------|-------------|-----------|
| Level 0 | Single URI, single verb | Avoid |
| Level 1 | Multiple URIs for resources | |
| Level 2 | Proper HTTP verbs + status codes | **Target** |
| Level 3 | HATEOAS | Advanced |

---

### B.2.2 Error Response Consistency

**All error responses should follow same schema:**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human readable message",
    "details": [...],
    "requestId": "req_123"
  }
}
```

**Audit sample of error responses:**
| Endpoint | Error Format Consistent? | Includes requestId? |
|----------|-------------------------|---------------------|

---

### B.2.3 Rate Limiting Verification

| Endpoint Type | Rate Limit | Implemented? | Fail Mode |
|---------------|------------|--------------|-----------|
| Public APIs | 100/min | | Fail open/closed? |
| Auth endpoints | 5/min | | |
| Payment endpoints | 10/min | | |
| Admin endpoints | 60/min | | |

**Critical: Verify fail-closed behavior:**
```javascript
// BAD: Fail open
catch (error) {
  return null  // ❌ Allows request on Redis failure
}

// GOOD: Fail closed
catch (error) {
  throw new RateLimitError('Service unavailable')
}
```

---

### B.2.4 Idempotency

| Mutation Endpoint | Idempotency Key? | Duplicate Handling |
|-------------------|------------------|-------------------|
| POST /payments | | |
| POST /orders | | |
| POST /users | | |

---

## B.3 Background Job Processing

### B.3.1 Queue Architecture

| Component | Status | Implementation |
|-----------|--------|----------------|
| Job queue (BullMQ, etc.) | | |
| Dead letter queue | | |
| Retry with exponential backoff | | |
| Job timeout configuration | | |
| Concurrency limits | | |
| Job priority levels | | |

---

### B.3.2 Job Failure Handling

| Scenario | Handled? | Evidence |
|----------|----------|----------|
| Job timeout | | |
| Worker crash during job | | |
| Poison pill (always-failing job) | | |
| Queue backpressure | | |

---

## B.4 External Service Integration

### B.4.1 Resilience Patterns

| Pattern | Implemented? | Services Covered |
|---------|--------------|------------------|
| Circuit breaker | | |
| Retry with backoff | | |
| Timeout configuration | | |
| Fallback behavior | | |
| Bulkhead isolation | | |

---

### B.4.2 External Service Inventory

| Service | Timeout | Retries | Circuit Breaker | Fallback |
|---------|---------|---------|-----------------|----------|
| OpenAI | | | | |
| Stripe | | | | |
| AWS S3 | | | | |
| ATTOM | | | | |
| Email service | | | | |

---

## B.5 Traffic Scaling & Capacity Readiness

### B.5.1 Capacity Baselines

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| Sustained RPS (normal) | Define per product tier | | |
| Peak RPS (burst) | >=2x sustained | | |
| p95 API latency at peak | <300ms (non-AI), <1200ms (AI) | | |
| Error rate at peak | <1% | | |
| Queue lag under load | <60s | | |

### B.5.2 Scaling Readiness Checklist (Practical)

| Check | Status | Notes |
|-------|--------|-------|
| Stateless API instances (safe horizontal scaling) | | |
| Autoscaling policy configured (CPU/RPS/queue depth) | | |
| Backpressure strategy documented | | |
| Worker concurrency caps configured | | |
| Rate limit strategy tiered by endpoint risk | | |
| Read replicas/caching used for heavy reads | | |

### B.5.3 Load Test Coverage

| Scenario | Included? | Tool | Last Run |
|----------|-----------|------|----------|
| PR-check burst traffic | | k6/Artillery | |
| External dependency slowdown | | k6 + fault injection | |
| Queue spike and drain behavior | | custom worker test | |

**Minimum low-friction cadence:**
1. Run one lightweight load profile before major release.
2. Run one stress profile monthly on staging.
3. Record p95, error rate, and queue lag trend.

---

# SECTION C: INFRASTRUCTURE CONSISTENCY

## C.1 Terraform State & Drift

### C.1.1 Drift Detection

**Run drift check:**
```bash
terraform plan -refresh-only
```

| Resource | Expected State | Actual State | Drifted? |
|----------|----------------|--------------|----------|
| | | | |

---

### C.1.2 State Management

| Check | Status | Evidence |
|-------|--------|----------|
| Remote state backend (S3, etc.) | | |
| State locking (DynamoDB) | | |
| State encryption at rest | | |
| No secrets in state file | | |
| State backup configured | | |

---

### C.1.3 IaC Coverage

| Resource Type | Managed by Terraform? | Manual? |
|---------------|----------------------|---------|
| VPC/Networking | | |
| Compute (ECS/EC2) | | |
| Database (RDS) | | |
| Cache (Redis) | | |
| Storage (S3) | | |
| Secrets Manager | | |
| IAM Roles | | |
| DNS | | |

**IaC Coverage Score:**
```
Coverage = (Terraform-managed resources / Total resources) × 100
Target: >90%
```

---

## C.2 Environment Parity

### C.2.1 Configuration Consistency

| Config Item | Dev | Staging | Prod | Consistent? |
|-------------|-----|---------|------|-------------|
| Node version | | | | |
| Database version | | | | |
| Redis version | | | | |
| Environment variables | | | | |
| Feature flags | | | | |

---

### C.2.2 Secrets Synchronization

| Secret | Source of Truth | Synced to AWS SM? | Rotation Policy |
|--------|-----------------|-------------------|-----------------|
| | | | |

**Verify secrets manager integration:**
```bash
# Check Terraform references secrets correctly
grep -r "aws_secretsmanager" terraform/
```

---

## C.3 Multi-Environment Caching

### C.3.1 Redis Configuration Consistency

| Setting | Local | Staging | Production | Consistent? |
|---------|-------|---------|------------|-------------|
| Max memory | | | | |
| Eviction policy | | | | |
| Persistence | | | | |
| Cluster mode | | | | |
| TLS enabled | | | | |

---

### C.3.2 Cache Invalidation Strategy

| Cache Type | TTL | Invalidation Method | Documented? |
|------------|-----|---------------------|-------------|
| Session cache | | | |
| API response cache | | | |
| Database query cache | | | |
| CDN cache | | | |

**Verify cache invalidation on deploy:**
| Deployment | Cache Cleared? | How? |
|------------|----------------|------|

---

# SECTION D: DATA FLOW & WIRING ANALYSIS

## D.1 Request Flow Tracing

### D.1.1 Map Critical Path

**For each critical user journey, document the full request flow:**

```
Example: User submits property for analysis

1. Client: Form submission → POST /api/mvp-analyze
2. Middleware: Auth check → Rate limit check
3. API Route: Validate input → Check user subscription
4. Service: Fetch ATTOM data → Cache check
5. AI Service: Call OpenAI → Process response
6. Storage: Save to S3 → Update database
7. Queue: Trigger email job
8. Response: Return to client
```

**Document for your app:**
| Journey | Steps | External Calls | Failure Points |
|---------|-------|----------------|----------------|

---

### D.1.2 Circular Dependency Detection

```bash
# For Node.js
npx madge --circular src/

# Or use dependency-cruiser
npx depcruise --include-only "^lib" --output-type dot lib | dot -T svg > dependencies.svg
```

| Circular Dependency | Files Involved | Severity |
|--------------------|----------------|----------|
| | | |

---

### D.1.3 Service Coupling Analysis

**Identify tightly coupled modules:**

| Module A | Module B | Coupling Type | Severity |
|----------|----------|---------------|----------|
| | | Direct import | |
| | | Shared state | |
| | | Event-based | |
| | | Database-coupled | |

**Scoring:**
- 0-2 tight couplings: ✅ Good
- 3-5: ⚠️ Monitor
- 6+: ❌ Refactoring needed

---

## D.2 Event/Message Flow

### D.2.1 Async Event Inventory

| Event | Publisher | Subscribers | Delivery Guarantee |
|-------|-----------|-------------|-------------------|
| | | | At-least-once? |
| | | | At-most-once? |
| | | | Exactly-once? |

---

### D.2.2 Dead Letter Queue Analysis

| Queue | DLQ Configured? | Alert on DLQ? | Retry Policy |
|-------|-----------------|---------------|--------------|
| | | | |

---

## D.3 Transaction Boundary Analysis

### D.3.1 Database Transaction Usage

**Search for transaction patterns:**
```javascript
// Look for proper transaction usage
await prisma.$transaction(async (tx) => {
  // Multiple operations that must succeed together
})
```

| Operation | Transaction Used? | Rollback Tested? |
|-----------|-------------------|------------------|
| User + subscription creation | | |
| Payment + order update | | |
| Analysis + storage | | |

---

### D.3.2 Distributed Transaction Handling

| Cross-service Operation | Saga Pattern? | Compensation Logic? |
|------------------------|---------------|---------------------|
| | | |

---

# SECTION E: SCORING ADDENDUM

## E.1 Engineering Excellence Score

**Calculate additional section scores:**

```
FRONTEND_SCORE = (
  (React_Patterns: /5 × 2.0) +
  (Core_Web_Vitals: /5 × 3.0) +
  (Bundle_Size: /5 × 2.0) +
  (Caching_Headers: /5 × 1.5) +
  (A11Y: /5 × 1.5)
) / 10

BACKEND_SCORE = (
  (Query_Optimization: /5 × 3.0) +
  (API_Design: /5 × 2.0) +
  (Job_Processing: /5 × 2.0) +
  (External_Resilience: /5 × 3.0)
) / 10

INFRASTRUCTURE_SCORE = (
  (Terraform_Drift: /5 × 2.5) +
  (Environment_Parity: /5 × 2.5) +
  (Cache_Consistency: /5 × 2.5) +
  (IaC_Coverage: /5 × 2.5)
) / 10

DATA_FLOW_SCORE = (
  (Request_Flow_Documented: /5 × 2.5) +
  (No_Circular_Dependencies: /5 × 2.5) +
  (Transaction_Handling: /5 × 2.5) +
  (Event_Flow_Resilience: /5 × 2.5)
) / 10
```

---

## E.2 Updated Overall Score Weights (AI-Era v1)

| Section | Total Weight |
|---------|--------------|
| Security | 20% |
| Code Quality (Frontend + implementation correctness) | 13% |
| Architecture (Backend + system design) | 13% |
| Testing / QA | 8% |
| Infrastructure & Supply Chain | 10% |
| Scalability / Performance | 7% |
| Technical Debt | 4% |
| Knowledge Risk | 3% |
| Operations | 4% |
| Data Flow & Wiring | 4% |
| **AI Governance / Evals / HITL / Agent Safety** | **14%** |
| **TOTAL** | **100%** |

**Rationale:** preserve comparability with the existing framework while adding a dedicated AI-era tranche (14%) for governance, provenance, eval discipline, tool security, and calibrated human oversight.

---

## E.3 New Red Flags

Add these to the deal-breaker checklist:

| Red Flag | Present? |
|----------|----------|
| LCP > 4 seconds on mobile | |
| More than 5 god components (>15 useState) | |
| N+1 queries in critical paths | |
| No database indexes on foreign keys | |
| Terraform drift detected (unplanned changes) | |
| Circular dependencies in core modules | |
| Rate limiting fails open | |
| No circuit breakers on external services | |
| Cache TTL < 30 days on static assets | |
| INP > 500ms (poor responsiveness) | |
| Core user flow fails on mobile viewport | |
| No load test evidence for latest major release | |
| Critical flow fails keyboard-only navigation | |
| No explicit AI tooling policy and risk-tier ownership | |
| Missing `.github/copilot-instructions.md` for repos using AI code review | |
| No path-scoped instruction files for high-risk paths (`auth/`, `payments/`, `db/`, `infra/`, workflows) | |
| AI-assisted PRs/runs lack provenance metadata | |
| Release artifacts missing attestation or SBOM | |
| Prompt/policy/model-route changes merged without eval regression run | |
| MCP token passthrough present or token audience validation missing | |
| No reviewer calibration / no inter-rater agreement tracking for HITL | |
| No model/tool/agent telemetry for production AI paths | |
| No rollback/kill-switch path for high-risk AI-assisted changes | |

---

## E.4 Security Coverage Completeness (FAANG-Aligned, Low Friction)

Use this to verify security is comprehensive without introducing unnecessary process drag.

| Domain | Minimum Requirement | Status |
|--------|---------------------|--------|
| Application Security | SAST + dependency scanning + secret scanning enabled in CI | |
| Identity & Access | Least-privilege IAM and short-lived credentials | |
| Data Protection | TLS in transit + encryption at rest + key rotation policy | |
| Supply Chain | Pinned action versions, SBOM or lockfile integrity, signed releases where possible | |
| Runtime Protection | WAF/rate limit/bot controls on public surfaces | |
| Detection & Response | Centralized audit logs + actionable alerts + on-call ownership | |
| Recovery | Backup and restore drill evidence + RPO/RTO targets | |
| Governance | Threat model for critical flows updated at least quarterly | |

**Evidence-first review rule:**
1. Prefer artifacts over statements (CI logs, scanner output, IAM policies, restore drill notes).
2. Flag missing evidence as a risk even if controls are claimed.
3. Keep only critical controls as hard gates; everything else is tracked with SLA.

---

## E.5 DD Evidence Index Template (One-Page)

Use this page as the canonical map from each critical control to auditable proof.

| Control Area | Required Evidence Artifact | Owner | Cadence | Source Location | Last Verified | Risk if Missing |
|--------------|-----------------------------|-------|---------|-----------------|---------------|-----------------|
| SAST | Latest CI scan report with zero critical findings | AppSec | Per PR + nightly | | | High |
| Dependency Security | `npm audit`/SCA report + exception approvals | AppSec + Eng | Weekly | | | High |
| Secret Scanning | Secret scan log + remediation tickets | AppSec | Per PR | | | High |
| IAM Least Privilege | IAM policy diff + quarterly access review signoff | Platform | Quarterly | | | High |
| Credential Hygiene | Evidence of short-lived tokens and key rotation logs | Platform | Monthly | | | High |
| Encryption | TLS config proof + at-rest encryption settings | Platform | Quarterly | | | High |
| Supply Chain Integrity | Pinned action versions + lockfile integrity + SBOM snapshot | Eng | Per release | | | High |
| Runtime Protection | WAF/rate limit dashboard snapshot + alert policy | Platform | Monthly | | | Medium |
| Logging and Alerting | Audit log retention proof + active alert routing | SRE | Monthly | | | High |
| Incident Readiness | On-call runbook + latest incident drill artifact | SRE + Security | Quarterly | | | Medium |
| Backup and Restore | Latest successful restore drill with RPO/RTO results | Platform | Quarterly | | | High |
| Threat Modeling | Current model for critical flows + remediation tracking | Security + Eng | Quarterly | | | Medium |
| A11Y Compliance | Axe report + keyboard-only manual checklist output | Frontend + QA | Per release | | | Medium |
| Responsive Quality | Mobile/tablet/desktop smoke evidence for top journeys | Frontend + QA | Per release | | | Medium |
| Performance and Scaling | p95 latency, error rate, and load test trend report | Platform | Monthly + pre-major release | | | High |

### Evidence Readiness Score (Optional)

```
EVIDENCE_READINESS = (Verified_Artifacts / Required_Artifacts) x 100

Thresholds:
- >=95%: DD-ready
- 85-94%: Acceptable with tracked gaps
- <85%: Material diligence risk
```

### Lightweight Operating Rules

1. One owner per control row; no shared accountability ambiguity.
2. If `Last Verified` is older than cadence, mark as stale and open a ticket.
3. Missing artifact links are treated as control gaps until evidence is attached.
4. Keep this table to one page for executive and acquirer review speed.

---

# SECTION F: AI TOOLING GOVERNANCE

## F.1 Organizational AI Stance

| Check | Status | Evidence |
|------|--------|----------|
| Approved AI tool inventory exists | | |
| Tool inventory has risk tiers (low/medium/high) | | |
| Autonomy policy is defined (assistive vs autonomous) | | |
| Human review rules by change class are documented | | |
| Exception process with expiry/re-approval exists | | |
| Policy is communicated to engineering + security | | |

## F.2 AI Change Classes

| Change Class | Minimum Human Review | Extra Controls |
|-------------|----------------------|----------------|
| Docs / low-risk refactor | | |
| App code | | |
| Auth / payments / secrets | | |
| Infra / IAM / workflows | | |
| Autonomous remediation | | |

---

# SECTION G: AI INSTRUCTION TOPOLOGY

## G.1 Repository Instruction Files

| File / Pattern | Required? | Present? | Notes |
|---------------|-----------|----------|------|
| `.github/copilot-instructions.md` | Yes (when Copilot review/agent is used) | | |
| `.github/instructions/**/*.instructions.md` | Yes for high-risk paths | | |
| `AGENTS.md` or `CLAUDE.md` / `GEMINI.md` | Recommended | | |
| Path-specific rules for `auth/`, `payments/`, `db/`, `infra/`, `.github/workflows/` | Yes | | |

## G.2 Instruction Governance

| Check | Status | Notes |
|------|--------|------|
| Instruction owner defined per file/path | | |
| Instructions are code-reviewed like source code | | |
| Precedence between repo-wide and path-specific rules is documented | | |
| Instruction linting/size guardrails exist | | |
| Critical constraints appear near top of instruction files | | |

---

# SECTION H: AI CHANGE PROVENANCE & ATTESTATION

## H.1 Provenance Requirements

| Check | Status | Evidence |
|------|--------|----------|
| AI-assisted or AI-authored changes are labeled | | |
| Model/tool route metadata captured per run | | |
| Build provenance generated for release artifacts | | |
| Artifact attestations are generated and verifiable | | |
| SBOM is attached or attested | | |
| Provenance links commit -> workflow -> artifact | | |

## H.2 Build Integrity Expectations

| Check | Status | Notes |
|------|--------|------|
| Isolated/ephemeral build environments for trust-critical paths | | |
| Self-hosted runners on trust-critical paths are justified and hardened | | |
| Attestation lifecycle (rotation/retention/expiry) documented | | |

---

# SECTION I: AI EVALS / CONTINUOUS EVALUATION

## I.1 Eval Readiness

| Check | Status | Evidence |
|------|--------|----------|
| Major AI behaviors have explicit eval objectives | | |
| Eval corpus is versioned | | |
| Edge-case suite exists | | |
| Drift suite exists | | |
| Automated scoring exists where feasible | | |
| Human calibration for automated scoring exists | | |

## I.2 Eval Gating

| Check | Status | Notes |
|------|--------|------|
| Prompt/policy/model-route changes trigger evals | | |
| Pass thresholds are explicit | | |
| Eval regression blocks merge/release for affected scope | | |
| Rollback policy on eval regression is documented | | |

---

# SECTION J: AGENT HARNESS HYGIENE

## J.1 Long-Running Session Discipline

| Check | Status | Evidence |
|------|--------|----------|
| Session initializer verifies environment and baseline behavior | | |
| Machine-readable progress artifacts are maintained | | |
| Agent works one feature at a time | | |
| Session leaves clean mergeable state | | |
| Recovery/continuation artifacts exist for next session | | |

## J.2 Completion Discipline

| Check | Status | Notes |
|------|--------|------|
| Feature not marked complete before E2E verification | | |
| Verification evidence captured per phase | | |
| Rollback path recorded before completion | | |

---

# SECTION K: TOOL / MCP SECURITY

## K.1 Tool Security Controls

| Check | Status | Evidence |
|------|--------|----------|
| Tool allowlist and risk classes exist | | |
| Sensitive tools require elevated approval/gating | | |
| Tool output redaction policy exists | | |
| Tool calls auditable by actor/session/run | | |
| SSRF protections exist for URL/network tools | | |

## K.2 MCP Authorization Hardening

| Check | Status | Evidence |
|------|--------|----------|
| OAuth `resource` binding used | | |
| Token audience validation enforced | | |
| Token passthrough forbidden | | |
| Per-client consent/scopes enforced where required | | |
| CSRF/state protections implemented for auth flows | | |

---

# SECTION L: AGENT OBSERVABILITY

## L.1 Required Telemetry

| Signal | Present? | Notes |
|-------|----------|------|
| Model spans | | |
| Tool spans | | |
| Agent spans | | |
| Request/run correlation IDs | | |
| Token + cost + latency metrics | | |
| Fallback/degrade tracking | | |

## L.2 Traceability

| Check | Status | Evidence |
|------|--------|----------|
| PR can be correlated to model/tool activity | | |
| Findings map to HITL decision record | | |
| Incident investigation can trace AI execution lineage | | |

---

# SECTION M: HITL GOVERNANCE & CALIBRATION

## M.1 Reviewer Operations

| Check | Status | Evidence |
|------|--------|----------|
| Reviewer roles and escalation path defined | | |
| Calibration batch required for new reviewers | | |
| Inter-rater agreement tracked | | |
| Overturn rate tracked | | |
| Reviewer drift detection exists | | |

## M.2 Per-Finding Adjudication

| Check | Status | Notes |
|------|--------|------|
| Truth verdict recorded | | |
| Severity verdict recorded | | |
| Reproducibility verdict recorded | | |
| Remediation usefulness scored | | |
| Export/release eligibility tied to review state | | |

---

# SECTION N: AI DELIVERY METRICS

| Metric | Target | Current | Status |
|-------|--------|---------|--------|
| AI-assisted deployment frequency | | | |
| Lead time for AI-authored changes | | | |
| AI-authored change failure rate | | | |
| AI rollback/revert rate | | | |
| Human override rate | | | |
| HITL disagreement rate | | | |
| Reproducibility success rate | | | |
| Fix-plan usefulness score | | | |
| Eval regression rate | | | |
| Provenance/attestation coverage | | | |

---

# SECTION O: AI RELEASE CONTROLS

## O.1 Release Safety Nets

| Check | Status | Evidence |
|------|--------|----------|
| High-risk AI-authored changes use staged rollout/canary | | |
| Rollback path verified pre-release | | |
| Kill switch exists for autonomous pathways | | |
| Workflow/infra changes require elevated review | | |
| High-risk change classes have stricter merge policy | | |

## O.2 AI-Era Hard Red Flags

| Red Flag | Present? |
|----------|----------|
| No explicit AI tooling policy | |
| No repository/path-scoped AI instructions for high-risk paths | |
| AI-assisted changes have no provenance metadata | |
| No attestation/SBOM on release artifact | |
| Prompt/policy/model-route changes ship without eval regression | |
| MCP token passthrough or missing audience validation | |
| Long-running agent lacks progress/recovery artifacts | |
| No E2E verification before marking feature complete | |
| No HITL calibration evidence | |
| No model/tool/agent telemetry for production AI paths | |
| No rollback/kill switch for critical AI-assisted changes | |

---

# APPENDIX: AUTOMATED TOOLS

## Mandatory Quality Gates

**These gates MUST pass before any PR merge to main:**

| Gate | Command | Failure Action |
|------|---------|----------------|
| **Typecheck** | `npx tsc --noEmit` | Block merge - fix all TS errors |
| **Lint** | `npm run lint` or `npx eslint .` | Block merge - fix lint errors |
| **Test (smoke)** | `npm test` or `npm run test:ci` | Block merge - fix failing tests |
| **Build** | `npm run build` | Block merge - must compile |

## QA Lifecycle Coverage (Low-Friction Model)

This model avoids heavy process while still covering full lifecycle quality.

| Stage | Required (Must) | Recommended (Should) |
|------|------------------|----------------------|
| Pre-merge | Typecheck, lint, smoke tests, build | A11Y smoke on changed pages |
| Pre-release | Critical-path E2E, rollback verified | Lightweight load test profile |
| Post-release | Error budget + alert review | Session replay / UX anomaly review |

### QA Coverage Matrix

| Quality Area | Minimum Coverage | Owner |
|-------------|------------------|-------|
| Functional correctness | Unit + smoke integration | Engineering |
| Security | SAST + dependency audit + auth/rate-limit checks | AppSec + Engineering |
| Accessibility | Automated axe + manual keyboard check on core flows | Frontend |
| Responsive design | Mobile/tablet/desktop smoke on top journeys | Frontend + QA |
| Performance | CWV trending + p95 API latency SLO | Platform |
| Reliability | Retry/timeout/fallback verification | Backend |

### Gate Enforcement Rules

1. **Pre-commit hook** (recommended): Use `husky` + `lint-staged`
   ```bash
   npx husky add .husky/pre-commit "npx tsc --noEmit && npm run lint"
   ```

2. **CI/CD pipeline** (required): GitHub Actions, GitLab CI, etc.
   ```yaml
   # .github/workflows/ci.yml
   jobs:
     quality-gates:
       steps:
         - run: npx tsc --noEmit
         - run: npm run lint
         - run: npm test
         - run: npm run build
   ```

3. **Branch protection**: Require status checks to pass before merge

---

## Enterprise Readiness Criteria

**Main branch must be green under all quality gates at all times.**

| Criterion | Requirement | Verification |
|-----------|-------------|--------------|
| Typecheck | Zero TS errors | `npx tsc --noEmit` exits 0 |
| Lint | Zero lint errors (warnings OK) | `npm run lint` exits 0 |
| Tests | All tests pass | `npm test` exits 0 |
| Build | Production build succeeds | `npm run build` exits 0 |
| Deps | No missing deps | All imports resolve |
| Security | No critical vulns | `npm audit --audit-level=critical` |

### Fixer Workflow Integration

When fixing compile/lint errors, follow this sequence:

```
1. Run: npx tsc --noEmit
2. Fix all errors (do NOT skip or suppress)
3. Run: npm run lint
4. Fix lint errors (auto-fix: npm run lint -- --fix)
5. Run: npm test
6. Fix failing tests
7. Run: npm run build
8. Verify build output
9. Commit only when all gates pass
```

---

## Tools to Run

| Category | Tool | Command |
|----------|------|---------|
| **Typecheck** | TypeScript | `npx tsc --noEmit` |
| **Lint** | ESLint | `npx eslint --ext .tsx,.jsx,.ts,.js` |
| **Tests** | Vitest/Jest | `npm test` |
| React Patterns | eslint-plugin-react-hooks | `npx eslint --ext .tsx,.jsx` |
| Bundle Size | webpack-bundle-analyzer | `ANALYZE=true npm run build` |
| Core Web Vitals | Lighthouse CLI | `npx lighthouse https://yoursite.com` |
| A11Y | axe-core | `npx @axe-core/cli https://yoursite.com` |
| Responsive UI smoke | Playwright | `npx playwright test --project="Mobile Chrome"` |
| Load test | k6 | `k6 run perf/smoke.js` |
| Circular Deps | madge | `npx madge --circular src/` |
| N+1 Queries | prisma-query-log | Enable in dev |
| Terraform Drift | terraform plan | `terraform plan -refresh-only` |
| Cache Headers | curl | `curl -I <asset-url>` |
| Security Audit | npm audit | `npm audit --audit-level=critical` |
| AI Eval Regression | OpenAI Evals / custom harness | `npm run eval` or `python -m evals.run` |
| Artifact Attestation | GitHub Actions / cosign | `cosign attest --predicate sbom.json --type spdx <artifact>` |
| SBOM Generation | Syft / buildx | `syft dir:. -o spdx-json=sbom.json` |
| OpenSSF Scorecard | scorecard-action | `scorecard --repo=<org/repo>` |

---

*PlexAura Technical DD Protocol - Addendum v1.2*
*Created by Carter | © PlexAura*

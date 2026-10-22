# @laira/domain

Foundational domain models, bounded step schemas, canonical plan hashing, and approval validation for Liara Agentic DevOps & SRE.

## Exported Modules & Contracts

### 1. Run State (`run-state.ts`)
- `RunStateSchema`, `RunState`: Enum of 10 explicit states: `queued`, `running`, `waiting_input`, `waiting_approval`, `waiting_external`, `verifying`, `succeeded`, `failed`, `cancelled`, `outcome_unknown`
- `TERMINAL_RUN_STATES`: Succeeded, failed, cancelled, outcome_unknown
- `WAITING_RUN_STATES`: Waiting_input, waiting_approval, waiting_external
- `isTerminalRunState(state)`, `isWaitingRunState(state)`: State query predicates

### 2. Resource Reference (`resource.ts`)
- `ResourceRefSchema`, `ResourceRef`: Scoped reference binding `workspaceId`, `connectionId`, `type`, `slug`, optional `providerResourceId`, and `displayName`
- `ResourceTypeSchema`: `app | database | disk | bucket | domain`

### 3. Source Reference (`source.ts`)
- `SourceRefSchema`, `SourceRef`: Discriminated union of immutable `git` (with required 40-64 hex `commitSha`) and `archive` (with required `sha256:` digest and max 50 MiB byte limit)
- `getSourceImmutableDigest(source)`: Extracts uniform lowercase digest for deduplication/auditing

### 4. Evidence Reference (`evidence.ts`)
- `EvidenceRefSchema`, `EvidenceRef`: Scoped evidence metadata binding `scope`, `source`, `capturedAt`, `expiresAt`, `integrityDigest` (sha256), `contentType`, and `sizeBytes`

### 5. Finding (`finding.ts`)
- `FindingSchema`, `Finding`: Objective statement with linked `evidenceIds`, `confidence` (0 to 1), explicit `limitations`, and category (`observation | hypothesis | verified_cause | remediation`)

### 6. ActionPlan & Bounded Steps (`plan.ts`)
- `ActionPlanSchema`, `ActionPlan`: Immutable change plan containing:
  - `steps`: Ordered bounded typed steps (strictly PaaS/managed infrastructure operations; no arbitrary shell execution)
  - `resourceBindings`: Logical-to-provider resource mappings
  - `secretRefs`: Concealed references from `@laira/security`
  - `preconditions`: Pre-flight state checks
  - `estimatedCost`: Model tokens, catalog estimate USD, and provider cost
  - `disruption`: Disruption level and downtime flag
  - `verification`: Explicit verification probes (HTTP, provider status, DB)
  - `canonicalHash`: Deterministic SHA-256 digest of plan content

### 7. Canonical Plan Hashing (`canonical.ts`)
- `canonicalJsonStringify(value)`: Deterministic recursive JSON stringification with sorted keys, array order preservation, and strict rejection of non-JSON unsafe values (`undefined`, `NaN`, `Infinity`, `functions`, `symbols`, `BigInt`, circular references)
- `computeActionPlanHash(plan)`: Computes SHA-256 hex digest of the canonical plan
- `verifyActionPlanHash(plan)`: Checks if embedded hash matches recomputed canonical hash

### 8. Approval & Dispatch Validation (`approval.ts`)
- `ApprovalSchema`, `Approval`: Immutable approval record binding full `planCanonicalHash`, `planVersion`, `workspaceId`, `ownerId`, `decidedAt`, and `expiresAt`
- `createApproval(params)`: Factory enforcing default 30-minute dispatch expiration
- `validateApprovalForDispatch(params)`: Enforces zero approval drift, checks workspace/owner identity, rejects expired approvals (30-min), and validates preconditions

### 9. Operation (`operation.ts`)
- `OperationSchema`, `Operation`: Stable execution ledger unit with `operationId`, `planId`, `stepId`, `correlationId`, `status`, and `resourceReservations`

### 10. RunEvent (`event.ts`)
- `RunEventSchema`, `RunEvent`: Monotonically sequenced durable event log unit with safe JSON payload

### 11. Capability (`capability.ts`)
- `CapabilitySchema`, `Capability`: Account capability status (`supported | unsupported | unverified`) with verification evidence

### 12. UsageRecord (`usage.ts`)
- `UsageRecordSchema`, `UsageRecord`: Token usage and cost tracking separating catalog estimates from provider-reported costs

### 13. WorkflowVersion (`workflow.ts`)
- `WorkflowVersionSchema`, `WorkflowVersion`: Versioned procedural workflow with bounded typed tool calls, preconditions, and output limits (no arbitrary scripts or regex)

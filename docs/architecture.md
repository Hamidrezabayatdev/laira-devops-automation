# Architecture: foundation delivery

## Process boundaries

```text
Browser -- GitHub OAuth --> Next.js web/API
                               |
                        scoped application rows
                               |
                         PostgreSQL app schema
                               |
                         transactional outbox
                               |
                      persistent pg-boss worker
                               |
                safe provider adapters (read-only initially)

Private artifacts --> workspace-scoped S3-compatible object storage
```

One pnpm TypeScript repository builds separate web and worker processes. A web restart must not erase queued runs or their events. PostgreSQL owns identity/session/workspace records and durable run state; the queue is a delivery mechanism rather than the source of business authority. The app schema, queue schema, and future LangGraph checkpoint schema remain separate.

## Shared components

- `packages/domain`: validated shared references, typed plans and steps, canonical hash, structural approval validation, run states, evidence and usage contracts.
- `packages/security`: AES-GCM credential envelopes with workspace/connection/version AAD, opaque secret references, allowlisted provider DTOs, safe error DTOs.
- `packages/db`: migrations, identity/workspace ownership, scoped repositories, durable events and transactional outbox.
- `packages/providers`: fixed-origin Liara safe reads and explicitly configured BoxAPI model access. Fixture tests never establish live capability evidence.
- `packages/storage`: private, bounded, workspace-scoped artifact access and integrity checks.
- `apps/web`: authentication, owner-scoped HTTP APIs and SSE, RTL console shell and labeled fixture screen.
- `apps/worker`: separately running durable fixture handling, outbox dispatch, heartbeat and shutdown/recovery plumbing.

Exact exported APIs are documented in package READMEs. Package behavior and test evidence take precedence over this high-level diagram; a listed component does not establish production readiness.

## Intentionally unavailable

The first foundation batch is not a general agent harness. It has no shell tool, infrastructure write tool, arbitrary URL probe, public unauthenticated fault endpoint, or repository execution. LangGraph operational workflows/checkpoint integration, source ingestion, mutation ledger/reservations/reconciliation, deployment and incident investigation are subsequent milestones. No UI should present those as completed.

AI usage controllers at adapter level cannot substitute for durable cross-process admission. Before connecting live AI into durable worker runs, enforce stop state, usage budgets and workspace concurrency in a shared transactionally guarded store. A process restart must not reset spending authority. Likewise, a canonical plan hash is not a durable dispatch ledger or a live precondition check.

## Provider evidence

Liara's documented team-scoped app-list request was accepted with an empty result. Other API routes and capability compatibility need bounded account tests against approved disposable resources. The exact default Qwen model was denied by the restricted key; the user explicitly selected GPT-5.4 Mini, which passed a synthetic tool/stream round trip. See `implementation-status.md` for limitations and token evidence.

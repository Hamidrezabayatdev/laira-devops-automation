# Liara Agentic DevOps & SRE

A Persian-first technical colleague for Liara application owners: understand source, propose bounded changes, obtain approval, execute safely, and verify outcomes.

**Implementation status: independently reviewed fixture-only foundation.** This is not a completed hackathon MVP or production deployment tool. The integrated review accepted the scoped foundation after correcting its material findings; clean-workspace install/build/typecheck/unit checks also passed. Live OAuth verification remains a separately recorded limitation. The original product brief and approved implementation plan are preserved in this repository. No infrastructure write tools are enabled in the foundation batch.

## Stack and process model

Node 24, TypeScript, pnpm monorepo, Next.js/React, Auth.js GitHub OAuth, PostgreSQL/Drizzle, persistent pg-boss worker, private S3-compatible artifact storage. Shared typed contracts and security primitives are separate packages. Operational LangGraph workflows/checkpointing are a subsequent integration milestone—not provided merely by reserving a PostgreSQL schema.

## Setup

1. Use Node 24 and the pnpm version pinned in `package.json`.
2. Copy `.env.example` to `.env` only if it does not already exist. Configure local services, OAuth, and generated secrets; never commit `.env`.
3. Follow [local setup](docs/local-setup.md) to start isolated PostgreSQL and object storage. Local DB port is configurable; this environment uses **55433**, leaving unrelated databases untouched.
4. Install dependencies with `pnpm install`. The final lockfile and runnable commands are being integrated; see the status ledger before treating setup as verified.
5. Do not supply production provider credentials to fixture UI or source build contexts.

### Checks

```sh
pnpm test:unit
pnpm typecheck
pnpm build
```

Database integration tests are explicitly opt-in and must use an isolated database. With `TEST_DATABASE_URL` set in ignored `.env`:

```sh
pnpm test:integration -- packages/db/test apps/worker/test
```

Read the tests before changing that URL; never point integration tests at an unrelated or production database. Provider tests use fixtures, not live API calls. A separately opt-in model smoke is billable and should not be repeatedly run as part of routine tests.

## Model and provider evidence

The restricted development key denied the originally planned Qwen model. The owner explicitly selected `openai/gpt-5.4-mini`, which passed a synthetic tool-call + streamed final round trip with usage using `max_completion_tokens`. This is deliberate configuration, **not runtime fallback**. Catalog cost estimates are not billing guarantees. Adapter-level in-memory usage controls do not establish durable multi-worker spending enforcement.

The documented Liara app-list request succeeded with the configured team scope and an empty project list. No resource creation, deployment, release verification, real diagnosis, recovery or paid resources have been demonstrated. Unsupported/unverified capabilities must be shown honestly.

## Security boundaries

- Workspace ownership derives from verified GitHub provider identity; IDs are not authorization.
- All tenant reads, jobs, events and artifacts must be scoped. Secrets use authenticated encryption and versioned references.
- Provider DTOs allowlist safe fields before storage/logs/model context. Unknown errors must not echo provider/DB messages.
- Infrastructure mutations require an immutable full-plan hash, owner approval, live preconditions, reservations, durable operation ledger and uncertain-outcome reconciliation. The foundation's structural approval validator is not that broker.
- No source installation/execution, host-shell tools, arbitrary public/private probes, or runner fallback.
- Fixtures are labeled simulated and never count as live success.

## Documentation

- [Approved implementation plan](IMPLEMENTATION-PLAN.md)
- [Original product brief and challenge](liara-agentic-devops-product-spec%281%29.md)
- [Implementation ledger and live feasibility evidence](docs/implementation-status.md)
- [Architecture and deferred components](docs/architecture.md)
- [Local setup / OAuth / proxy](docs/local-setup.md)
- [Security boundaries](docs/security-boundaries.md)
- [Foundation acceptance checklist](docs/foundation-acceptance.md)
- [Recovery and operations boundaries](docs/foundation-runbook.md)

## Next delivery milestone

Integrate and independently verify the foundation, then implement static source import, the durable approval/dispatch/reconciliation broker, real approved deployment and deterministic monitoring. A real disposable-app demo must prove deployment revision, actual incident evidence and approved verified recovery. The required five-minute hackathon video and GitHub publication remain separate deliverables.

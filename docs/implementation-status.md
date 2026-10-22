# Implementation ledger

This ledger distinguishes planned scope, local verification, and live operational evidence.
The approved plan remains the authority except for explicit user-approved changes below.

## Delivery boundaries

1. **Foundation batch (in progress):** pnpm/Node 24 workspace; typed contracts; immutable approval validation; credential encryption; tenant-scoped PostgreSQL persistence and outbox; persistent worker; safe read-only provider adapters; GitHub OAuth shell and explicitly labeled fixture UI.
2. **Operational milestone (not implemented):** static archive/repository import, deployment planning, durable mutation broker/reservations/reconciliation, real deployment, monitoring, incident diagnosis and approved correction.
3. **Later (not implemented):** schedules, knowledge, voice, isolated runner, PR correction, Telegram.

A fixture task completing does **not** establish real deployment, real diagnosis, or full Phase 0 completion. Infrastructure mutation remains unavailable until the broker and its acceptance tests exist.

## User-approved decisions during implementation

- Use Gemini for implementation, with primary integration and independent milestone verification.
- Initialize a local Git repository and make normal coherent commits. Remote publication is a separate setup step.
- Local isolated Docker PostgreSQL and S3-compatible storage are permitted. Existing unrelated local services must remain untouched.
- A local proxy is available on localhost port 10808 if internet access fails; see `AGENTS.md`.
- The exact `qwen/qwen3.7-flash` gets the first bounded smoke test. If unavailable under the restricted key, inspect the current BoxAPI catalog and test a cheap accessible alternative. A replacement must be explicitly configured and documented, **not** an automatic runtime fallback. This supersedes the approved plan's restriction against selecting another model after access denial, but not its no-silent-fallback or call-budget rules.
- GitHub CLI identifies the intended demo account as `Hamidrezabayatdev`, numeric ID `152868728`. This is setup context, not an application authentication mechanism. Operator-funded runtime access requires the same identity verified through GitHub OAuth.

## Live model evidence

The user identified `gpt-5.4-mini` as accessible and explicitly selected it. Configure `openai/gpt-5.4-mini` for this restricted-key development/demo environment; this supersedes the original plan's model prohibition for this deliberate selection only. There is still no runtime fallback.

- `qwen/qwen3.7-flash`: first tool request denied HTTP 403.
- Catalog alternatives `inclusionai/ling-3.0-flash`, `inference-net/schematron-v2-turbo`, `qwen/qwen3.5-9b`: each first request denied HTTP 403; no continuation requests.
- `openai/gpt-5.4-mini`: legacy `max_tokens` request returned HTTP 400. An explicit `max_completion_tokens: 64` compatibility check succeeded (9 input / 4 output / 13 total tokens).
- Final bounded round trip using `max_completion_tokens: 256`: typed function call passed (135 input / 17 output / 152 total tokens), then synthetic tool-result + streamed final passed with `[DONE]` and nonempty content (67 input / 10 output / 77 total tokens).
- These were synthetic feasibility checks, not app health observations. Provider cost/currency was not established. Catalog estimates are not billing guarantees.
- Model listing returned HTTP 200 but listed models are not proof of key permissions.

## Live Liara evidence

A read-only request to the documented `GET /v1/projects` endpoint returned HTTP 200 with the configured `teamID` query applied and zero projects. No provider bodies, IDs, or environment values were retained. This proves that scoped list request was accepted; it does not prove other capabilities, actual team ownership attribution, deployment, logs, metrics units, or mutation/reconciliation behavior. Disposable demo resources remain a prerequisite.

## Verification recording

Primary checks so far:

- `pnpm exec vitest run packages/domain/test packages/security/test`: 7 files / 64 tests passed.
- `pnpm --filter @laira/security typecheck` and `pnpm --filter @laira/domain typecheck`: passed.
- `git check-ignore .env`: confirms ignored; `git ls-files .env`: empty.
- `docker compose up -d --wait`: failed at MinIO registry pull (access denied).
- Explicit digest/cache override started MinIO; PostgreSQL startup initially failed because unrelated port 55432 was occupied. Existing service untouched. Project moved to localhost 55433.
- `docker compose -f compose.yaml -f compose.local.yaml up -d --wait`: both containers healthy after the port change.
- Isolated `laira_test` database and private `laira-private` bucket created locally.

- Preliminary `pnpm test:unit`: 18 files passed / 3 skipped; 112 tests passed / 13 skipped because no integration environment was loaded.
- Primary `node --env-file=.env node_modules/vitest/vitest.mjs run packages/db/test apps/worker/test`: 5 files / 18 tests passed against isolated local PostgreSQL. These tests include repository tenancy, atomic outbox writes, duplicate fixture handling and simulated recovery. They do not yet prove actual separate-process pg-boss delivery/restart.

Primary review rejected preliminary provider/storage implementations that substituted hand-written SDK transports/commands and ambient type shims for actual installed SDK integration. Workers are replacing these and must demonstrate real SDK behavior; mock-only success is not accepted as live compatibility evidence. Independent shared-contract review is running. Gemini implementation was temporarily blocked by an API location-policy denial; the user reported restoring the previous supported location and the four interrupted sessions were resumed without changing models. No proxy workaround was attempted.

Full integrated install/build/typecheck/tests, browser checks and independent milestone review are pending. Neither package checks nor local container health establishes Phase 0 completion. Never put credentials, raw provider errors, source prompts, or secret-bearing DTOs in this ledger.

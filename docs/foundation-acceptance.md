# Foundation acceptance checklist

Use this checklist for integrated review. A checked component test is not evidence of an untested end-to-end behavior. Leave unrun scenarios explicitly pending.

## Required foundation checks

- [ ] Fresh pnpm install succeeds with committed frozen lockfile and Node 24.
- [ ] Root typecheck, all relevant package tests, and production web/worker build succeed.
- [ ] Migrations succeed against the isolated local PostgreSQL database; repeated application is safe.
- [ ] Two verified owner identities yield isolated workspaces. Cross-workspace run, project, connection, and event IDs return no data.
- [ ] Anonymous/malformed-origin browser mutation is rejected. Fixture route cannot access production API identity or live keys.
- [ ] Durable run and outbox item commit atomically; duplicate delivery has one terminal outcome/event sequence; stored state survives independent client/worker restart.
- [ ] SSE requires owner session, respects Last-Event-ID, uses monotonic sequence IDs, and cannot replay another workspace's events.
- [ ] Worker heartbeat and readiness are distinct from web liveness.
- [ ] Encrypted envelope decrypts only with matching workspace/connection/version and authentic key; tamper fails.
- [ ] Safe DTOs omit unknown provider fields/environment values; unknown errors do not echo raw messages or stack/cause.
- [ ] Canonical plan hashing rejects non-JSON ambiguity, binds every relevant field, and changes invalidate approval.
- [ ] Approval expires at 30 minutes, rejects future/malformed identity/plan data, and is only structural validation—not claimed live precondition verification.
- [ ] Provider transport uses official OpenAI SDK with no retries/fallback; fixed origin, blocked redirects, full-body time/byte/output caps; malformed/interrupted outputs fail honestly.
- [ ] Demo key requires explicit verified numeric owner identity. In-memory admission controllers are not represented as durable cross-process enforcement.
- [ ] Explicit selected model parameter compatibility is covered by a regression fixture.
- [ ] Private artifact access rejects foreign workspace references, traversal, expired manifests, checksum mismatch and oversized payloads; SDK errors remain safe.
- [ ] Persian RTL layout, technical LTR strings, keyboard navigation, narrow-screen assistant/navigation tested.
- [ ] No secrets are staged or tracked; generated credentials remain only in ignored local configuration.
- [ ] One independent fresh-context verifier reviews the integrated batch and any concrete material findings are resolved/rechecked.

## Test-harness integrity

Do not accept ambient declarations that replace real dependency types with `any`, fake SDK command classes, uninstalled claimed integrations, or mock-only success as production compatibility. Compile against the actual installed dependency types. Run real local DB/storage smoke tests separately from fixture suites. A passing unit suite with integration tests skipped must report those skips explicitly.

## Live feasibility evidence (already observed)

- Exact original Qwen model denied HTTP 403; alternatives denied and no silent fallback.
- User-selected GPT-5.4 Mini synthetic typed tool call, result and streamed final passed using max_completion_tokens; usage returned.
- Documented team-scoped Liara app-list request returned HTTP 200 and zero apps. Other capability claims remain unverified.

## Explicitly not part of this acceptance batch

Real source import/deployment, mutation dispatch ledger/reservations/reconciliation, actual LangGraph operational workflow/checkpoint recovery, automatic monitoring/diagnosis/correction, GitHub App repository access, voice, runner, PR generation, and Telegram are not demonstrated by foundation checks. These remain separate milestones.

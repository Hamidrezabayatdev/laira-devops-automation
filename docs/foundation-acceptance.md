# Foundation acceptance checklist

Use this checklist for integrated review. A checked component test is not evidence of an untested end-to-end behavior. Leave unrun scenarios explicitly pending.

## Current review gate

The first integrated independent review returned **changes required** despite passing automated suites. All five findings were corrected and independently rechecked. The verifier **accepted the reviewed fixture-only foundation batch with no remaining material blocker**, with the then-open clean-install verification limitation recorded separately. Subsequent primary clean-workspace installation/build/typecheck/unit/offline-reinstall checks passed after bounded test-worker configuration; the fresh focused verifier accepted that configuration follow-up, independently rerunning all 265 unit tests (34 skipped) and CSS compilation from root and web working directories. Evidence: primary root build/typecheck, 265 unit tests (34 skipped), 114 isolated integration tests; verifier independently reran tests/typechecks and origin probes. Chrome UI, real MinIO and dependency audit evidence are primary checks. This acceptance is not full Phase 0 completion or live operational/OAuth proof. Project/workspace binding must be added before exposing project-targeted runs.

## Required foundation checks

- [x] Fresh pnpm frozen-lockfile install succeeds with Node 24. The separate manifest-only workspace installed successfully after command-scoped proxy retries (263 packages). Expected DB CLI bin warnings occurred before source compilation. Its subsequent source-copy build and typecheck passed without `.env`. An initial unit run hit CSS/module-load/RPC timeouts; bounded Vitest workers and simplified Tailwind config loading corrected the failure without raising timeouts or weakening assertions. Primary then passed the complete build → typecheck → 265 unit tests (34 skipped) → offline frozen reinstall chain in that separate dependency tree.
- [x] Root typecheck, all relevant package tests, and production web/worker build succeed.
- [x] Migrations succeed against the isolated local PostgreSQL database; repeated application is safe.
- [ ] Two live OAuth-verified owner identities yield isolated workspaces. Synthetic verified-provider-identity/session fixtures cover cross-workspace run, project, connection and event reads; two real OAuth logins were not exercised. Project-targeted run binding remains deferred before exposure.
- [x] Anonymous/malformed-origin browser mutation is rejected. Fixture route cannot access production API identity or live keys.
- [x] Durable run and outbox item commit atomically; duplicate delivery has one terminal outcome/event sequence; stored state survives independent client/worker restart.
- [x] SSE requires owner session, respects Last-Event-ID, uses monotonic sequence IDs, and cannot replay another workspace's events.
- [x] Worker heartbeat and readiness are distinct from web liveness.
- [x] Encrypted envelope decrypts only with matching workspace/connection/version and authentic key; tamper fails.
- [x] Safe DTOs omit unknown provider fields/environment values; unknown errors do not echo raw messages or stack/cause.
- [x] Canonical plan hashing rejects non-JSON ambiguity, binds every relevant field, and changes invalidate approval.
- [x] Approval expires at 30 minutes, rejects future/malformed identity/plan data, and is only structural validation—not claimed live precondition verification.
- [x] Provider transport uses official OpenAI SDK with no retries/fallback; fixed origin, blocked redirects, full-body time/byte/output caps; malformed/interrupted outputs fail honestly.
- [x] Demo key requires explicit verified numeric owner identity. In-memory admission controllers are not represented as durable cross-process enforcement.
- [x] Explicit selected model parameter compatibility is covered by a regression fixture.
- [x] Private artifact access rejects foreign workspace references, traversal, expired manifests, checksum mismatch and oversized payloads; SDK errors remain safe.
- [x] Persian RTL layout, technical LTR strings, keyboard navigation, narrow-screen assistant/navigation tested.
- [x] No secrets are staged or tracked; generated credentials remain only in ignored local configuration.
- [x] One independent fresh-context verifier reviews the integrated batch and any concrete material findings are resolved/rechecked.

## Test-harness integrity

Do not accept ambient declarations that replace real dependency types with `any`, fake SDK command classes, uninstalled claimed integrations, or mock-only success as production compatibility. Compile against the actual installed dependency types. Run real local DB/storage smoke tests separately from fixture suites. A passing unit suite with integration tests skipped must report those skips explicitly.

## Live feasibility evidence (already observed)

- Exact original Qwen model denied HTTP 403; alternatives denied and no silent fallback.
- User-selected GPT-5.4 Mini synthetic typed tool call, result and streamed final passed using max_completion_tokens; usage returned.
- Documented team-scoped Liara app-list request returned HTTP 200 and zero apps. Other capability claims remain unverified.

## Explicitly not part of this acceptance batch

Real source import/deployment, mutation dispatch ledger/reservations/reconciliation, actual LangGraph operational workflow/checkpoint recovery, automatic monitoring/diagnosis/correction, GitHub App repository access, voice, runner, PR generation, and Telegram are not demonstrated by foundation checks. These remain separate milestones.

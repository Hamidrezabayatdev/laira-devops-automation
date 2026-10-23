# Milestone review log

## Operator/provisioning live-journey follow-up — 2026-10-23

**Initial verdict: changes required.** Primary's then-current build/typecheck and fixture suites passed (676 offline tests, 761 guarded integration tests). Fresh review independently ran 197 scoped tests with 11 skips and found two material issues in subsequent changes: provisioning success combined matching resource-plan and feature-bundle evidence across different incomplete provider snapshots; a new catalog fixture omitted the connection-by-ID query needed for active credential lookup. The reviewer reproduced false provisioning success using injected complementary snapshots. Both findings were assigned to the worker implementation owner with regression requirements. Missing provider `TIMEDOUT` state normalization was assigned to the provider owner. Both material fixes and the timeout advisory now have regression coverage. Runtime-reference deployment integration is implemented. Primary's final full rerun passed: 691 offline tests (88 skipped), 777 guarded integration tests (2 skipped), full build/typecheck, and whitespace checks. The final CLI fixture's false-positive `secret` substring ID was renamed. Independent reviewer recheck found no material blockers or new blocking advisories: 224 scoped tests passed (21 skipped with DB tests deliberately disabled), domain/providers/worker typechecks and web non-incremental typecheck passed, and whitespace checks were clean. It verified same-snapshot provisioning, strict hash-bound runtime references, scoped pre/post-upload version checks, restricted secret destination, vault AAD, and durable no-resend protection. The reviewer did not independently rerun the full suite/build. This is fixture/source acceptance only; no paid mutation, actual billing outcome, or authenticated real deployment is accepted by these checks.

## Shared domain/security batch — first independent review

**Verdict: material findings; not accepted.**

The primary ran 64 tests plus both scoped typechecks successfully. The fresh-context verifier independently reran the 64 tests and used bounded in-memory probes; those uncovered gaps beyond the existing fixtures:

1. Canonical array/root handling accepted accessors and ignored some properties. Strict canonicalization must reject them without getter execution.
2. An env step could reference a secret absent from approved versioned scoped references, or specify both/neither value sources.
3. A secret-detection failure included the secret in the exception message.
4. A deployment step could specify a source different from the immutable plan source.

Advisories: normalize once before display/hash/approval/persistence, reject invalid clocks, and authenticate envelope key-version metadata.

All findings were routed together to the responsible Gemini contract worker with regression-test requirements. A second pass found normalization collisions and approval descriptor bypass; these were corrected together. The final scoped verifier recheck **accepted the shared domain/security foundation** with no material unresolved findings. It independently reran 78 tests and assertion-based current-source probes confirming unsafe inputs fail without getter calls, and normalization → JSON persistence → hash verification → approval → structural dispatch validation works with omitted defaults. Primary additionally ran both package typechecks and builds successfully.

Integration must retain the normalized representation for display, persistence, approval and eventual execution. Strict representation hashing intentionally does not apply defaults. The operation broker and live precondition checks remain intentionally deferred; structural validation must not claim those guarantees. This acceptance does not cover the other implementation lanes.

## Integration observations before broad review

- Storage preliminary mocks hid imitation command objects incompatible with actual AWS S3 execution; corrected integration and real local MinIO checks required.
- Provider preliminary implementation emulated the OpenAI protocol rather than using the required SDK; actual SDK import/call and bounded guarded transport required.
- Web preliminary ambient shims erased actual authentication/library types; real installed dependency types, Auth.js database sessions, and fail-closed DB behavior required.
- First full dependency install failed on an unpublished `@types/react-dom@19.2.8` pin. No full build success claimed.

These are rejected preliminary implementations, not accepted production behavior. Integration workers own fixes; broad batch review comes after actual install/build/tests.

## Integrated foundation — first fresh-context review

**Verdict: changes required; not accepted.** The verifier independently ran 232 unit tests (31 skipped), 78 isolated integration tests, all typechecks and whitespace checks successfully. Actual-source adversarial probes still found:

1. Transient dispatch failures became permanently unclaimable `failed` outbox rows, stranding queued runs. An existing mark-failure injection also failed to match multiline SQL and did not exercise its claimed path.
2. Mutation origin validation compared hostnames, accepting alternate ports, HTTP downgrades and localhost origins on production. Malformed Referer parsing could throw.
3. SSE could close after observing terminal state without draining newly committed events; overlapping asynchronous intervals could emit duplicate sequence IDs.
4. Generic create-run modal lacked focus management, inert background and an accessible name, despite separate drawer improvements.
5. Ordinary workspace sidebar/overview showed hardcoded fixture infrastructure without simulation labels.

Primary routed these to three disjoint Gemini implementation lanes: DB/worker durable retries, API origin/SSE safety, and modal/fixture UI semantics. Required regression coverage targets the actual failure paths and interleavings, not copied helper implementations. Same independent verifier must recheck the integrated corrections before acceptance. Primary browser recheck of the generic create-run modal passed accessible naming, initial focus, inertness, Escape close and focus restoration using CDP-intercepted synthetic identity/API responses; this is UI evidence only, not live OAuth or authorization proof. Primary also added production-render sidebar tests for demo-only fixture resources and changed ordinary service status from invented zero counts to unobserved/unknown. Final browser rerun passed generic modal Shift+Tab containment and confirmed the ordinary desktop workspace has no fixture resource names and displays unobserved status. API corrections then passed primary typecheck and all 84 isolated web tests (exact origins, bounded JSON POST, SSE terminal interleavings and multi-batch continuation included). Primary found unrelated leftover rows affecting a global count assertion; the worker corrected mock dispatch targeting and suite-owned workspace cleanup, then reported two sequential 30-test DB/worker passes. Final primary integrated rerun passed root build/typecheck, 265 unit tests (34 skipped), all 114 isolated DB/web/worker tests in 18 files, and whitespace checks. Mandatory outbox claim fencing and natural durable backoff regressions passed. The same independent verifier rechecked the complete corrections and **accepted the reviewed fixture-only foundation batch with no remaining material blocker**, subject to the clean-install verification limitation. It independently reran 265 unit tests (34 skipped), all 114 isolated integration tests, all typechecks, whitespace checks, and actual-source origin bypass probes. All five findings and the false-positive failure injection were resolved. Browser, build, audit and MinIO evidence remain primary-run checks, not independent reruns. This is not full Phase 0 completion or live OAuth/operational acceptance.

### Remaining boundaries and advisories

- At verifier acceptance, clean installation had not yet been demonstrated. A later primary manifest-only frozen install completed (263 packages), followed by successful source-copy build/typecheck without `.env`. Its first unit run failed with CSS compilation and Vitest module-load/RPC timeouts, preventing the chained offline reinstall. Executor bounded the test worker pool to 4 and simplified Tailwind config loading (no timeout inflation or assertion changes), then reported two complete clean unit passes. Primary independently passed clean-workspace build/typecheck, 265 unit tests (34 skipped), and offline frozen reinstall. The failed initial run remains historical evidence, not a hidden pass. A fresh verifier accepted this focused configuration follow-up with no material findings. It independently ran all 265 unit tests (34 skipped), root-CWD CSS pipeline tests (3 passed), and web-CWD direct compilation (zero warnings), confirming no discovery/assertion/timeout weakening. Clean build/typecheck/offline reinstall remain primary evidence, not independent reruns. These are subsequent primary checks, not independent-verifier evidence.
- Before enabling project-targeted runs, `createRun` must validate project/workspace binding (or enforce a composite constraint). The current fixture HTTP route does not accept project IDs.
- No actual source import/deployment, infrastructure mutation broker, live monitoring/diagnosis/correction or LangGraph operational recovery has been accepted.
- Browser modal checks use intercepted synthetic identity and do not prove live GitHub OAuth.
- Keyboard unit tests exercise production helpers using a mock element tree; actual browser evidence is recorded separately. Advisory future project/workspace binding and unused CSRF-helper edge cases were also noted; operational deployment/mutation features remain deferred.

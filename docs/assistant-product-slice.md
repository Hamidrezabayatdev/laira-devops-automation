# Assistant operational slice — deterministic batch accepted

This document describes the independently reviewed implementation and deterministic acceptance evidence, **not a claim of live acceptance**. The foundation and source-inspection prerequisite were accepted separately.

## Intended walkthrough

1. Run Node 24 with pnpm; configure local isolated PostgreSQL, OAuth and `ENCRYPTION_MASTER_KEY` per the existing setup guide. Apply migrations and run the web and persistent worker as separate processes.
2. Sign in as the workspace owner. Open `/settings/connections` and store workspace-scoped BoxAPI and Liara keys. Keys are encrypted server-side; `configured_unverified` means saved, not provider-tested. Never paste keys into chat. Team-scoped connection selection is not yet exposed by this form.
3. In the assistant, optionally enter a public GitHub repository and describe the task. The authenticated API queues `agent_task`; the worker resolves workspace identity from the stored run.
4. The actual Deep Agents harness chooses among supplied bounded tools for static source inspection and read-only Liara investigation. Its backend is virtual in-memory state, not the host filesystem. There is no shell, install or local build execution.
5. The worker—not free-form model output—constructs an exact deploy or restart proposal from inspected source and scoped credentials. A deploy binds the existing app, platform, port, immutable commit, deterministic bundle digest and credential version.
6. Review the target, source and disruption/cost warning. Clicking explicit approval sends only the displayed proposal hash. Owner authorization and proposal freshness are rechecked server-side. Approval atomically records a frozen proposal and queues a separate `agent_action` run.
7. The execution worker re-fetches the immutable source, rehashes the actual bundle bytes and checks preconditions before a write-ahead dispatch claim. It uploads source and requests a release, records the release ID, observes provider release state and probes only the fixed Liara app root URL with redirects disabled.
8. A successful result means the exact release reported `READY` and the app root returned 2xx. This is not an application-specific functional test or proof that every dependency works. A restart acknowledgment plus healthy HTTP is not proof of a completed container restart.

## Deliberate limits

- Existing Liara app only. No app creation, plan selection, database provisioning, resizing, DNS changes or automatic paid resource selection in this assistant slice.
- Public GitHub only; no GitHub App/private-repo authorization or upload UI in this path yet.
- Static candidate-file inspection is bounded and excludes known credential/control paths; it is not a guarantee that arbitrary source files contain no secrets. Source and logs remain untrusted data, not agent instructions.
- Deployment bundles fail closed on omitted oversized files. Current retained-file limits are 1 MiB per file and 16 MiB total, with strict archive/path constraints. These limits intentionally exclude some otherwise valid projects.
- At most one dispatch attempt per approval; uncertain writes are not automatically resent. This is **not exactly-once provider execution**. A timeout or crash after dispatch requires observation/manual resolution, not blind retry.
- The queued run, proposal, approval, execution and events are persisted. The Deep Agents conversation state is not a PostgreSQL-resumable graph in this slice. Interrupted analysis must not silently restart billable reasoning.
- No continuous monitoring, incident scheduler, autonomous corrective deployment, runner, source editing, pull requests or automatic rollback is established by this slice.
- No arbitrary health URL or redirect following. Root-only verification can be inconclusive for private apps, disabled default domains or apps requiring a different health path.

## Credentials and model selection

Workspace BoxAPI credentials take precedence. A broken/revoked customer credential must never fall back to an operator key. The optional operator key is allowed only for the explicitly configured `DEMO_OWNER_GITHUB_ID` after stored workspace identity validation. `BOX_MODEL` selects an explicit model; there is no automatic model fallback. The ordinary run limit is four model calls and bounded inputs/outputs.

Framework tracing is disabled. Routine tests use deterministic external transports and isolated PostgreSQL, not live keys. An actual model request may be billable; real Liara mutation needs explicit approval for the exact disposable app and any cost.

## Acceptance evidence

Final batch evidence (23 October 2026):

- Post-review root `pnpm typecheck` and `pnpm build` passed, including the production Next.js build and compiled persistent worker.
- A limited local production browser check showed the connections page's unauthenticated owner-login warning. This was not an authenticated journey: local Auth.js sign-in reported an untrusted host without the deployment's trusted-host configuration. No OAuth acceptance is claimed.
- A clean source copy initially without `.env`, dependencies or build output completed `pnpm install --frozen-lockfile --ignore-scripts`, build and typecheck. Refreshed with the final review fixes, frozen installation, build, typecheck and offline tests passed again: **560 passed, 76 skipped**. Initial installation warned about migration-bin links before compilation; a post-build frozen install and executable/import checks resolved them.
- The joined guarded PostgreSQL acceptance tests passed **2/2**: actual Deep Agents tool selection → immutable source → canonical proposal → owner approval → approved deployment → release `READY` and root HTTP 200; uncertain upload did not trigger retry/release creation. External transports were intercepted deterministic fixtures, **not live providers**.
- Latest full guarded DB/web/worker suite (23 October 2026): **246 passed, 0 failed** after the review fixes. The guarded runner now runs files serially because they share a PostgreSQL database, global outbox and pg-boss queue. Parallel execution left the crash-test target queued while its job was created; the crash suite passed alone and the complete suite passed with serial file isolation. Production leases and crash-test timeout assertions were not weakened.
- Post-review root build, typecheck and offline suite passed: **560 passed, 76 skipped**. Offline skips explicitly cover DB/live/storage-gated checks; the guarded suite exercises the database checks separately.
- Independent product-batch recheck: **no remaining material blocker found**. All four initial P1 findings were fixed and regression-tested: bare-key credential serialization; consistent eligible connection states; healthy duplicate execution fencing; streaming response limits with honest uncertain mutation outcomes. Nested release/HTTP evidence now survives the validated UI projection. The verifier independently ran **120 tests (2 DB-dependent skips)** plus bounded stream/DTO probes, the database guard test, syntax and diff checks; full guarded/build/clean-copy results above are primary-agent evidence, not independently rerun by the verifier. Live acceptance remains outside this verdict.

The successful opt-in public `octocat/Hello-World` read does not establish a live deployment. No live model request or Liara mutation has been performed. Continuous monitoring and verified fault recovery remain unproven.

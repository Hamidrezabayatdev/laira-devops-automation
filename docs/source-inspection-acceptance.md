# Static source inspection boundary — scoped review complete

This is the next bounded batch after the independently accepted fixture-only foundation (`b6988aa`). It is not completion of source import or Phase 1.

## Scope and architecture

1. Close project/workspace binding at repository and database constraint boundaries before any project-targeted run route is enabled.
2. Add `@laira/source`: bounded in-memory ZIP and tar.gz inspection using maintained archive libraries, exact archive digest, safe candidate path policy, and deterministic static analysis.
3. Preserve the no-execution boundary: no installs, builds, tests, hooks, executable configuration imports, filesystem extraction, source network access or model requests.

## Acceptance criteria

- Reject traversal/absolute/drive/backslash/control paths, duplicate or colliding paths, links and special entries. Count excluded entries and expanded bytes against limits.
- Enforce compressed/expanded/entry/per-file/retained limits, including malformed inputs and decompression bombs; safe parser cleanup and static errors, never underlying content/error echoes.
- Exclude recognized sensitive/generated paths and nested archives. Arbitrary file contents can still contain credentials: inventory is not a deployment-ready or secret-free bundle.
- Emit only bounded manifest/dependency-name/environment-name/port metadata with `static_inference` provenance and explicit unknowns. Never claim actual builds/tests/deployments.
- Same-workspace project runs succeed; foreign project IDs fail before durable writes; a composite database constraint rejects direct cross-workspace inserts.
- Run package and integrated checks, then one fresh independent verifier for the coherent batch. Record findings/fixes/recheck honestly before commit.

## Deferred integration

Authenticated upload and project UI, immutable source/artifact persistence, S3/DB partial-failure recovery, retention, durable import jobs, GitHub repository authorization/immutable commit resolution, model context filtering and deployment-bundle construction are separate integration work. No Liara resources or paid infrastructure are authorized by this batch.

## Final scoped review

The independent verifier found a blocking Composer dependency-name regex backtracking issue. It was replaced with linear character scanning. Independent recheck passed all 115 scoped source tests; the exact hostile manifest completed in under 1 ms, and 37,449 short-name comparisons showed no acceptance differences. Earlier independent guarded DB/worker checks passed 32/32. The worker isolation fix separately passed three combined 126/126 runs without changing production claim timing.

**Scoped prerequisite verdict: accepted after fixes.** This is not acceptance of incoming GitHub acquisition, deployment bundles, Deep Agents, operational adapters or assistant integration; those form the next product batch and require their own integrated checks/review. No live deployment is established by this evidence. Historical progress below records the sequence, not current blockers.

## Evidence

- Work is in progress; no acceptance or commit for this batch yet. DB lane reported 23 isolated tests passing; primary requested a static project-not-found error and explicit ORM/migration deletion-semantics handling. Analyzer lane reported 11 focused tests passing; primary requested normalized collision checks, exact dependency/port parsing and `valid: null` for recognized-but-unparsed manifests. Archive lane returned 55 focused cases (108 full-package tests), build/typecheck passing, with strict USTAR framing rejecting hidden PAX/GNU metadata. Primary requested additional digest snapshot, strict filename encoding/TAR end markers, ZIP directory integrity and parser cleanup regressions. Worker implemented those and reported 115 package tests passing (62 archive, 36 policy, 16 analyzer, 1 pipeline), plus package build/typecheck. Primary integrated root build/typecheck/unit run passed: 380 unit tests passed, 45 explicitly skipped in 46 files; whitespace checks passed. All 115 source tests are included. Final isolated regression still awaits the worker offline-startup investigation. Offline-child regression investigation remains active in a separate worker lane.
- Primary combined DB/web/worker regression passed 123 tests in 19 files after DB/worker builds. Subsequent source review found test evidence gaps (nonexistent ID used instead of actual foreign project; copied SQL instead of actual migration file). Worker corrected those gaps: 11/11 scoped binding tests passed, including actual foreign IDs and full migration-file execution against clean/corrupt disposable schemas. Final primary rerun passed DB build/typecheck and all binding cases but failed the offline-child startup case (124/125 total, SIGKILL recovery passed). The worker lane traced the failure to DB test global-batch claims committing unrelated rows. An initial workaround added short stale-claim config and broad cleanup and reported three green runs; primary rejected that masking approach and required transaction rollback at the contaminating test, unchanged production stale timeout, suite-owned cleanup and no raw child-log dump. That correction and final rerun remain pending; no acceptance until independently rechecked.
- Primary rerun passed all 52 policy/analyzer tests (36 path-policy, 16 static-analysis cases), plus whitespace checks. This is scoped evidence, not integrated acceptance. Non-JSON manifests remain recognized-but-unvalidated (`valid: null`); outputs explicitly warn about inference, truncation and absence of a secret audit.
- Production dependency audit after archive-parser installation: no known vulnerabilities reported. This is an advisory-database result, not proof of archive safety.

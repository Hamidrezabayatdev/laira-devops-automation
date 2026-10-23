# Live product journey — 2026-10-23 (live execution resumed)

## Resumed owner session

Owner restored GitHub authentication; authenticated `/user` again returned numeric ID `152868728`. Imported the four explicit runtime-readiness keys into encrypted runtime connection `conn_3c10c544613242dab92f7e08bbed1e35`, version 1 (values not printed). Account plan/bundle availability and estimate rechecked at `2026-10-23T07:14:28.703Z`: `standard-base-g2` + `basic`, combined 3,194.44 tomans/hour. Existing workspace Liara connection is an older test connection; import correctly refused to overwrite it. Adding explicit named new-connection and task-selection support before queuing the live task. No paid mutation dispatched at this point.

Named live Liara connection imported as `conn_d83bafa7ceda41a3951d985d8cc92260`, leaving the prior test connection unchanged. First real durable agent task `run_4fbc93b418604601aab583d35dfa6546` failed before tool execution. Live diagnosis isolated model HTTP 400 to raw Zod v4 schemas for DeepAgents built-in tools; a direct JSON-schema tool request succeeded (133 tokens). A focused schema-normalization fix is in progress. No provider error bodies or credentials were printed.

## Authority and scope

The owner explicitly authorized unattended implementation, real model requests, and necessary paid Liara test resources. Operations must still use the product's immutable proposal, owner approval, and persistent execution path. No unrelated app/service is in scope. No direct/manual deployment substitutes for agent execution.

Target public repository: `Hamidrezabayatdev/liara-copilot`.
Selected immutable commit: `a8f8c34bee665c9f8de7358216ef06f22c9f8d62` (verified using GitHub API).
The GitHub CLI identity's numeric ID matched the configured demo owner in the initial authenticated check; no browser-session impersonation is used. A later live CLI attempt failed: `gh auth token` could not retrieve a token, `gh api user` returned 401, and the OS Secret Service reported the login collection locked. No inline token or process GitHub token was available. This is a new authenticated-entry blocker; prior identity evidence must not substitute for a current authenticated CLI session.

## Evidence before new implementation

- Existing batch: `2546cf1`; prior offline and guarded integration acceptance is recorded separately. It is not live-provider evidence.
- Configured Gemini implementation agent responded successfully after the owner enabled Windscribe. This does not establish product BoxAPI connectivity.
- Existing Liara operational adapter contains app creation, but the product agent/durable approved-action journey supports only existing-app deployments and restarts.
- The real product source adapter successfully fetched the immutable target after 175 seconds on the current network: 1,283 candidate files, 1,242,265-byte deterministic deployment bundle, digest `sha256:f01a87a685878d92072fe77447385f8d3e5f9c6cf79dd9a69151cdf96a6d5c7c`. The original 30-second deadline was insufficient; the worker journey needs a longer bounded source deadline. This read-only adapter probe is not an agent/model run.
- Installed official Liara CLI source identifies `/v1/me` as the account plan catalog; a read-only authenticated query succeeded. Only plan identifiers and capacity/pricing fields were exposed to the operator, never the account response body.

## Dedicated test resource plan

One dedicated Next application, no database, extra disk, or custom domain. Proposed slug: `laira-copilot-e2e-1023` (availability must be checked by product before mutation).

Account catalog plan `standard-base-g2`: Iran region, 2 GB RAM, 1 CPU, 20 GB included disk. Base price: 2,048.61 tomans/hour = 20,486.1 IRR/hour. The official CLI also selects a feature bundle; account catalog bundle `basic` is available at 1,145.83 tomans/hour (displayed as 825,000 tomans/month); `free` is unavailable for this resource plan. Freeze `bundlePlanId: basic`, not an unspecified paid default. Combined hourly estimate: 3,194.44 tomans = 31,944.4 IRR; 720-hour arithmetic estimate: 2,299,996.8 tomans = 22,999,968 IRR. These are estimates, not invoices or guaranteed monthly charges. Selected for Next.js build/runtime headroom. Public website prices differ; the actual account catalog takes precedence. Actual spend and taxes are not verified by these catalog probes. The exact resource plan, feature bundle, and total estimated cost must be frozen in the product proposal before primary-operator approval under the owner's authorization.

## Latest integrated automated evidence

- `pnpm test`: 691 passed, 88 skipped.
- `pnpm test:integration`: 777 passed, 2 skipped, including the joined fixture journey using the current global release-detail route and the runtime-reference CLI status test.
- `pnpm build` and `pnpm typecheck`: passed.
- Local web root and `/api/health/live`: HTTP 200. Browser displays a signed-out guest workspace; no authenticated browser acceptance is claimed.
- Initial independent review required changes: create-app verification combined matching resource/bundle fields across separate incomplete readbacks; one catalog fixture omitted connection-by-ID lookup. Both were repaired with regression coverage. Provider `TIMEDOUT` normalization was also corrected. Runtime-configuration references now bind the deploy proposal/hash and are checked before upload and again before release creation. The latest full checks above include these repairs; independent reviewer recheck found no material blocker and independently passed 224 scoped tests (21 skipped), relevant typechecks, and whitespace checks. This is fixture/source acceptance only, not live deployment or billing acceptance. A final CLI fixture failure was a false-positive substring assertion against a safe opaque ID; that fixture ID was renamed before this successful rerun.
- A real product `BoxApiClient.chat` connectivity probe succeeded using the explicitly configured `openai/gpt-5.4-mini`: 17 prompt + 6 completion = 23 total tokens; provider-reported cost `0.0000457125`, catalog estimate USD `0.00004571`. Only success/model/usage metadata was printed. This is live model-adapter evidence, not an authenticated durable agent journey.
- No paid app creation, source upload, release creation, or recovery mutation has been dispatched in this session.

## Acceptance distinctions

1. Agent tool execution with real model and source/provider responses.
2. App creation acknowledgment vs read-back verified provisioning.
3. Release accepted vs release READY and application HTTP response.
4. Root page health vs target-specific `/api/health` and chat functionality.
5. Read-only monitoring/diagnosis vs independently approved recovery mutation.

Do not report a later stage as complete using evidence from an earlier one. Target reconnaissance identified `LIARA_AI_BASE_URL`, `LIARA_AI_KEY`, `TOKEN_COOKIE_SECRET`, and `TOOL_APPROVAL_SECRET` as runtime readiness prerequisites, with optional semantic-index checks. Their presence in the local target dotenv was checked by names only; no values were printed or imported while authenticated entry was blocked. The target Git index tracks `data/docs-vectors.json`. Runtime secrets must be supplied through a product-mediated, version-bound encrypted mechanism before claiming application-specific readiness. No credential values belong in this document.

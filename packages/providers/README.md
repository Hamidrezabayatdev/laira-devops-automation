# @laira/providers

Safe provider adapters for **Liara Cloud** (read-only PaaS control plane) and **BoxAPI** (Qwen3.7 Flash & GPT-5.4 Mini completions and tool calling), implementing Phase 0 foundations from `IMPLEMENTATION-PLAN.md`.

## Key Principles & Architectural Invariants

1. **Fixed Origins & Redirect Safety**:
   - Liara API: Strictly restricted to `https://api.liara.ir`. Cross-origin credentialed redirects are blocked (`CredentialedRedirectBlockedError`).
   - BoxAPI: Strictly restricted to `https://ai.boxapi.ir/ai/v1`. Fetch passes `redirect: 'error'` (`BoxApiRedirectError`) to guarantee credentials are never forwarded.
2. **Immediate Secret Stripping & Safe DTOs**:
   - Raw responses containing environment variables (`envs`), passwords, tokens, or canary secrets are stripped immediately into allowlisted safe DTOs.
   - Env values are never retained in memory, logs, or safe DTOs; only safe key names (`envKeys`) are preserved.
   - Provider raw response bodies are never exposed in error objects or error messages.
3. **BoxAPI Model Policy & Deliberate Selection**:
   - Default model: `qwen/qwen3.7-flash` (or deliberately configured `openai/gpt-5.4-mini`).
   - **No runtime fallback**: If the model is unavailable or fails (400, 404, 500, etc.), automatic fallback to other models is strictly forbidden.
   - For `openai/gpt-5.4-mini`: passes `max_completion_tokens` (default 256), omits legacy `max_tokens`, and omits unsupported default temperature.
   - On 401/403 authentication denial, live AI is disabled with explicit access prerequisite instructions.
4. **Catalog Rates vs Provider Reported Cost**:
   - `openai/gpt-5.4-mini`: $0.8625 / 1M input, $5.175 / 1M output, $0.0863 / 1M cached input.
   - `qwen/qwen3.7-flash`: $0.0345 / 1M input, $0.1495 / 1M output, $0.0069 / 1M cached input.
   - Unknown models: `catalogEstimatedCostUsd` is `undefined` (never assumed or guessed).
   - Provider-reported cost and unit are stored separately; currency is never assumed.
5. **Full-Body Bounded Time, Bytes & Interrupted Stream Failure**:
   - Wall-clock timeouts span the full consumption of response bodies and SSE streams (not just the initial headers).
   - Byte count is bounded (`maxBytes`, default 1 MiB); exceeding it throws `ResponseSizeExceededError`.
   - Streams that end prematurely without `[DONE]` throw `InterruptedStreamError` (never silently succeed).
6. **Budget, Concurrency & AI Stop Switch (Process-Scoped Limitation)**:
   - Maximum 4 model dispatches per run (`RunBudgetController`); every dispatch including retries and 429 rate limit attempts counts.
   - Maximum 1 concurrent model dispatch per workspace (`WorkspaceConcurrencyController`).
   - Workspace-level AI stop switch (`AiStopController`).
   - **Limitation**: In-memory controllers enforce limits within the current Node.js process. In multi-instance deployments, an injected shared distributed controller (`IRunBudgetController`, `IWorkspaceConcurrencyController`) backed by PostgreSQL/Redis is required.
   - Owner identity gate: Operator demo key is restricted exclusively to the explicitly configured `demoOwnerId`; failed BYOK cannot fall back to operator demo key.
7. **Strict Tool Schemas & Zod Compatibility**:
   - Compatible with both self-contained typed schemas (`s.object`, `s.string`, etc.) and Zod schemas (`z.object({ ... })`).
   - Function/tool arguments are strictly validated; malformed JSON or schema mismatches throw `MalformedToolCallError`.
8. **Honest Capabilities & No Phase 0 Mutations**:
   - `apps.list`: Supported, documented and planning account-tested.
   - `apps.detail`: Supported, documented read-only with env values stripped.
   - `releases.list`: Unverified documented baseline (raw fixtures do not prove releases live in Phase 0).
   - Mutations (`deploy`, `restart`, `power`, `resize`): Blocked in Phase 0, throwing `MutationBlockedInReadOnlyAdapterError`.

---

## Smoke Test CLI

An explicit opt-in smoke test CLI executes a 2-request tool call and streaming final answer with bounded tokens.

### Security Note
**Never pass API keys via `--api-key` in `argv`**; command-line arguments are visible in system process listings (`ps aux`). The CLI strictly enforces this and reads keys from the environment.

### 1. Fixture Simulation Mode (Default & Safe)

```bash
pnpm --filter @laira/providers run smoke
# or
node --experimental-strip-types src/cli/smoke.ts
```

### 2. Live Execution (Explicit Opt-In Required)

```bash
export BOX_API_KEY="<YOUR_KEY>"
export BOX_MODEL="openai/gpt-5.4-mini"

pnpm --filter @laira/providers run smoke --live --confirm-live-call
```

---

## Automated Verification

```bash
# Run tests
pnpm --filter @laira/providers test

# Typecheck
pnpm --filter @laira/providers run typecheck
```

Test Suites (32 tests):
- `canary-secrets.test.ts`: Verifies canary secret stripping from raw app detail, Liara 401/500 errors, and BoxAPI 401 errors.
- `liara-adapter.test.ts`: Verifies project slug routing, internalId preservation, teamID scoping, redirect blocking, and honest capability reporting.
- `boxapi-adapter.test.ts`: Verifies model policy (Qwen default and GPT-5.4 Mini deliberate selection), no fallback on error, auth denial, BoxAPI redirect rejection, and catalog rate calculations.
- `boxapi-budget-gate.test.ts`: Verifies 429 budget exhaustion, 1 concurrent call limit, AI stop switch, and demo owner identity gating.
- `boxapi-tools-stream.test.ts`: Verifies strict tool validation, Zod schema compatibility, malformed JSON, interrupted stream failure, byte bounds, and malformed payload error handling.
- `smoke-cli.test.ts`: Verifies argv API key leak prevention, environment key requirement, and simulation execution.

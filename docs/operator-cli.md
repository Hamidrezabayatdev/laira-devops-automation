# Authenticated local operator CLI

The operator CLI is a headless entry point into the product's existing task and durable approval services. It is not a deployment bypass and does not impersonate an Auth.js browser session.

## Prerequisites

- Node 24, pnpm, built workspace packages, migrated isolated local application database.
- Authenticated `gh` CLI (or `GH_TOKEN` / `GITHUB_TOKEN` in the process environment).
- Explicit numeric `DEMO_OWNER_GITHUB_ID` matching the identity returned by GitHub's authenticated `/user` API.
- Existing application `.env` with database/encryption/provider configuration. Do not print it or pass credentials in CLI arguments.

Build before use:

```sh
pnpm build
```

Commands run from the repository root:

```sh
node --env-file=.env apps/worker/dist/cli/operator.js connect-liara
node --env-file=.env apps/worker/dist/cli/operator.js task \
  --repository https://github.com/OWNER/REPO/tree/EXACT_COMMIT \
  --task 'Inspect the immutable source and propose the requested operation.'
node --env-file=.env apps/worker/dist/cli/operator.js status --run RUN_ID
node --env-file=.env apps/worker/dist/cli/operator.js approve --run RUN_ID --hash EXACT_PROPOSAL_HASH
```

Run the persistent worker separately, with the same application configuration:

```sh
node --env-file=.env apps/worker/dist/index.js
```

The web process is separate. Queuing a task or approving a proposal does not itself run the worker or prove provider success. A successful approval returns a distinct execution run ID. Inspect that execution run until a terminal or explicitly uncertain state is reached. Do not resend an uncertain mutation.

Import only an explicit allowlist of runtime keys from a local dotenv file (no shell expansion or execution):

```sh
node --env-file=.env apps/worker/dist/cli/operator.js import-environment \
  --name dedicated-target-runtime --file /absolute/path/to/local.env \
  --keys LIARA_AI_BASE_URL,LIARA_AI_KEY,TOKEN_COOKIE_SECRET,TOOL_APPROVAL_SECRET
```

The output is an encrypted credential reference and key names, never values. Bind that exact reference explicitly when queuing the task:

```sh
node --env-file=.env apps/worker/dist/cli/operator.js task \
  --repository https://github.com/OWNER/REPO/tree/EXACT_COMMIT \
  --environment-connection RETURNED_CONNECTION_ID --environment-version 1 \
  --task 'Inspect and propose deployment to the dedicated application.'
```

The deploy proposal/hash binds this reference/version; the model cannot select or replace it. The executor resolves values only for the approved release request and checks status/version again after source upload. Do not put values in task text. This capability's fixture acceptance does not prove that the target's live runtime is ready.

`connect-liara` refuses to replace an existing workspace connection. To add a separate connection deliberately, supply `--name UNIQUE_NAME`; duplicate names are rejected under a transaction lock. Select it explicitly on a task with `--connection CONNECTION_ID`. Explicit blank selectors are rejected rather than falling back to discovery. The imported Liara token and optional team scope are stored together in an encrypted version-bound credential; they are never included in proposals or CLI output. Imported credentials remain `configured_unverified` until real provider reads establish usability. A missing/invalid team scope must not be silently replaced with a global worker team setting.

## Paid app creation catalog

The app-creation capability uses `LIARA_APPROVED_APP_PLANS_JSON`, a server-supplied JSON array, not model-invented pricing. Leave it empty to disable provisioning. Each entry contains `planId`, `bundlePlanId`, an explicit account-valid `networkId`, optional `platform`, and `cost: { currency: "IRR", hourly, monthly, sourceUrl, checkedAt }`. The operator must verify account-valid resource and feature-bundle IDs and their total costs first, freeze them into a proposal, review its exact hash, and only then approve it. The deployment catalog is restricted to the configured demo owner; it must not silently become another tenant's catalog. Catalog prices are estimates, not invoices; recurring charges may continue after testing unless the resource is explicitly stopped/deleted through an authorized path.

## Deterministic app monitoring

After verifying the application is deployed, register its default Liara endpoint:

```sh
node --env-file=.env apps/worker/dist/cli/operator.js monitor --action register \
  --connection CONNECTION_ID --app APP_SLUG --path /api/health --interval 60
node --env-file=.env apps/worker/dist/cli/operator.js monitor --action status --monitor MONITOR_ID
node --env-file=.env apps/worker/dist/cli/operator.js monitor --action check --monitor MONITOR_ID
node --env-file=.env apps/worker/dist/cli/operator.js monitor --action pause --monitor MONITOR_ID
node --env-file=.env apps/worker/dist/cli/operator.js monitor --action resume --monitor MONITOR_ID
```

Only `/` and `/api/health` on the validated app's fixed `https://APP_SLUG.liara.run` origin are supported. Redirects fail health checks. The persistent worker schedules checks without model calls; three consecutive failures open one persisted incident. Three consecutive HTTP successes plus confirmed current-release `READY` evidence resolve it. Missing provider evidence remains unconfirmed. Current limitation: the app-detail DTO does not yet preserve an explicit current-release identity, so production incident recovery stays unconfirmed rather than trusting release-history ordering. Pause persists across worker restarts; already-dispatched requests may finish, but their cleared lease prevents stale state updates. Recovery mutations still require a separate exact-hash approval.

## Evidence and limits

- CLI identity verification is independent of browser OAuth acceptance; it does not prove the UI sign-in flow works.
- Unit tests and injected provider fixtures do not prove live connectivity, provisioning, deployment, monitoring, or recovery.
- A root-page HTTP 2xx is not application-specific readiness. Check the target application's health and functionality separately.
- Never put runtime secret values in task text, command arguments, proposal JSON, logs, or documentation.

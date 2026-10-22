# Local setup (foundation milestone)

## Requirements

- Node.js 24, pnpm, Docker with Compose, Git.
- GitHub OAuth App for browser sign-in. `gh auth login` alone does not configure application authentication.
- Do not run against an unrelated local PostgreSQL service. This repository's isolated service uses localhost port 55433 (override `POSTGRES_PORT`; compose default is 55432); storage uses 59000 (API) and 59001 (console).

## Configuration

Copy `.env.example` to `.env` only if `.env` does not already exist. Preserve existing credentials. Keep its permissions restricted (`chmod 600 .env`). Never commit it.

Create the OAuth App under GitHub Settings → Developer settings → OAuth Apps:

| Field | Local value |
|---|---|
| Homepage URL | `http://localhost:3000` |
| Authorization callback / redirect URL | `http://localhost:3000/api/auth/callback/github` |

Store Client ID as `AUTH_GITHUB_ID` and Client Secret as `AUTH_GITHUB_SECRET`. Use the exact same hostname for browsing and `AUTH_URL`; don't mix localhost with 127.0.0.1. Generate a separate random `AUTH_SECRET` and encryption master key. OAuth App sign-in and GitHub App repository grants are separate integrations.

The local environment created during development uses generated PostgreSQL and storage credentials and a numeric `DEMO_OWNER_GITHUB_ID`. They are development-only, not production defaults. The verified OAuth numeric account identity—not a submitted username—must match before operator-funded AI can be used.

The restricted BoxAPI key denied Qwen. The user explicitly selected `openai/gpt-5.4-mini`; its synthetic tool/stream feasibility check passed. Use `BOX_MODEL=openai/gpt-5.4-mini` for that key and the provider-compatible `max_completion_tokens` cap. See `implementation-status.md`. A failed BYOK must never fall back to the operator key.

## Network troubleshooting

A proxy is available at localhost port 10808. If direct external downloads fail, test whether it accepts HTTP or SOCKS and set the proxy only for the affected command. Never route localhost DB/storage traffic through it. Never put proxy secrets in Git.

## Local Docker startup evidence

The first registry pull for the pinned MinIO tag was denied in this environment. `compose.local.yaml` is an explicit optional override using SHA-256 image digests already present in the local Docker cache (`pull_policy: never`). Start with:

```sh
docker compose -f compose.yaml -f compose.local.yaml up -d --wait
```

Port 55432 was occupied by an unrelated service. The ignored local `.env` sets `POSTGRES_PORT=55433` and matching database URLs instead; the existing listener was untouched. Both isolated containers reached healthy status. On a fresh machine, use the standard compose file with reachable approved image tags, or acquire those exact digest images first; the cache override intentionally cannot download missing images.

Stop this project's containers without deleting data:

```sh
docker compose -f compose.yaml -f compose.local.yaml stop
```

Do not use `down -v` unless you intend to delete this project's local development data.

## Safety and completion

The public fixture screen is read-only and labeled simulated. It is not a login bypass, a provider success report, or evidence that Phase 1 is implemented. Local fixture jobs test persistence only. Keep paid resource creation and all infrastructure mutation disabled until the approval broker and reconciliation acceptance checks are implemented.

Exact package startup/migration/test commands will be recorded in the root README after integration. Do not infer successful setup from a merely accepted request; check health, worker heartbeat, event history, and terminal job state.

# Foundation security boundaries

## Trust and authority

GitHub OAuth establishes an owner from the provider's verified numeric identity. GitHub CLI credentials are development tools, not application login. Repository authorization will use a separate GitHub App; signing in must not imply access to every repository.

Every stored object belongs to a workspace. HTTP handlers obtain that workspace from the authenticated owner session. IDs submitted by callers select objects only within that scope. Workers resolve ownership from stored domain records rather than trusting workspace claims in job payloads. Foreign workspace identifiers must behave as unavailable objects, without returning their content.

Model output, source archives, repository files, provider response bodies, public pages, and log content are data, not authority. A tool request is not permission to mutate infrastructure.

## Secrets

- Local `.env` is ignored by Git. Keep authentication, encryption, customer credentials, and storage secrets outside tracked files.
- Authenticated encryption binds customer secrets to workspace, connection, and credential version. Key replacement needs an explicit rotation/migration process; changing the master key alone makes old envelopes unreadable.
- Provider adapters must construct allowlisted safe DTOs before returning data to application code, persistence, logs, or a model. Environment values and database credentials are never model context.
- Safe errors contain a stable code, generic message, correlation ID, and retryability—not raw provider errors, request headers, or payloads.
- Demo operator credentials require an explicitly configured owner numeric GitHub ID verified by OAuth. Failed customer BYOK must not trigger operator-key fallback.

## Mutation boundary

The foundation batch has no infrastructure write tools. Later writes require a full immutable bounded plan, owner approval for its canonical hash/version, live precondition checks, exact resource and secret-version bindings, resource reservations, and a durable operation ledger.

Approval expires after 30 minutes for new dispatch. An in-flight timeout is an uncertain outcome, not permission to retry. Queue redelivery and graph checkpoint replay are never sufficient proof that a provider mutation is safe to repeat. Unresolved operations halt dependent writes and require reconciliation or explicit owner resolution. There is no automatic deletion compensation.

## Fixture boundary

Fixture UI and fixture worker tasks are clearly labeled. They may exercise persistence, replay, cancellation, and restart recovery but cannot claim real provider success. Fixture identity must not be accepted by production APIs or used to access live credentials.

## Deferred protections

Before adding public probes, implement restricted connection-time DNS/IP validation and network egress restrictions. Before archive imports, implement traversal/link/special-file/expansion checks and sensitive-file exclusion. Before code execution, require the dedicated gVisor runner; no host-shell fallback. These capabilities must stay disabled until their controls and acceptance evidence exist.

# Foundation operations and recovery

This runbook covers the foundation only. It does not authorize infrastructure writes.

## Restart and outage

- Web liveness proves the HTTP process is responsive; it does not prove database or worker readiness.
- Check database readiness and the worker's persisted heartbeat separately. A running web process with an absent/stale worker must be presented as degraded.
- Persist runs/events and outbox rows before dispatch. Restart the worker normally; do not delete queue/domain rows to make a stuck run appear healthy.
- A dispatch outbox row marked `failed` represents a durable retry wait, not a terminally abandoned run: dispatch failures retry with persisted attempt count and capped exponential delay (1s, 2s, 4s … max 60s). Inspect safe status/attempt counters during outage diagnosis; do not reset rows manually or infer provider success from queue acceptance. This retry policy applies only to the read-only fixture dispatch, not uncertain infrastructure mutations.
- Fixture job replay is safe only because the task is read-only and application handling is idempotent. Do not reuse this argument for deploy/create/restart operations.
- For a later dispatched infrastructure operation with uncertain outcome, preserve ledger intent and halt dependent writes. Reconcile observable provider state; never resend merely because its lease expired.

## Provider denial or outage

- HTTP 401/403 means credential/model permission remediation, not permission to change provider/model or use an operator key after failed BYOK.
- Keep live AI disabled after denial until a deliberate configured remediation. Show a safe permission message; never display raw provider error bodies.
- HTTP 429/transient failures count toward the same run budget if retried. Do not add SDK automatic retries on top of application allowances.
- Missing provider metrics are unknown, never zero. A failed health collection is not itself evidence of resource exhaustion.

## Credentials and ownership

- Sign-in is GitHub OAuth with database sessions. Identity changes require verified provider account mapping, not an editable username/email.
- Disconnecting an integration must block future credential resolution/dispatch. It cannot undo requests already sent.
- Encryption-key replacement is a migration, not an environment edit: retain the old key securely during controlled re-encryption, verify every envelope with workspace/connection/version AAD, then retire it. Without the old key, existing secrets cannot be recovered from ciphertext.
- Do not put credentials in incident evidence, run events, graph checkpoints, screenshots, chat, logs, audit, or fixtures. Use synthetic canaries in tests.

## Storage and retention

- Keep the artifact bucket private. Never enable anonymous access to troubleshoot authentication.
- References must bind workspace, artifact ID, digest, byte size and expiry; repository/authenticated scope checks precede storage access. Opaque IDs are not authorization.
- Expiry checks on reads are not physical deletion. Retention cleanup, object-version cleanup and deletion-record replay on restore are later deliverables; do not claim automated retention until tested.
- Do not retain secrets or raw provider bodies in recovery reports. Backups must be encrypted and rotated, adding at most seven days to planned live retention.

## Restore procedure (production prerequisite, not yet validated)

1. Restore only into a quarantined environment with external worker dispatch disabled.
2. Apply migrations and replay deletion records/expiry cleanup before exposing restored rows or artifacts.
3. Validate tenant constraints and ownership mappings, envelope decryption and object checksums without printing secrets.
4. Reconcile pending/uncertain operations before enabling writes; do not redeliver ambiguous mutations.
5. Verify database readiness, worker heartbeat, event replay and a read-only smoke run.
6. Re-enable only capabilities actually validated. Record limitations and the recovery evidence.

The repository's local Docker volumes are development persistence, not a production backup strategy. Stopping containers preserves them; deleting volumes destroys them.

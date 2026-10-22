# @laira/storage

Tenant-scoped, private S3-compatible artifact storage adapter for the Liara Agentic DevOps & SRE platform.

## Architecture & Security Contracts

- **Derived Workspace Identity**: Storage operations (`put`, `get`, `delete`, `head`, `exists`) strictly bind to the authenticated caller's workspace identity.
- **Opaque Artifact Keys Only**: Callers cannot supply arbitrary storage paths or filenames (preventing path traversal and overwriting other objects). Artifact IDs are cryptographically generated or strictly validated as opaque alphanumeric strings.
- **Underlying S3 Key Structure**: `workspaces/{workspaceId}/artifacts/{artifactId}`.
- **Strict Isolation & Rejection**:
  - Rejects cross-workspace access attempts (`CrossWorkspaceAccessError`).
  - Rejects path traversal (`../`, `/`, `\`, null bytes, `%2f`, `%00`) with `PathInjectionError`.
- **Integrity with SHA-256 Checksums**:
  - Automatically computes SHA-256 hash on `put` and returns standard `sha256:<hex>` digest in manifest.
  - Verifies `expectedDigest` if supplied on `put`.
  - Verifies retrieved data against recorded digest on `get` and throws `ChecksumMismatchError` if corrupted.
- **Bounded Byte Lengths**:
  - Streaming and Buffer uploads/downloads enforce maximum byte limits (`maxArtifactSizeBytes`, default 50MB, bounded max 100MB).
  - Stream connections are destroyed/aborted immediately if size exceeds bounds, preventing unbounded memory exhaustion.
- **Default Private Behavior**:
  - Objects are stored strictly private (`ACL: 'private'`).
  - Public ACLs (`public-read`, etc.) are forbidden.
  - Presigned public URLs are unsupported in Phase 0 (`UnsupportedStorageOperationError`).
  - No filesystem persistence: all operations are handled in-memory and via streams directly to S3.
- **Safe Errors**:
  - Sanitizes all underlying S3/network exceptions to prevent leaking AWS credentials, bearer tokens, canary secrets, or raw XML/JSON error response payloads.
- **Configuration Security**:
  - Production requires HTTPS.
  - Localhost HTTP (`http://127.0.0.1:...` or `http://localhost:...`) is permitted **only** when `localDevelopment: true` is explicitly passed.
  - Credentials are non-enumerable (`Object.keys()`, `for..in`, and `JSON.stringify` redact credentials to `[REDACTED]`).

## Data Contract

Artifact manifests conform strictly to:

```ts
interface ArtifactManifest {
  workspaceId: string;
  artifactId: string;
  digest: string; // sha256:<64-hex>
  size: number;   // bytes
  mimeType: string;
  createdAt: string; // ISO 8601 UTC
  expiry: string | null; // ISO 8601 UTC or null
  metadata?: Record<string, string>;
}
```

## Running Tests

### 1. Mock S3 Unit Tests
Runs unit tests covering cross-workspace isolation, path injection, checksum verification, bounded streams, canary error scrubbing, expiry checks, and default private behavior:

```bash
pnpm exec vitest run -c packages/storage/vitest.config.ts
```

### 2. Typecheck & Build
```bash
pnpm --filter @laira/storage run typecheck
pnpm --filter @laira/storage run build
```

### 3. Opt-in MinIO Integration Smoke
Requires local MinIO container running (from `compose.yaml`):

```bash
# Terminal 1: start MinIO
docker compose up -d minio

# Terminal 2: run opt-in smoke CLI
node packages/storage/dist/cli/minio-smoke.js --confirm-live-call

# Or run integration test:
RUN_MINIO_INTEGRATION=true pnpm exec vitest run -c packages/storage/vitest.config.ts tests/minio-integration.test.ts
```

## Root Lockfile & Dependency Pinning
Exact dependencies pinned in `package.json`:
- `@aws-sdk/client-s3`: `3.1155.0`
- `zod`: `3.24.2`

Per coordination protocol, subagents do not edit root lockfiles. Run `pnpm install` in workspace root when concurrent lane locks are released.

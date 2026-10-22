# @laira/security

Security foundation package providing authenticated encryption, contextual AAD binding, opaque secret-ref models, safe provider DTO helpers, and standardized safe error shapes.

## Exported APIs

### 1. AES-256-GCM Credential Envelope (`cipher.ts`)
- `AadContext`: Interface `{ workspaceId: string; connectionId: string; version: number | string }`
- `CredentialEnvelope`: Authenticated encryption container with IV, auth tag, ciphertext, and AAD metadata
- `formatAadContext(context: AadContext): Buffer`: Deterministic canonical formatting of AAD
- `normalizeKey(key: Buffer | string): Buffer`: Normalizes 32-byte (256-bit) master key. Supports:
  - **base64url** string (32-byte decoded, e.g. `crypto.randomBytes(32).toString('base64url')` as in `ENCRYPTION_MASTER_KEY`)
  - standard **base64** string (32-byte decoded)
  - **hex** string (64 characters)
  - direct `Buffer` of length 32
- `encryptCredential(plaintext, key, context, keyVersion?): CredentialEnvelope`
- `decryptCredential(envelope, key, expectedContext): Buffer`: Decrypts credential; throws `CredentialDecryptionError` if tag, ciphertext, or AAD mismatches

### 2. Secret-Ref Only Models (`secret-ref.ts`)
- `SecretRefSchema`: Strict Zod schema for opaque secret references; strictly forbids sensitive fields (`value`, `plaintext`, `token`, `password`, etc.)
- `SecretRef`: Type definition
- `createSecretRef(params)`: Factory function creating validated SecretRef
- `assertNoCanaryOrSecret(target, canaries)`: Utility for verifying no secrets exist in a payload

### 3. Safe Provider DTO Helpers (`safe-dto.ts`)
Strict allowlist-based sanitization helpers that drop unapproved fields:
- `toSafeLiaraAppDto(raw)`: Extracts only safe metadata (`project_id`, `type`, `status`, `scale`, etc.), dropping environment values and secrets
- `toSafeLiaraReleaseDto(raw)`: Extracts safe release metadata
- `toSafeLiaraDatabaseDto(raw)`: Extracts safe database metadata, dropping host credentials and passwords
- `toSafeEnvVarMetadataDto(rawEnvs)`: Produces key-only list `{ key: string; isSet: boolean }`, never including values
- `toSafeBoxApiUsageDto(raw)`: Extracts model and token usage
- `allowlistFields(raw, allowedKeys)`: Generic allowlist utility

### 4. Safe Standardized Errors (`error.ts`)
- `AppError`: Base application error class with `code`, `statusCode`, `correlationId`, and `retryable`.
  - Trusted safe construction: `AppError` instances represent deliberate domain/application-level errors.
  - Field error names and messages are sanitized against known canaries and credential regexes.
  - Raw error causes or stack traces are never exposed in safe wire DTOs.
- `STATIC_INTERNAL_ERROR_MESSAGE`: Static safe message (`'An internal error occurred. Please reference correlationId for support.'`).
- `SafeErrorDtoSchema`, `SafeErrorDto`: Standardized wire format for API and worker errors.
- `sanitizeErrorMessage(message, canaries)`: Scrubs tokens, auth headers, and canaries.
- `toSafeErrorDto(error, fallbackCorrelationId?, canaries?)`:
  - For `AppError`: Maps to standardized code and sanitized message.
  - For generic / unknown `Error` (e.g. `TypeError`, database connection errors): Fails closed with `STATIC_INTERNAL_ERROR_MESSAGE` and code `INTERNAL_ERROR`. Never echoes raw `error.message` because unknown exceptions frequently embed connection strings, query dumps, or unregistered opaque canary secrets.

import { describe, it, expect } from 'vitest';
import {
  AppError,
  toSafeErrorDto,
  sanitizeErrorMessage,
  SafeErrorDtoSchema,
} from '../src/error.js';
import { assertNoCanaryOrSecret } from '../src/secret-ref.js';

describe('Safe Standardized Error Shape', () => {
  const CANARY_SECRET = 'canary_master_token_999';

  it('formats AppError into standardized safe error DTO', () => {
    const error = new AppError({
      code: 'PRECONDITION_FAILED',
      message: 'Resource was not in expected status',
      correlationId: 'corr_test_123',
      fieldErrors: [{ field: 'status', message: 'expected running, got stopped' }],
    });

    const dto = toSafeErrorDto(error);
    expect(dto.code).toBe('PRECONDITION_FAILED');
    expect(dto.statusCode).toBe(412);
    expect(dto.correlationId).toBe('corr_test_123');
    expect(dto.retryable).toBe(false);
    expect(dto.fieldErrors).toHaveLength(1);
    expect(SafeErrorDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('guarantees canary secrets and bearer tokens are absent from sanitized messages and DTOs', () => {
    const messageWithCanary = `Failed to connect with token: ${CANARY_SECRET} and header Bearer secret_bearer_token_xyz`;

    const sanitized = sanitizeErrorMessage(messageWithCanary, [CANARY_SECRET]);
    expect(sanitized).not.toContain(CANARY_SECRET);
    expect(sanitized).not.toContain('secret_bearer_token_xyz');
    expect(sanitized).toContain('[REDACTED_SECRET]');
    expect(sanitized).toContain('[REDACTED_CREDENTIAL]');

    const rawError = new Error(
      `Provider rejected request with apiKey="${CANARY_SECRET}"`
    );

    const safeDto = toSafeErrorDto(rawError, 'corr_canary', [CANARY_SECRET]);
    expect(safeDto.code).toBe('INTERNAL_ERROR');
    expect(safeDto.statusCode).toBe(500);

    assertNoCanaryOrSecret(safeDto, [CANARY_SECRET]);
    expect(JSON.stringify(safeDto)).not.toContain(CANARY_SECRET);
  });

  it('strictly hides UNREGISTERED canary tokens in generic Error by returning static message', () => {
    const UNREGISTERED_CANARY = 'unregistered_opaque_canary_value_that_regex_cannot_know_about';
    const genericError = new Error(`Connection failed at postgres://user:${UNREGISTERED_CANARY}@db.internal:5432`);

    // Notice we do NOT pass UNREGISTERED_CANARY in canaries array!
    const safeDto = toSafeErrorDto(genericError);

    expect(safeDto.code).toBe('INTERNAL_ERROR');
    expect(safeDto.message).toBe('An internal error occurred. Please reference correlationId for support.');
    expect(JSON.stringify(safeDto)).not.toContain(UNREGISTERED_CANARY);
    expect(JSON.stringify(safeDto)).not.toContain('postgres://');
  });

  it('scrubs field error messages in AppError', () => {
    const error = new AppError({
      code: 'BAD_REQUEST',
      message: 'Invalid configuration input',
      fieldErrors: [
        { field: 'apiToken', message: `Token ${CANARY_SECRET} is expired` },
      ],
    });

    const dto = toSafeErrorDto(error, undefined, [CANARY_SECRET]);
    expect(dto.fieldErrors?.[0]?.message).not.toContain(CANARY_SECRET);
    expect(dto.fieldErrors?.[0]?.message).toContain('[REDACTED_SECRET]');
  });
});

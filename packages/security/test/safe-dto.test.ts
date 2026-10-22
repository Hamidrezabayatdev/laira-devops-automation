import { describe, it, expect } from 'vitest';
import {
  toSafeLiaraAppDto,
  toSafeLiaraReleaseDto,
  toSafeLiaraDatabaseDto,
  toSafeEnvVarMetadataDto,
  toSafeBoxApiUsageDto,
} from '../src/safe-dto.js';
import { assertNoCanaryOrSecret } from '../src/secret-ref.js';

describe('Safe Provider DTO Helpers (Allowlist not Redact)', () => {
  const CANARY_APP_SECRET = 'canary_liara_app_secret_value_111';
  const CANARY_DB_PASS = 'canary_postgres_password_222';
  const CANARY_ENV_VAL = 'canary_env_variable_val_333';

  it('guarantees canary secrets are completely absent from Safe Liara App DTO', () => {
    const rawLiaraAppResponse = {
      project_id: 'my-web-app',
      type: 'node',
      status: 'running',
      scale: 2,
      created_at: '2026-10-22T10:00:00Z',
      node_version: '24',
      port: 3000,
      platform: 'node',
      bundle_plan: 'standard',
      zone: 'iran',
      is_deploying: false,
      hourly_price: 120,
      // Sensitive fields that Liara API might return:
      envs: [
        { key: 'LIARA_TOKEN', value: CANARY_APP_SECRET },
        { key: 'SESSION_SECRET', value: 'another_secret_value' },
      ],
      api_token: CANARY_APP_SECRET,
      internal_credentials: {
        password: CANARY_APP_SECRET,
      },
      unvetted_extra_field: 'some_arbitrary_string',
    };

    const safeDto = toSafeLiaraAppDto(rawLiaraAppResponse);

    // Verify safe fields exist
    expect(safeDto.project_id).toBe('my-web-app');
    expect(safeDto.status).toBe('running');
    expect(safeDto.scale).toBe(2);

    // Verify canary secret is NOT present anywhere in safe DTO
    assertNoCanaryOrSecret(safeDto, [CANARY_APP_SECRET, 'SESSION_SECRET']);
    expect(JSON.stringify(safeDto)).not.toContain(CANARY_APP_SECRET);
    expect('envs' in safeDto).toBe(false);
    expect('api_token' in safeDto).toBe(false);
    expect('internal_credentials' in safeDto).toBe(false);
  });

  it('guarantees canary passwords and host strings are absent from Safe Liara DB DTO', () => {
    const rawLiaraDbResponse = {
      id: 'db-12345',
      name: 'production-postgres',
      type: 'postgres',
      status: 'running',
      plan: 'small',
      version: '16.0',
      scale: 1,
      created_at: '2026-10-22T08:00:00Z',
      hourly_price: 250,
      // Sensitive credentials:
      password: CANARY_DB_PASS,
      connection_string: `postgres://root:${CANARY_DB_PASS}@iran-postgres.liara.ir:34521/mydb`,
      host: 'iran-postgres.liara.ir',
      port: 34521,
      username: 'root',
    };

    const safeDbDto = toSafeLiaraDatabaseDto(rawLiaraDbResponse);

    expect(safeDbDto.name).toBe('production-postgres');
    expect(safeDbDto.status).toBe('running');

    assertNoCanaryOrSecret(safeDbDto, [CANARY_DB_PASS, 'iran-postgres.liara.ir']);
    expect(JSON.stringify(safeDbDto)).not.toContain(CANARY_DB_PASS);
    expect('password' in safeDbDto).toBe(false);
    expect('connection_string' in safeDbDto).toBe(false);
  });

  it('extracts only keys from environment variables and completely excludes canary values', () => {
    const rawEnvs = [
      { key: 'BOX_API_KEY', value: CANARY_ENV_VAL },
      { key: 'EMPTY_VAR', value: '' },
      { key: 'PORT', value: '3000' },
    ];

    const safeMeta = toSafeEnvVarMetadataDto(rawEnvs);

    expect(safeMeta).toEqual([
      { key: 'BOX_API_KEY', isSet: true },
      { key: 'EMPTY_VAR', isSet: false },
      { key: 'PORT', isSet: true },
    ]);

    assertNoCanaryOrSecret(safeMeta, [CANARY_ENV_VAL]);
    expect(JSON.stringify(safeMeta)).not.toContain(CANARY_ENV_VAL);
  });

  it('extracts safe release metadata', () => {
    const rawRelease = {
      id: 'rel_001',
      project_id: 'app_abc',
      state: 'ready',
      created_at: '2026-10-22T09:00:00Z',
      type: 'app',
      source_type: 'git',
      internal_build_logs_secret_url: 'https://secret.url/canary',
    };

    const safeRelease = toSafeLiaraReleaseDto(rawRelease);
    expect(safeRelease.id).toBe('rel_001');
    expect(safeRelease.state).toBe('ready');
    expect(JSON.stringify(safeRelease)).not.toContain('secret.url');
  });

  it('extracts safe BoxAPI usage tokens', () => {
    const rawUsage = {
      model: 'qwen/qwen3.7-flash',
      prompt_tokens: 1500,
      completion_tokens: 300,
      total_tokens: 1800,
      cached_tokens: 500,
      raw_api_key_used: 'canary_boxapi_key',
    };

    const safeUsage = toSafeBoxApiUsageDto(rawUsage);
    expect(safeUsage.total_tokens).toBe(1800);
    expect(safeUsage.cached_tokens).toBe(500);
    expect(JSON.stringify(safeUsage)).not.toContain('canary_boxapi_key');
  });
});

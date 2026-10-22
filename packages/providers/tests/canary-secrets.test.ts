import { describe, it } from 'vitest';
import assert from 'node:assert';
import { LiaraClient } from '../src/liara/client.ts';
import { toSafeLiaraAppDetail } from '../src/liara/dtos.ts';
import {
  CANARY_SECRETS,
  RAW_LIARA_PROJECT_DETAIL_RESPONSE,
  RAW_LIARA_401_BODY,
  RAW_LIARA_500_BODY,
} from '../src/fixtures/liara-fixtures.ts';
import { BoxApiClient } from '../src/boxapi/client.ts';
import {
  BOXAPI_CANARY_SECRETS,
  BOXAPI_RAW_401_BODY,
} from '../src/fixtures/boxapi-fixtures.ts';

const ARBITRARY_CANARIES = {
  providerCode: 'CANARY_ARBITRARY_PROVIDER_ERROR_CODE_9999',
  providerMessage: 'CANARY_ARBITRARY_PROVIDER_SECRET_MESSAGE_8888',
  headerCorrelationId: 'CANARY_HEADER_INJECTED_CORRELATION_ID_7777',
  headerRequestId: 'CANARY_HEADER_INJECTED_REQUEST_ID_6666',
  networkSecret: 'CANARY_NETWORK_SOCKET_LEAK_SECRET_5555',
};

describe('Canary Secrets Protection', () => {
  it('strips all canary secrets and env values from Liara raw app detail immediately', () => {
    const safeDetail = toSafeLiaraAppDetail(RAW_LIARA_PROJECT_DETAIL_RESPONSE.project);

    // 1. Verify safe fields exist
    assert.strictEqual(safeDetail.internalId, 'liara-app-internal-id-001');
    assert.strictEqual(safeDetail.projectId, 'my-frontend-app');
    assert.strictEqual(safeDetail.hasEnvs, true);
    assert.deepStrictEqual(safeDetail.envKeys, ['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV']);

    // 2. Verify canary secrets do NOT exist anywhere in the serialized safe DTO
    const serialized = JSON.stringify(safeDetail);

    assert.strictEqual(serialized.includes(CANARY_SECRETS.apiToken), false);
    assert.strictEqual(serialized.includes(CANARY_SECRETS.dbPassword), false);
    assert.strictEqual(serialized.includes(CANARY_SECRETS.jwtSecret), false);
    assert.strictEqual(serialized.includes(CANARY_SECRETS.envValue), false);
    assert.strictEqual(serialized.includes('provider_master_key'), false);
    assert.strictEqual(serialized.includes('raw_credentials'), false);
  });

  it('ensures Liara 401 error does not leak canary bearer tokens or raw error bodies', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(RAW_LIARA_401_BODY, {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.getProjectDetail('my-app');
      },
      (err: any) => {
        const errorString = `${err.name} ${err.message} ${JSON.stringify(err)}`;
        assert.strictEqual(errorString.includes(CANARY_SECRETS.apiToken), false);
        assert.strictEqual(errorString.includes('provided_secret'), false);
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );
  });

  it('ensures Liara 500 error does not leak stack traces or canary database passwords', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(RAW_LIARA_500_BODY, {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.listProjects();
      },
      (err: any) => {
        const errorString = `${err.name} ${err.message} ${JSON.stringify(err)}`;
        assert.strictEqual(errorString.includes(CANARY_SECRETS.dbPassword), false);
        assert.strictEqual(errorString.includes('ConnectionError'), false);
        assert.strictEqual(err.statusCode, 500);
        return true;
      }
    );
  });

  it('ensures arbitrary provider code, message, and headers never leak into LiaraApiError', async () => {
    const maliciousBody = JSON.stringify({
      code: ARBITRARY_CANARIES.providerCode,
      message: ARBITRARY_CANARIES.providerMessage,
      data: { secret: 'top-secret' },
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(maliciousBody, {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': ARBITRARY_CANARIES.headerCorrelationId,
          'x-request-id': ARBITRARY_CANARIES.headerRequestId,
        },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.listProjects();
      },
      (err: any) => {
        const serialized = JSON.stringify({
          name: err.name,
          message: err.message,
          code: err.code,
          correlationId: err.correlationId,
        });

        // Ensure zero reflection of arbitrary provider strings or headers
        assert.strictEqual(serialized.includes(ARBITRARY_CANARIES.providerCode), false);
        assert.strictEqual(serialized.includes(ARBITRARY_CANARIES.providerMessage), false);
        assert.strictEqual(serialized.includes(ARBITRARY_CANARIES.headerCorrelationId), false);
        assert.strictEqual(serialized.includes(ARBITRARY_CANARIES.headerRequestId), false);

        // Verify generated correlation ID is a valid safe UUID
        assert.match(
          err.correlationId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
        return true;
      }
    );
  });

  it('ensures network failure never reflects err.message containing canary secrets', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new TypeError(`connect ECONNREFUSED with token ${ARBITRARY_CANARIES.networkSecret}`);
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.listProjects();
      },
      (err: any) => {
        const serialized = JSON.stringify({
          name: err.name,
          message: err.message,
          code: err.code,
          correlationId: err.correlationId,
        });

        assert.strictEqual(serialized.includes(ARBITRARY_CANARIES.networkSecret), false);
        assert.strictEqual(serialized.includes('ECONNREFUSED'), false);
        assert.strictEqual(err.safeMessage, 'Liara API network error: unable to complete request');
        return true;
      }
    );
  });

  it('ensures BoxAPI 401 error does not leak canary keys or internal server dump', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(BOXAPI_RAW_401_BODY, {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'user-box-api-key',
      keyMode: 'byok',
      workspaceId: 'ws-test',
      ownerId: 'owner-test',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-canary-test',
          messages: [{ role: 'user', content: 'hello' }],
        });
      },
      (err: any) => {
        const errorString = `${err.name} ${err.message} ${JSON.stringify(err)}`;
        assert.strictEqual(errorString.includes(BOXAPI_CANARY_SECRETS.boxApiKey), false);
        assert.strictEqual(errorString.includes(BOXAPI_CANARY_SECRETS.serverInternalDump), false);
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );
  });
});

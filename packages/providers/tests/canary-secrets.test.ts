import { describe, it } from 'vitest';
import assert from 'node:assert';
import { LiaraClient } from '../src/liara/client.ts';
import { toSafeLiaraAppDetail } from '../src/liara/dtos.ts';
import { LiaraOperationalAdapter } from '../src/liara/operational.ts';
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

  it('ensures LiaraOperationalAdapter.getBoundedLogs never reads or leaks raw error bodies with canary secrets', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(RAW_LIARA_500_BODY, {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('my-app');
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

  it('ensures LiaraOperationalAdapter.getReleaseDetail never reflects canary secrets in failReason', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          release: {
            _id: 'release-canary-test',
            project_id: 'my-app',
            state: 'FAILED',
            failReason: `Internal error leaking ${CANARY_SECRETS.apiToken} and ${CANARY_SECRETS.dbPassword}`,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    const detail = await adapter.getReleaseDetail('my-app', 'release-canary-test');
    assert(detail !== null);
    assert.strictEqual(detail.state, 'FAILED');
    assert.strictEqual(detail.failReason, 'RELEASE_FAILED');
    const serialized = JSON.stringify(detail);
    assert.strictEqual(serialized.includes(CANARY_SECRETS.apiToken), false);
    assert.strictEqual(serialized.includes(CANARY_SECRETS.dbPassword), false);
  });

  it('retains actual planID string in toSafeLiaraAppDetail while dropping all canary secrets', () => {
    const rawWithPlanID = {
      _id: 'app-id-plan-test',
      project_id: 'my-app',
      planID: 'standard-2x',
      bundlePlanID: 'standard',
      status: 'running',
      secret_token: CANARY_SECRETS.apiToken,
      envs: [
        { key: 'DB_PASS', value: CANARY_SECRETS.dbPassword },
      ],
    };

    const safe = toSafeLiaraAppDetail(rawWithPlanID);
    assert.strictEqual(safe.plan, 'standard-2x');
    assert.strictEqual(safe.planID, 'standard-2x');
    assert.strictEqual(safe.planId, 'standard-2x');
    assert.strictEqual(safe.bundlePlanID, 'standard');
    assert.strictEqual(safe.bundlePlanId, 'standard');
    assert.deepStrictEqual(safe.envKeys, ['DB_PASS']);
    const serialized = JSON.stringify(safe);
    assert.strictEqual(serialized.includes(CANARY_SECRETS.apiToken), false);
    assert.strictEqual(serialized.includes(CANARY_SECRETS.dbPassword), false);

    // Verify bundlePlanID is NOT used as fallback for resource plan
    const rawBundleOnly = {
      _id: 'app-id-bundle-only',
      project_id: 'bundle-app',
      bundlePlanID: 'basic',
    };
    const safeBundleOnly = toSafeLiaraAppDetail(rawBundleOnly);
    assert.strictEqual(safeBundleOnly.plan, 'unknown');
    assert.strictEqual(safeBundleOnly.planID, undefined);
    assert.strictEqual(safeBundleOnly.planId, undefined);
    assert.strictEqual(safeBundleOnly.bundlePlanID, 'basic');
    assert.strictEqual(safeBundleOnly.bundlePlanId, 'basic');
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

  it('ensures createRelease runtimeEnvs sends canary secrets ONLY to fixed Liara origin and never leaks in errors or proposals', async () => {
    let capturedUrl = '';
    let capturedBody: any;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ releaseID: 'rel-canary-001' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: CANARY_SECRETS.apiToken,
      fetchFn: mockFetch,
    });

    // 1. Sent ONLY to fixed origin https://api.liara.ir
    const authority = { approved: true, token: 'auth-tok' };
    const outcome = await adapter.createRelease(
      {
        appSlug: 'canary-app',
        sourceId: 'src-canary-1',
        runtimeEnvs: [
          { key: 'DB_PASSWORD', value: CANARY_SECRETS.dbPassword },
          { key: 'API_SECRET', value: CANARY_SECRETS.apiToken },
        ],
      },
      authority
    );

    assert.strictEqual(outcome.status, 'accepted');
    const parsedOrigin = new URL(capturedUrl).origin;
    assert.strictEqual(parsedOrigin, 'https://api.liara.ir');
    assert.strictEqual(capturedBody.envs.DB_PASSWORD, CANARY_SECRETS.dbPassword);
    assert.strictEqual(capturedBody.envs.API_SECRET, CANARY_SECRETS.apiToken);

    // 2. Proposing with canary in runtimeEnvs throws static error without leaking secret
    assert.throws(
      () => {
        adapter.proposeCreateRelease({
          appSlug: 'canary-app',
          sourceId: 'src-canary-1',
          runtimeEnvs: [{ key: 'SECRET_PASS', value: CANARY_SECRETS.dbPassword }],
        });
      },
      (err: Error) => {
        assert.strictEqual(err.message, 'runtime environments require credential references at broker');
        assert(!err.message.includes(CANARY_SECRETS.dbPassword));
        return true;
      }
    );

    // 3. Provider 500 error does NOT echo raw secret body
    const mockFetch500: typeof fetch = async () => {
      return new Response(RAW_LIARA_500_BODY, {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const adapter500 = new LiaraOperationalAdapter({
      apiKey: 'k',
      fetchFn: mockFetch500,
    });

    const errorOutcome = await adapter500.createRelease(
      {
        appSlug: 'canary-app',
        sourceId: 'src-canary-1',
        runtimeEnvs: [{ key: 'SECRET_VAL', value: CANARY_SECRETS.dbPassword }],
      },
      authority
    );

    assert.strictEqual(errorOutcome.status, 'unknown');
    if (errorOutcome.status === 'unknown') {
      assert(!errorOutcome.safeMessage.includes(CANARY_SECRETS.dbPassword));
      assert(!errorOutcome.safeMessage.includes('ConnectionError'));
    }
  });
});

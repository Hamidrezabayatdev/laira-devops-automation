import { describe, it } from 'vitest';
import assert from 'node:assert';
import {
  LiaraOperationalAdapter,
  redactLogSecrets,
  SOURCE_ID_REGEX,
  STRICT_ID_REGEX,
  type LiaraOperationAuthority,
} from '../src/liara/operational.ts';
import { CANARY_SECRETS, RAW_LIARA_RELEASES_RESPONSE } from '../src/fixtures/liara-fixtures.ts';

describe('Liara Operational & Observation Adapter', () => {
  const validAuthority: LiaraOperationAuthority = {
    approved: true,
    token: 'approved-broker-token-12345',
    approvedBy: 'primary-orchestrator',
    reason: 'Verified action plan execution',
  };

  it('blocks mutations when caller authority is missing or unapproved', async () => {
    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
    });

    await assert.rejects(
      async () => {
        await adapter.createApp(
          { appSlug: 'test-app', platform: 'nodejs', planId: 'plan-custom' },
          { approved: false, token: '' }
        );
      },
      /explicit caller authority with an approved token is required/
    );

    await assert.rejects(
      async () => {
        await adapter.uploadSource(
          { appSlug: 'test-app', sourceArchiveBytes: new Uint8Array([1, 2, 3]) },
          undefined as any
        );
      },
      /explicit caller authority with an approved token is required/
    );

    await assert.rejects(
      async () => {
        await adapter.createRelease(
          { appSlug: 'test-app', sourceId: 'src-123' },
          { approved: false, token: 'token' }
        );
      },
      /explicit caller authority with an approved token is required/
    );

    await assert.rejects(
      async () => {
        await adapter.restartApp(
          { appSlug: 'test-app' },
          { approved: true, token: '   ' }
        );
      },
      /explicit caller authority with an approved token is required/
    );
  });

  it('requires explicit planId for createApp and proposeCreateApp with no default assumption', async () => {
    const adapter = new LiaraOperationalAdapter({ apiKey: 'test-token' });

    assert.throws(
      () => {
        adapter.proposeCreateApp({
          appSlug: 'new-service',
          platform: 'nodejs',
          planId: '',
        });
      },
      /Explicit planId is required for app creation/
    );

    await assert.rejects(
      async () => {
        await adapter.createApp(
          { appSlug: 'new-service', platform: 'nodejs', planId: '   ' },
          validAuthority
        );
      },
      /Explicit planId is required for app creation/
    );

    const proposal = adapter.proposeCreateApp({
      appSlug: 'new-service',
      platform: 'nodejs',
      planId: 'plan-custom-tier',
    });
    assert.strictEqual(proposal.params.planId, 'plan-custom-tier');
    assert.strictEqual(proposal.params.bundlePlanId, undefined);
  });

  it('handles optional bundlePlanId in proposeCreateApp and createApp: validates, retains, forwards bundlePlanID', async () => {
    let capturedBody: any;
    let capturedUrl = '';

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ status: 'created' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // 1. Propose with bundlePlanId retains it in params and summary
    const proposalWithBundle = adapter.proposeCreateApp({
      appSlug: 'bundle-app',
      platform: 'nodejs',
      planId: 'standard-base-g2',
      bundlePlanId: 'basic',
    });
    assert.strictEqual(proposalWithBundle.params.bundlePlanId, 'basic');
    assert(proposalWithBundle.summary.includes('bundle: basic'));

    // 2. createApp sends bundlePlanID in POST body and returns it in data
    const outcome = await adapter.createApp(
      {
        appSlug: 'bundle-app',
        platform: 'nodejs',
        planId: 'standard-base-g2',
        bundlePlanId: 'basic',
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'accepted');
    if (outcome.status === 'accepted') {
      assert.strictEqual(outcome.data.appSlug, 'bundle-app');
      assert.strictEqual(outcome.data.planId, 'standard-base-g2');
      assert.strictEqual(outcome.data.bundlePlanId, 'basic');
    }
    assert.strictEqual(capturedBody.name, 'bundle-app');
    assert.strictEqual(capturedBody.planID, 'standard-base-g2');
    assert.strictEqual(capturedBody.bundlePlanID, 'basic');

    // 3. createApp without bundlePlanId does NOT send bundlePlanID in POST body
    await adapter.createApp(
      {
        appSlug: 'plain-app',
        platform: 'nodejs',
        planId: 'standard-base-g2',
      },
      validAuthority
    );
    assert.strictEqual(capturedBody.name, 'plain-app');
    assert.strictEqual(capturedBody.planID, 'standard-base-g2');
    assert.strictEqual('bundlePlanID' in capturedBody, false);

    // 4. Invalid bundlePlanId validation (empty, invalid chars, oversized)
    assert.throws(
      () => {
        adapter.proposeCreateApp({
          appSlug: 'bad-bundle',
          platform: 'nodejs',
          planId: 'standard-base-g2',
          bundlePlanId: '',
        });
      },
      /bundlePlanId must be a non-empty string when provided/
    );

    const maliciousBundle = 'invalid bundle ' + CANARY_SECRETS.apiToken;
    assert.throws(
      () => {
        adapter.proposeCreateApp({
          appSlug: 'bad-bundle',
          platform: 'nodejs',
          planId: 'standard-base-g2',
          bundlePlanId: maliciousBundle,
        });
      },
      (err: Error) => {
        assert.strictEqual(
          err.message,
          'Invalid bundlePlanId: must be 1-64 alphanumeric characters, hyphens, or underscores'
        );
        assert(!err.message.includes(CANARY_SECRETS.apiToken));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await adapter.createApp(
          {
            appSlug: 'bad-bundle',
            platform: 'nodejs',
            planId: 'standard-base-g2',
            bundlePlanId: 'x'.repeat(65),
          },
          validAuthority
        );
      },
      /Invalid bundlePlanId: must be 1-64 alphanumeric characters, hyphens, or underscores/
    );
  });

  it('delegates listApps() to LiaraClient.listProjects() returning SafeLiaraApp[]', async () => {
    let capturedUrl = '';
    const mockProjects = {
      projects: [
        {
          _id: 'proj-1',
          project_id: 'app-one',
          type: 'nodejs',
          status: 'running',
          planID: 'standard-base-g2',
          scale: 1,
          created_at: '2026-10-20T00:00:00Z',
        },
      ],
    };

    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify(mockProjects), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const apps = await adapter.listApps();
    assert.strictEqual(apps.length, 1);
    assert.strictEqual(apps[0].projectId, 'app-one');
    assert.strictEqual(apps[0].plan, 'standard-base-g2');
    assert(capturedUrl.includes('/v1/projects'));
  });

  it('validates appSlug with static safe error message that never echoes raw inputs', () => {
    const adapter = new LiaraOperationalAdapter({ apiKey: 'test-token' });
    const maliciousInput = 'invalid slug with spaces and canary ' + CANARY_SECRETS.apiToken;

    assert.throws(
      () => {
        adapter.proposeRestartApp({ appSlug: maliciousInput });
      },
      (err: Error) => {
        assert.strictEqual(
          err.message,
          'Invalid appSlug: must be 1-64 alphanumeric characters, hyphens, or underscores'
        );
        assert(!err.message.includes(CANARY_SECRETS.apiToken));
        assert(!err.message.includes('invalid slug'));
        return true;
      }
    );
  });

  it('uploads source code with multipart field "file", strict sourceID, and teamID query parameter', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedMethod = init?.method ?? 'GET';
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      capturedBody = init?.body;

      return new Response(JSON.stringify({ sourceID: 'source-uuid-789' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-api-token',
      teamId: 'team-finance-01',
      fetchFn: mockFetch,
    });

    const archiveData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip magic bytes
    const outcome = await adapter.uploadSource(
      {
        appSlug: 'my-web-app',
        sourceArchiveBytes: archiveData,
        filename: 'app.tar.gz',
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'accepted');
    if (outcome.status === 'accepted') {
      assert.strictEqual(outcome.data.sourceId, 'source-uuid-789');
    }

    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v2/projects/my-web-app/sources?teamID=team-finance-01');
    assert.strictEqual(capturedHeaders['authorization'], 'Bearer test-api-token');

    assert(capturedBody instanceof FormData);
    const formFile = capturedBody.get('file');
    assert(formFile !== null, 'FormData must contain "file" field');
  });

  it('rejects source upload archives exceeding 50 MiB ceiling immediately before dispatch', async () => {
    let fetchCalled = false;
    const mockFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // Create a mock large Uint8Array exceeding 50 MiB without full allocation
    const oversizedBytes = {
      byteLength: 50 * 1024 * 1024 + 1,
    } as unknown as Uint8Array;

    await assert.rejects(
      async () => {
        await adapter.uploadSource(
          {
            appSlug: 'my-web-app',
            sourceArchiveBytes: oversizedBytes,
          },
          validAuthority
        );
      },
      /exceeds maximum allowed limit of 52428800 bytes \(50 MiB\)/
    );

    assert.strictEqual(fetchCalled, false, 'Oversized archive must never dispatch HTTP request');
  });

  it('creates release using documented field names and strict releaseID check', async () => {
    let capturedUrl = '';
    let capturedBodyJson: any;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedBodyJson = JSON.parse(init?.body as string);

      return new Response(JSON.stringify({ releaseID: 'rel-999' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const outcome = await adapter.createRelease(
      {
        appSlug: 'my-web-app',
        sourceId: 'source-uuid-789',
        port: 8080,
        platform: 'nodejs',
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'accepted');
    if (outcome.status === 'accepted') {
      assert.strictEqual(outcome.data.releaseId, 'rel-999');
    }

    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v2/projects/my-web-app/releases');
    assert.strictEqual(capturedBodyJson.sourceID, 'source-uuid-789');
    assert.strictEqual(capturedBodyJson.port, 8080);
    assert.strictEqual(capturedBodyJson.type, 'nodejs');
    assert.strictEqual('envs' in capturedBodyJson, false);
  });

  it('maps runtimeEnvs to CLI shape Record<string, string> in createRelease POST body to v2 releases', async () => {
    let capturedUrl = '';
    let capturedBodyJson: any = null;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedBodyJson = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ releaseID: 'rel-env-test-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const outcome = await adapter.createRelease(
      {
        appSlug: 'my-web-app',
        sourceId: 'source-uuid-789',
        runtimeEnvs: [
          { key: 'PORT', value: '3000' },
          { key: 'APP_ENV', value: 'production' },
          { key: 'API_SECRET_TOKEN', value: 'secret-val-123' },
        ],
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'accepted');
    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v2/projects/my-web-app/releases');
    assert.deepStrictEqual(capturedBodyJson.envs, {
      PORT: '3000',
      APP_ENV: 'production',
      API_SECRET_TOKEN: 'secret-val-123',
    });
  });

  it('maps build.location and platformConfig.mirror in createRelease POST body to match CLI deploy.js', async () => {
    let capturedBodyJson: any = null;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedBodyJson = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ releaseID: 'rel-build-config-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // Test with build: { location: 'germany' } and platformConfig: { mirror: false }
    const outcome = await adapter.createRelease(
      {
        appSlug: 'my-web-app',
        sourceId: 'source-uuid-789',
        platform: 'next',
        port: 3000,
        build: { location: 'germany' },
        platformConfig: { mirror: false },
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'accepted');
    assert.deepStrictEqual(capturedBodyJson.build, { location: 'germany' });
    assert.deepStrictEqual(capturedBodyJson.platformConfig, { mirror: false });
    assert.strictEqual(capturedBodyJson.type, 'next');
    assert.strictEqual(capturedBodyJson.port, 3000);

    // Also test with buildLocation directly
    const outcome2 = await adapter.createRelease(
      {
        appSlug: 'my-web-app',
        sourceId: 'source-uuid-789',
        buildLocation: 'iran',
        platformConfig: { mirror: true },
      },
      validAuthority
    );
    assert.strictEqual(outcome2.status, 'accepted');
    assert.deepStrictEqual(capturedBodyJson.build, { location: 'iran' });
    assert.deepStrictEqual(capturedBodyJson.platformConfig, { mirror: true });
  });

  it('preserves undefined build and platformConfig when omitted in createRelease', async () => {
    let capturedBodyJson: any = null;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedBodyJson = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ releaseID: 'rel-default-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    await adapter.createRelease(
      {
        appSlug: 'my-web-app',
        sourceId: 'source-uuid-789',
      },
      validAuthority
    );

    assert.strictEqual('build' in capturedBodyJson, false);
    assert.strictEqual('platformConfig' in capturedBodyJson, false);
  });

  it('rejects invalid buildLocation and non-allowlisted platformConfig keys in createRelease', async () => {
    const adapter = new LiaraOperationalAdapter({ apiKey: 'test-token' });

    await assert.rejects(
      async () => {
        await adapter.createRelease(
          {
            appSlug: 'my-web-app',
            sourceId: 'source-uuid-789',
            buildLocation: 'invalid-zone' as any,
          },
          validAuthority
        );
      },
      { message: 'Invalid build location: must be iran or germany' }
    );

    await assert.rejects(
      async () => {
        await adapter.createRelease(
          {
            appSlug: 'my-web-app',
            sourceId: 'source-uuid-789',
            platformConfig: { mirror: false, maliciousCmd: 'touch /tmp/pwned' } as any,
          },
          validAuthority
        );
      },
      { message: 'Invalid platformConfig key: maliciousCmd' }
    );

    await assert.rejects(
      async () => {
        await adapter.createRelease(
          {
            appSlug: 'my-web-app',
            sourceId: 'source-uuid-789',
            platformConfig: { mirror: 'not-boolean' as any },
          },
          validAuthority
        );
      },
      { message: 'platformConfig.mirror must be a boolean' }
    );
  });

  it('retrieves bounded diagnostic build logs via getBuildLogs with strict redaction and allowlists', async () => {
    let capturedUrl = '';
    const secretApiKey = 'test-token-super-secret-xyz';
    const canaryToken = 'CANARY_SECRET_BUILD_123';
    const canaryDbUrl = 'postgres://canary_user:canary_pass@10.0.0.1:5432/proddb';
    const canaryPassword = 'password="untrusted_pwd_789"';

    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response(
        JSON.stringify({
          release: { state: 'FAILED' },
          buildOutput: [
            {
              stream: 'stdout',
              line: `Using Liara mirror to install with ${secretApiKey} and ${canaryToken}`,
              createdAt: '2026-10-23T10:00:00Z',
            },
            {
              stream: 'STDERR',
              line: `Build failed with ${canaryDbUrl} and ${canaryPassword}`,
              createdAt: '2026-10-23T10:00:01Z',
            },
            {
              stream: 'INSECURE_INTERNAL_SOCKET',
              line: 'Build completed cleanly',
              createdAt: 'invalid-non-iso-date-string',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: secretApiKey,
      fetchFn: mockFetch,
    });

    const logs = await adapter.getBuildLogs('rel-fail-1', { maxLines: 50 });
    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v2/releases/rel-fail-1/build-logs');
    assert.strictEqual(logs.state, 'FAILED');
    assert.strictEqual(logs.lines.length, 3);

    // 1. Secret literals must be strictly absent
    const allLinesCombined = logs.lines.map((l) => l.line).join('\n');
    assert.strictEqual(allLinesCombined.includes(secretApiKey), false, 'apiKey must not be present');
    assert.strictEqual(allLinesCombined.includes(canaryToken), false, 'canary token must not be present');
    assert.strictEqual(allLinesCombined.includes(canaryDbUrl), false, 'database url must not be present');
    assert.strictEqual(allLinesCombined.includes('untrusted_pwd_789'), false, 'password must not be present');

    assert.strictEqual(logs.lines[0].line.includes('[REDACTED_API_KEY]'), true);
    assert.strictEqual(logs.lines[0].line.includes('[REDACTED_SECRET]'), true);
    assert.strictEqual(logs.lines[1].line.includes('[REDACTED_DATABASE_URL]'), true);
    assert.strictEqual(logs.lines[1].line.includes('password=[REDACTED]'), true);

    // 2. Stream allowlist: STDOUT / STDERR / unknown
    assert.strictEqual(logs.lines[0].stream, 'STDOUT');
    assert.strictEqual(logs.lines[1].stream, 'STDERR');
    assert.strictEqual(logs.lines[2].stream, 'unknown');

    // 3. createdAt validation: ISO string or empty string
    assert.strictEqual(logs.lines[0].createdAt, '2026-10-23T10:00:00.000Z');
    assert.strictEqual(logs.lines[1].createdAt, '2026-10-23T10:00:01.000Z');
    assert.strictEqual(logs.lines[2].createdAt, '');

    assert.strictEqual(logs.truncated, false);
  });

  it('enforces releaseState allowlist and maxLines finite integer bounds in getBuildLogs', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          release: { state: 'ARBITRARY_INTERNAL_EXEC_DATA' },
          buildOutput: [
            { stream: 'STDOUT', line: 'line 1', createdAt: '2026-10-23T10:00:00Z' },
            { stream: 'STDOUT', line: 'line 2', createdAt: '2026-10-23T10:00:01Z' },
            { stream: 'STDOUT', line: 'line 3', createdAt: '2026-10-23T10:00:02Z' },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // Unknown state falls back to UNKNOWN
    const logsUnknownState = await adapter.getBuildLogs('rel-fail-1', { maxLines: 2 });
    assert.strictEqual(logsUnknownState.state, 'UNKNOWN');
    assert.strictEqual(logsUnknownState.lines.length, 2);
    assert.strictEqual(logsUnknownState.truncated, true);

    // Handles NaN/Infinity options gracefully by clamping or defaulting
    const logsNaN = await adapter.getBuildLogs('rel-fail-1', { maxLines: Number.NaN });
    assert.strictEqual(logsNaN.lines.length, 3);
    assert.strictEqual(logsNaN.truncated, false);

    const logsInfinity = await adapter.getBuildLogs('rel-fail-1', { maxLines: Number.POSITIVE_INFINITY });
    assert.strictEqual(logsInfinity.lines.length, 3);
    assert.strictEqual(logsInfinity.truncated, false);
  });

  it('refuses runtimeEnvs in proposeCreateRelease with static message and prevents leaks', () => {
    const adapter = new LiaraOperationalAdapter({ apiKey: 'test-token' });

    assert.throws(
      () => {
        adapter.proposeCreateRelease({
          appSlug: 'my-web-app',
          sourceId: 'source-uuid-789',
          runtimeEnvs: [{ key: 'DATABASE_URL', value: 'postgres://secret' }],
        });
      },
      (err: Error) => {
        assert.strictEqual(
          err.message,
          'runtime environments require credential references at broker'
        );
        return true;
      }
    );
  });

  it('enforces runtimeEnvs validation: <=40 keys, /^[A-Z][A-Z0-9_]{0,127}$/, <=32KiB, no reserved/duplicate keys with zero fetch dispatch', async () => {
    let fetchCount = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify({ releaseID: 'rel-0' }), { status: 200 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // 1. Rejects > 40 keys
    const fortyOneEnvs = Array.from({ length: 41 }, (_, i) => ({
      key: `ENV_KEY_${i}`,
      value: `val_${i}`,
    }));
    await assert.rejects(
      async () => {
        await adapter.createRelease(
          { appSlug: 'my-web-app', sourceId: 'src-1', runtimeEnvs: fortyOneEnvs },
          validAuthority
        );
      },
      /runtimeEnvs cannot exceed 40 variables/
    );

    // 2. Rejects invalid key formats (lowercase, starting with number, symbols)
    const invalidKeyCases = [
      'lowercase_key',
      '1_STARTS_WITH_NUMBER',
      'KEY-WITH-DASHES',
      'KEY WITH SPACES',
      '',
      'A'.repeat(129),
    ];
    for (const badKey of invalidKeyCases) {
      await assert.rejects(
        async () => {
          await adapter.createRelease(
            { appSlug: 'my-web-app', sourceId: 'src-1', runtimeEnvs: [{ key: badKey, value: 'val' }] },
            validAuthority
          );
        },
        (err: Error) => {
          assert.strictEqual(
            err.message,
            'Invalid environment variable key: must match ^[A-Z][A-Z0-9_]{0,127}$'
          );
          if (badKey.length > 0) {
            assert(!err.message.includes(badKey));
          }
          return true;
        }
      );
    }

    // 3. Rejects reserved keys
    const reservedKeys = ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH'];
    for (const reserved of reservedKeys) {
      await assert.rejects(
        async () => {
          await adapter.createRelease(
            { appSlug: 'my-web-app', sourceId: 'src-1', runtimeEnvs: [{ key: reserved, value: 'val' }] },
            validAuthority
          );
        },
        /Reserved environment variable key is not allowed/
      );
    }

    // 4. Rejects duplicate keys
    await assert.rejects(
      async () => {
        await adapter.createRelease(
          {
            appSlug: 'my-web-app',
            sourceId: 'src-1',
            runtimeEnvs: [
              { key: 'MY_KEY', value: 'first' },
              { key: 'MY_KEY', value: 'second' },
            ],
          },
          validAuthority
        );
      },
      /Duplicate environment variable key is not allowed/
    );

    // 5. Rejects total size > 32 KiB
    const largeValue = 'x'.repeat(33 * 1024);
    await assert.rejects(
      async () => {
        await adapter.createRelease(
          {
            appSlug: 'my-web-app',
            sourceId: 'src-1',
            runtimeEnvs: [{ key: 'LARGE_KEY', value: largeValue }],
          },
          validAuthority
        );
      },
      /runtimeEnvs total size exceeds 32 KiB limit/
    );

    // 6. Zero fetches dispatched for all invalid cases
    assert.strictEqual(fetchCount, 0, 'No HTTP fetch must occur when runtimeEnvs validation fails');
  });

  it('returns accepted and restartRequested on restartApp without assuming running container', async () => {
    let capturedUrl = '';
    let capturedMethod = '';

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedMethod = init?.method ?? 'GET';
      return new Response(JSON.stringify({ message: 'restarted' }), { status: 200 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const outcome = await adapter.restartApp({ appSlug: 'existing-app' }, validAuthority);
    assert.strictEqual(outcome.status, 'accepted');
    if (outcome.status === 'accepted') {
      assert.strictEqual(outcome.data.restartRequested, true);
    }
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v1/projects/existing-app/actions/restart');
  });

  it('maps server 5xx on dispatched mutations to typed "unknown" outcome without auto-resend', async () => {
    let callCount = 0;

    const mockFetch: typeof fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ message: 'Internal Gateway Error' }), { status: 502 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const outcome = await adapter.restartApp({ appSlug: 'existing-app' }, validAuthority);

    assert.strictEqual(callCount, 1, 'Write request must not be retried');
    assert.strictEqual(outcome.status, 'unknown');
    if (outcome.status === 'unknown') {
      assert.strictEqual(outcome.code, 'SERVER_5XX_UNCERTAIN');
      assert.match(outcome.safeMessage, /HTTP 502 after mutation dispatch/);
    }
  });

  it('maps malformed or invalid success schema after mutation dispatch to typed "unknown" outcome', async () => {
    const mockFetch: typeof fetch = async () => {
      // Returns 200 OK but with non-string/coerced object for releaseID
      return new Response(JSON.stringify({ releaseID: { evil: 'object' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const outcome = await adapter.createRelease(
      {
        appSlug: 'existing-app',
        sourceId: 'src-123',
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'unknown');
    if (outcome.status === 'unknown') {
      assert.strictEqual(outcome.code, 'MALFORMED_RESPONSE_UNCERTAIN');
    }
  });

  it('maps timeout after write dispatch to typed "unknown" outcome without auto-resend', async () => {
    let callCount = 0;

    const hangingFetch: typeof fetch = async (_input, init) => {
      callCount++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      timeoutMs: 30,
      fetchFn: hangingFetch,
    });

    const outcome = await adapter.createRelease(
      {
        appSlug: 'test-app',
        sourceId: 'src-123',
      },
      validAuthority
    );

    assert.strictEqual(callCount, 1, 'Write request must be dispatched exactly once; no auto-resend');
    assert.strictEqual(outcome.status, 'unknown');
    if (outcome.status === 'unknown') {
      assert.strictEqual(outcome.code, 'TIMEOUT_AFTER_DISPATCH');
      assert.match(outcome.safeMessage, /timed out after dispatch/);
      assert.doesNotMatch(outcome.safeMessage, new RegExp(CANARY_SECRETS.apiToken));
    }
  });

  it('maps definitive 4xx client errors to typed "rejected" outcome', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ message: 'App not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const outcome = await adapter.restartApp({ appSlug: 'missing-app' }, validAuthority);
    assert.strictEqual(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.strictEqual(outcome.code, 'HTTP_404');
    }
  });

  it('verifies actual release state via GET /v1/releases/{releaseId} with strict ID and project verification', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const urlStr = input.toString();
      if (urlStr === 'https://api.liara.ir/v1/releases/release-internal-id-101') {
        return new Response(
          JSON.stringify({
            release: {
              _id: 'release-internal-id-101',
              project_id: 'my-frontend-app',
              state: 'READY',
              tag: 'v1.2.0',
              port: 3000,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr === 'https://api.liara.ir/v1/releases/release-wrong-project') {
        return new Response(
          JSON.stringify({
            release: {
              _id: 'release-wrong-project',
              project_id: 'another-app',
              state: 'READY',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const detail = await adapter.getReleaseDetail('my-frontend-app', 'release-internal-id-101');
    assert(detail !== null);
    assert.strictEqual(detail.id, 'release-internal-id-101');
    assert.strictEqual(detail.projectId, 'my-frontend-app');
    assert.strictEqual(detail.state, 'READY');
    assert.strictEqual(detail.status, 'READY');
    assert.strictEqual(detail.tag, 'v1.2.0');
    assert.strictEqual(detail.port, 3000);

    // Mismatched project slug returns null
    const wrongProject = await adapter.getReleaseDetail('my-frontend-app', 'release-wrong-project');
    assert.strictEqual(wrongProject, null);

    // 404 returns null
    const notFound = await adapter.getReleaseDetail('my-frontend-app', 'release-non-existent');
    assert.strictEqual(notFound, null);
  });

  it('normalizes TIMEDOUT release state to allowlisted terminal status with DEPLOYMENT_TIMEOUT default failReason', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const urlStr = input.toString();
      if (urlStr.includes('release-timedout-lower')) {
        return new Response(
          JSON.stringify({
            release: {
              _id: 'release-timedout-lower',
              project_id: 'my-app',
              state: 'timedout',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('release-timedout-upper')) {
        return new Response(
          JSON.stringify({
            release: {
              _id: 'release-timedout-upper',
              project_id: 'my-app',
              state: 'TIMEDOUT',
              failReason: 'timeout exceeded while building image',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('release-unrecognized-state')) {
        return new Response(
          JSON.stringify({
            release: {
              _id: 'release-unrecognized-state',
              project_id: 'my-app',
              state: 'SOME_ARBITRARY_STATE',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // 1. Lowercase 'timedout' normalized to 'TIMEDOUT' with default failReason 'DEPLOYMENT_TIMEOUT'
    const lower = await adapter.getReleaseDetail('my-app', 'release-timedout-lower');
    assert(lower !== null);
    assert.strictEqual(lower.state, 'TIMEDOUT');
    assert.strictEqual(lower.status, 'TIMEDOUT');
    assert.strictEqual(lower.failReason, 'DEPLOYMENT_TIMEOUT');

    // 2. Uppercase 'TIMEDOUT' with sanitized failReason
    const upper = await adapter.getReleaseDetail('my-app', 'release-timedout-upper');
    assert(upper !== null);
    assert.strictEqual(upper.state, 'TIMEDOUT');
    assert.strictEqual(upper.status, 'TIMEDOUT');
    assert.strictEqual(upper.failReason, 'DEPLOYMENT_TIMEOUT');

    // 3. Unrecognized state normalized to safe 'UNKNOWN'
    const unrecognized = await adapter.getReleaseDetail('my-app', 'release-unrecognized-state');
    assert(unrecognized !== null);
    assert.strictEqual(unrecognized.state, 'UNKNOWN');
    assert.strictEqual(unrecognized.status, 'UNKNOWN');
  });

  it('strictly sanitizes failReason to safe static terminal codes and never leaks raw provider messages', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const urlStr = input.toString();
      if (urlStr.includes('release-disk-err')) {
        return new Response(
          JSON.stringify({
            release: {
              _id: 'release-disk-err',
              project_id: 'my-frontend-app',
              state: 'FAILED',
              failReason: `disk_not_found data_disk ${CANARY_SECRETS.dbPassword}`,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('release-raw-err')) {
        return new Response(
          JSON.stringify({
            release: {
              _id: 'release-raw-err',
              project_id: 'my-frontend-app',
              state: 'FAILED',
              failReason: `Internal error connecting to postgres with token ${CANARY_SECRETS.apiToken}`,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const diskErr = await adapter.getReleaseDetail('my-frontend-app', 'release-disk-err');
    assert(diskErr !== null);
    assert.strictEqual(diskErr.state, 'FAILED');
    assert.strictEqual(diskErr.failReason, 'DISK_NOT_FOUND');
    assert(!JSON.stringify(diskErr).includes(CANARY_SECRETS.dbPassword));

    const rawErr = await adapter.getReleaseDetail('my-frontend-app', 'release-raw-err');
    assert(rawErr !== null);
    assert.strictEqual(rawErr.state, 'FAILED');
    assert.strictEqual(rawErr.failReason, 'RELEASE_FAILED');
    assert(!JSON.stringify(rawErr).includes(CANARY_SECRETS.apiToken));
  });

  it('redacts literal client apiKey as well as generic canary secrets in logs', () => {
    const clientSecretKey = 'MY_SPECIAL_CLIENT_KEY_12345';
    const rawLog = `
2026-10-22T12:00:00Z Connection established to postgres://admin:${CANARY_SECRETS.dbPassword}@db.liara.ir:5432/production
2026-10-22T12:00:01Z Auth header received: Bearer ${CANARY_SECRETS.apiToken}
2026-10-22T12:00:02Z Config key jwt_secret=${CANARY_SECRETS.jwtSecret} loaded successfully.
2026-10-22T12:00:03Z Internal API token used was ${clientSecretKey}
`;

    const redacted = redactLogSecrets(rawLog, clientSecretKey);

    assert(!redacted.includes(clientSecretKey), 'Literal client apiKey leaked in log');
    assert(!redacted.includes(CANARY_SECRETS.dbPassword), 'Database password leaked in log');
    assert(!redacted.includes(CANARY_SECRETS.apiToken), 'API token leaked in log');
    assert(!redacted.includes(CANARY_SECRETS.jwtSecret), 'JWT secret leaked in log');
    assert(redacted.includes('[REDACTED_API_KEY]'));
    assert(redacted.includes('[REDACTED_DATABASE_URL]'));
    assert(redacted.includes('[REDACTED_TOKEN]'));
  });

  it('enforces line and byte budgets when retrieving bounded logs in CLI v2 format', async () => {
    const clientKey = 'CLIENT_KEY_EXPLICIT_REDACT';
    const mockV2Logs = {
      data: [
        {
          metaData: { releaseId: 'rel-001' },
          values: [
            ['1729600000000000000', JSON.stringify({ _entry: `Server listening with key ${clientKey} and token ${CANARY_SECRETS.apiToken}`, type: 'stdout' })],
            ['1729600001000000000', JSON.stringify({ _entry: 'Ready for traffic', type: 'stdout' })],
            ['1729600002000000000', JSON.stringify({ _entry: 'Warning: slow query', type: 'stderr' })],
          ],
        },
      ],
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(mockV2Logs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: clientKey,
      fetchFn: mockFetch,
    });

    const result = await adapter.getBoundedLogs('test-app', {
      maxLines: 2,
      maxBodyBytes: 10000,
    });

    assert.strictEqual(result.lines.length, 2);
    assert.strictEqual(result.truncated, true);
    assert(!result.lines[0].message.includes(clientKey));
    assert(!result.lines[0].message.includes(CANARY_SECRETS.apiToken));
    assert(result.lines[0].message.includes('[REDACTED_API_KEY]'));
    assert.strictEqual(result.lines[0].type, 'stdout');
    assert.strictEqual(result.lines[1].type, 'stdout');
  });

  it('enforces configuration boundaries on timeout and maxBytes to prevent disabling', () => {
    // Negative or non-finite timeout throws
    assert.throws(() => {
      new LiaraOperationalAdapter({ apiKey: 'k', timeoutMs: 0 });
    });
    assert.throws(() => {
      new LiaraOperationalAdapter({ apiKey: 'k', timeoutMs: Number.NaN });
    });

    // Timeout ceiling is capped at 120_000ms
    const adapterHigh = new LiaraOperationalAdapter({ apiKey: 'k', timeoutMs: 999_999 });
    assert.strictEqual(adapterHigh.timeoutMs, 120_000);

    // Max size ceiling is capped at 50 MiB
    const adapterBig = new LiaraOperationalAdapter({ apiKey: 'k', maxResponseSizeBytes: 100 * 1024 * 1024 });
    assert.strictEqual(adapterBig.maxSizeBytes, 50 * 1024 * 1024);
  });

  it('defaults start to unix timestamp from 15 min ago and validates since options for v2 logs', async () => {
    let capturedUrl = '';

    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // Case 1: Default since
    const beforeCall = Math.floor((Date.now() - 15 * 60 * 1000) / 1000);
    await adapter.getBoundedLogs('test-app');
    const afterCall = Math.floor((Date.now() - 15 * 60 * 1000) / 1000);

    const parsedUrl = new URL(capturedUrl);
    assert.strictEqual(parsedUrl.pathname, '/v2/projects/test-app/logs');
    assert.strictEqual(parsedUrl.searchParams.get('direction'), 'forward');
    assert.strictEqual(parsedUrl.searchParams.get('last_lines'), 'false');
    const startParam = parsedUrl.searchParams.get('start');
    assert(startParam !== null, 'start query param must be present');
    const startNum = Number.parseInt(startParam, 10);
    assert(!Number.isNaN(startNum), 'start must be a valid number');
    assert(startNum >= beforeCall - 2 && startNum <= afterCall + 2);

    // Case 2: Explicit valid since timestamp
    await adapter.getBoundedLogs('test-app', { since: 1729600000 });
    assert.strictEqual(new URL(capturedUrl).searchParams.get('start'), '1729600000');

    // Case 3: Rejects huge or invalid since input
    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('test-app', { since: 'a'.repeat(100) });
      },
      /Invalid since parameter/
    );
  });

  it('redacts metadata secrets: allowlists log type and sanitizes datetime to prevent secret leakage in v2 logs', async () => {
    const clientSecretKey = 'SUPER_SECRET_CLIENT_KEY_999';
    const mockV2Logs = {
      data: [
        {
          metaData: { releaseId: 'rel-1' },
          values: [
            [clientSecretKey, JSON.stringify({ _entry: 'log entry with untrusted metadata', type: `custom-${clientSecretKey}` })],
            ['1729600000000000000', JSON.stringify({ _entry: 'normal log entry', type: 'STDOUT' })],
          ],
        },
      ],
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(mockV2Logs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: clientSecretKey,
      fetchFn: mockFetch,
    });

    const result = await adapter.getBoundedLogs('test-app');
    assert.strictEqual(result.lines.length, 2);

    // Entry 0: Unallowlisted type maps to 'unknown', invalid datetime maps to 'unknown'
    assert.strictEqual(result.lines[0].type, 'unknown');
    assert.strictEqual(result.lines[0].datetime, 'unknown');
    assert(!JSON.stringify(result.lines[0]).includes(clientSecretKey));

    // Entry 1: Allowlisted type lowercase 'stdout', parsed datetime
    assert.strictEqual(result.lines[1].type, 'stdout');
    assert.match(result.lines[1].datetime, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects NaN or non-positive values for maxLines and maxBodyBytes', async () => {
    const adapter = new LiaraOperationalAdapter({ apiKey: 'test-token' });

    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('test-app', { maxLines: Number.NaN });
      },
      /maxLines must be a positive integer/
    );

    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('test-app', { maxLines: -5 });
      },
      /maxLines must be a positive integer/
    );

    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('test-app', { maxBodyBytes: Number.NaN });
      },
      /maxBodyBytes must be a positive finite number/
    );

    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('test-app', { maxBodyBytes: 0 });
      },
      /maxBodyBytes must be a positive finite number/
    );
  });

  it('honestly throws RESPONSE_SIZE_EXCEEDED when logs response payload exceeds maxBodyBytes budget', async () => {
    // Generate a response exceeding 8 KiB budget (e.g. 10 KiB)
    const largeMessage = 'x'.repeat(10 * 1024);
    const mockLogs = [{ type: 'stdout', datetime: '2026-10-22T10:00:00Z', message: largeMessage }];

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(mockLogs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('test-app', {
          maxBodyBytes: 8192, // 8 KiB budget
        });
      },
      (err: any) => {
        assert.strictEqual(err.code, 'RESPONSE_SIZE_EXCEEDED');
        assert.match(err.safeMessage, /response size exceeded 8192 bytes limit/);
        return true;
      }
    );
  });

  it('executes approved proposal via executeApproved router', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ message: 'restarted' }), { status: 200 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const proposal = adapter.proposeRestartApp({ appSlug: 'existing-app' });
    const outcome = await adapter.executeApproved<{ restartRequested: boolean }>(
      proposal,
      validAuthority
    );

    assert.strictEqual(outcome.status, 'accepted');
    if (outcome.status === 'accepted') {
      assert.strictEqual(outcome.data.restartRequested, true);
    }
  });

  it('bounds streaming reads: cancels reader immediately on oversized chunk without consuming entire stream', async () => {
    let consumedChunks = 0;
    let cancelCalled = false;
    const totalChunks = 10;
    const chunkSize = 1024;

    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (consumedChunks < totalChunks) {
            consumedChunks++;
            controller.enqueue(new Uint8Array(chunkSize).fill(0x61)); // 'a'
          } else {
            controller.close();
          }
        },
        cancel() {
          cancelCalled = true;
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 })
    );

    const mockFetch: typeof fetch = async () => {
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // Request logs with a maxBodyBytes limit of 1024 bytes (1 chunk)
    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('test-app', {
          maxBodyBytes: 1024,
        });
      },
      (err: any) => {
        assert.strictEqual(err.code, 'RESPONSE_SIZE_EXCEEDED');
        assert.match(err.safeMessage, /response size exceeded 1024 bytes limit/);
        return true;
      }
    );

    // Assert that reader was canceled immediately when limit was exceeded
    assert.strictEqual(cancelCalled, true, 'reader.cancel() must be called immediately');
    // Consumed chunks must be <= 2 (chunk 1 within limit, chunk 2 triggers oversize cancel; remaining 8 never pulled)
    assert(
      consumedChunks <= 2,
      `Expected consumed chunks <= 2, but consumed ${consumedChunks} out of ${totalChunks}`
    );
  });

  it('maps oversized 200 response on restartApp to typed "unknown" outcome with zero retries', async () => {
    let callCount = 0;

    const mockFetch: typeof fetch = async () => {
      callCount++;
      // Return 200 OK with oversized body > maxResponseSizeBytes
      const oversizedBody = 'b'.repeat(2048);
      return new Response(oversizedBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      maxResponseSizeBytes: 1024, // 1 KiB ceiling for testing
      fetchFn: mockFetch,
    });

    const outcome = await adapter.restartApp({ appSlug: 'test-app' }, validAuthority);

    assert.strictEqual(callCount, 1, 'Mutating write must not be retried');
    assert.strictEqual(outcome.status, 'unknown');
    if (outcome.status === 'unknown') {
      assert.strictEqual(outcome.code, 'RESPONSE_SIZE_EXCEEDED_UNCERTAIN');
      assert.match(outcome.safeMessage, /exceeded 1024 bytes limit after mutation dispatch/);
      assert(!outcome.safeMessage.includes('b'.repeat(100)), 'Raw response body must never leak in safe message');
    }
  });

  it('maps oversized 200 response on uploadSource to typed "unknown" outcome with zero retries', async () => {
    let callCount = 0;

    const mockFetch: typeof fetch = async () => {
      callCount++;
      const oversizedPayload = JSON.stringify({
        sourceID: 'src-123',
        padding: 'x'.repeat(4096),
      });
      return new Response(oversizedPayload, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      maxResponseSizeBytes: 2048,
      fetchFn: mockFetch,
    });

    const outcome = await adapter.uploadSource(
      {
        appSlug: 'test-app',
        sourceArchiveBytes: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
      },
      validAuthority
    );

    assert.strictEqual(callCount, 1, 'Upload write must not be retried');
    assert.strictEqual(outcome.status, 'unknown');
    if (outcome.status === 'unknown') {
      assert.strictEqual(outcome.code, 'RESPONSE_SIZE_EXCEEDED_UNCERTAIN');
      assert.match(outcome.safeMessage, /exceeded 2048 bytes limit after mutation dispatch/);
    }
  });

  it('lists networks via GET /v1/networks with safe allowlisted fields and teamId forwarding', async () => {
    let capturedUrl = '';
    const mockNetworksResponse = {
      networks: [
        {
          _id: '6ad9be2707e024287d1bc47a',
          name: 'devops-network',
          secret_key: CANARY_SECRETS.apiToken,
          routing_rules: [{ internal_ip: '10.0.0.1' }],
        },
        {
          _id: '507f1f77bcf86cd799439011',
          name: 'staging-network',
        },
      ],
    };

    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify(mockNetworksResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      teamId: 'team-ops-42',
      fetchFn: mockFetch,
    });

    const networks = await adapter.listNetworks();
    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v1/networks?teamID=team-ops-42');
    assert.strictEqual(networks.length, 2);
    assert.deepStrictEqual(networks[0], {
      id: '6ad9be2707e024287d1bc47a',
      name: 'devops-network',
    });
    assert.deepStrictEqual(networks[1], {
      id: '507f1f77bcf86cd799439011',
      name: 'staging-network',
    });

    const serialized = JSON.stringify(networks);
    assert(!serialized.includes(CANARY_SECRETS.apiToken));
    assert(!serialized.includes('secret_key'));
    assert(!serialized.includes('routing_rules'));
  });

  it('handles array wire format and sanitizes invalid IDs in listNetworks', async () => {
    const mockArray = [
      {
        _id: '6ad9be2707e024287d1bc47a',
        name: 'valid-net',
      },
      {
        _id: 'invalid-id-not-24-hex',
        name: 'bad-net',
      },
    ];

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(mockArray), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const networks = await adapter.listNetworks();
    assert.strictEqual(networks.length, 1);
    assert.strictEqual(networks[0].id, '6ad9be2707e024287d1bc47a');
    assert.strictEqual(networks[0].name, 'valid-net');
  });

  it('handles optional networkId in proposeCreateApp and createApp: validates 24-hex, forwards network in POST', async () => {
    let capturedBody: any;
    let capturedUrl = '';

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ status: 'created' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // 1. proposeCreateApp retains networkId and includes it in summary
    const proposal = adapter.proposeCreateApp({
      appSlug: 'network-app',
      platform: 'next',
      planId: 'standard-base-g2',
      bundlePlanId: 'basic',
      networkId: '6ad9be2707e024287d1bc47a',
    });

    assert.strictEqual(proposal.params.networkId, '6ad9be2707e024287d1bc47a');
    assert(proposal.summary.includes('network: 6ad9be2707e024287d1bc47a'));

    // 2. createApp sends network in POST body (matching CLI network._id)
    const outcome = await adapter.createApp(
      {
        appSlug: 'network-app',
        platform: 'next',
        planId: 'standard-base-g2',
        bundlePlanId: 'basic',
        networkId: '6ad9be2707e024287d1bc47a',
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'accepted');
    if (outcome.status === 'accepted') {
      assert.strictEqual(outcome.data.appSlug, 'network-app');
      assert.strictEqual(outcome.data.networkId, '6ad9be2707e024287d1bc47a');
    }
    assert.strictEqual(capturedBody.network, '6ad9be2707e024287d1bc47a');
    assert.strictEqual(capturedBody.name, 'network-app');
    assert.strictEqual(capturedBody.planID, 'standard-base-g2');
    assert.strictEqual(capturedBody.platform, 'next');
    assert.strictEqual(capturedBody.bundlePlanID, 'basic');

    // 3. When networkId is omitted: no network property sent (no default autoselect)
    await adapter.createApp(
      {
        appSlug: 'no-network-app',
        platform: 'next',
        planId: 'standard-base-g2',
      },
      validAuthority
    );
    assert.strictEqual('network' in capturedBody, false);
  });

  it('rejects invalid networkId before dispatch without leaking canary secrets', async () => {
    let fetchCount = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      return new Response('{}', { status: 200 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const maliciousId = 'not-24-hex-' + CANARY_SECRETS.apiToken;

    assert.throws(
      () => {
        adapter.proposeCreateApp({
          appSlug: 'test-app',
          platform: 'nodejs',
          planId: 'standard-base-g2',
          networkId: maliciousId,
        });
      },
      (err: Error) => {
        assert.strictEqual(
          err.message,
          'Invalid networkId: must be a 24-character hexadecimal string'
        );
        assert(!err.message.includes(CANARY_SECRETS.apiToken));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await adapter.createApp(
          {
            appSlug: 'test-app',
            platform: 'nodejs',
            planId: 'standard-base-g2',
            networkId: 'tooshort123',
          },
          validAuthority
        );
      },
      /Invalid networkId: must be a 24-character hexadecimal string/
    );

    assert.strictEqual(fetchCount, 0, 'No HTTP request must be dispatched for invalid networkId');
  });

  it('diagnoses HTTP 400 network required error safely without leaking raw message or canary credentials', async () => {
    const rawErrorBody = JSON.stringify({
      statusCode: 400,
      message: `network is required for project with secret ${CANARY_SECRETS.apiToken}`,
      errors: {
        network: [`network is required for token ${CANARY_SECRETS.jwtSecret}`],
      },
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(rawErrorBody, {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const outcome = await adapter.createApp(
      {
        appSlug: 'laira-copilot-e2e-1023',
        platform: 'next',
        planId: 'standard-base-g2',
        bundlePlanId: 'basic',
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.strictEqual(outcome.code, 'NETWORK_REQUIRED');
      assert.strictEqual(
        outcome.safeMessage,
        'Liara API error: HTTP 400 validation rejected fields: network'
      );

      // Verify zero canary secrets or raw messages in the outcome
      const serialized = JSON.stringify(outcome);
      assert(!serialized.includes(CANARY_SECRETS.apiToken));
      assert(!serialized.includes(CANARY_SECRETS.jwtSecret));
      assert(!serialized.includes('with secret'));
    }
  });

  it('allowlist-classifies known validation reasons: plan, bundle, name, region, account verification, balance', async () => {
    const testCases: Array<{
      status: number;
      body: Record<string, unknown>;
      expectedCode: string;
      expectedMessage: string;
    }> = [
      {
        status: 400,
        body: { message: 'bundlePlan is not available for free plan.' },
        expectedCode: 'BUNDLE_UNAVAILABLE',
        expectedMessage: 'Liara API error: HTTP 400 validation rejected fields: bundlePlanID',
      },
      {
        status: 400,
        body: { message: 'The selected plan is not available.' },
        expectedCode: 'PLAN_UNAVAILABLE',
        expectedMessage: 'Liara API error: HTTP 400 validation rejected fields: planID',
      },
      {
        status: 400,
        body: { message: 'Please enter a valid name for your app.' },
        expectedCode: 'APP_NAME_INVALID',
        expectedMessage: 'Liara API error: HTTP 400 validation rejected fields: name',
      },
      {
        status: 400,
        body: { message: 'region is required' },
        expectedCode: 'REGION_REQUIRED',
        expectedMessage: 'Liara API error: HTTP 400 validation rejected fields: region',
      },
      {
        status: 400,
        body: { message: 'Account identity verification required' },
        expectedCode: 'ACCOUNT_VERIFICATION_REQUIRED',
        expectedMessage: 'Liara API error: HTTP 400 (ACCOUNT_VERIFICATION_REQUIRED)',
      },
      {
        status: 402,
        body: { message: 'Not enough balance. Please charge your account.' },
        expectedCode: 'INSUFFICIENT_BALANCE',
        expectedMessage: 'Liara API error: HTTP 402 (INSUFFICIENT_BALANCE)',
      },
      {
        status: 400,
        body: { message: 'Unknown unspecified error message' },
        expectedCode: 'HTTP_400',
        expectedMessage: 'Liara API error: HTTP 400',
      },
    ];

    for (const tc of testCases) {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify(tc.body), {
          status: tc.status,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const adapter = new LiaraOperationalAdapter({
        apiKey: 'test-token',
        fetchFn: mockFetch,
      });

      const outcome = await adapter.createApp(
        {
          appSlug: 'test-app',
          platform: 'nodejs',
          planId: 'standard-base-g2',
        },
        validAuthority
      );

      assert.strictEqual(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.strictEqual(outcome.code, tc.expectedCode);
        assert.strictEqual(outcome.safeMessage, tc.expectedMessage);
      }
    }
  });

  it('bounds error body reading to <= 16 KiB and cancels stream immediately without memory leak', async () => {
    let pulledChunks = 0;
    let cancelCalled = false;
    const totalChunks = 20; // 20 KiB total
    const chunkSize = 1024;

    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulledChunks < totalChunks) {
            pulledChunks++;
            const chunk = new TextEncoder().encode(
              pulledChunks === 1
                ? '{"message":"network is required",'
                : '"pad":"' + 'x'.repeat(1000) + '",'
            );
            controller.enqueue(chunk);
          } else {
            controller.enqueue(new TextEncoder().encode('"end":true}'));
            controller.close();
          }
        },
        cancel() {
          cancelCalled = true;
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 })
    );

    const mockFetch: typeof fetch = async () => {
      return new Response(stream, {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const outcome = await adapter.createApp(
      {
        appSlug: 'bound-test',
        platform: 'nodejs',
        planId: 'standard-base-g2',
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.strictEqual(outcome.code, 'NETWORK_REQUIRED');
      assert.strictEqual(
        outcome.safeMessage,
        'Liara API error: HTTP 400 validation rejected fields: network'
      );
    }

    assert.strictEqual(cancelCalled, true, 'reader.cancel() must be called once 16 KiB ceiling is reached');
    assert(pulledChunks <= 18 && pulledChunks < totalChunks, `Stream read must bound at 16 KiB ceiling; pulled ${pulledChunks} chunks`);
  });

  it('aborts stalled error body read cleanly under existing deadline', async () => {
    const hangingStream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {}); // never resolves
      },
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(hangingStream, {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      timeoutMs: 40,
      fetchFn: mockFetch,
    });

    const outcome = await adapter.createApp(
      {
        appSlug: 'stall-test',
        platform: 'nodejs',
        planId: 'standard-base-g2',
      },
      validAuthority
    );

    assert.strictEqual(outcome.status, 'unknown');
    if (outcome.status === 'unknown') {
      assert.strictEqual(outcome.code, 'TIMEOUT_AFTER_DISPATCH');
    }
  });

  it('accepts dotted opaque sourceID in uploadSource and forwards it in createRelease (SOURCE_ID_REGEX)', async () => {
    let capturedReleaseBody: any;
    let uploadCallCount = 0;
    let releaseCallCount = 0;

    const dottedSourceId = 'uuid-440abc-5678.source.tar.gz';

    const mockFetch: typeof fetch = async (input, init) => {
      const urlStr = input.toString();
      if (urlStr.includes('/sources')) {
        uploadCallCount++;
        return new Response(JSON.stringify({ sourceID: dottedSourceId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('/releases')) {
        releaseCallCount++;
        capturedReleaseBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            releaseID: 'rel_release123456789',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // 1. uploadSource accepts dotted sourceID matching SOURCE_ID_REGEX
    const uploadOutcome = await adapter.uploadSource(
      {
        appSlug: 'my-app',
        sourceArchiveBytes: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        filename: 'source.tar.gz',
      },
      validAuthority
    );

    assert.strictEqual(uploadOutcome.status, 'accepted');
    if (uploadOutcome.status === 'accepted') {
      assert.strictEqual(uploadOutcome.data.sourceId, dottedSourceId);
    }
    assert.strictEqual(uploadCallCount, 1);

    // 2. createRelease accepts dotted sourceId and dispatches it in wire payload
    const releaseOutcome = await adapter.createRelease(
      {
        appSlug: 'my-app',
        sourceId: dottedSourceId,
      },
      validAuthority
    );

    assert.strictEqual(releaseOutcome.status, 'accepted');
    if (releaseOutcome.status === 'accepted') {
      assert.strictEqual(releaseOutcome.data.releaseId, 'rel_release123456789');
    }
    assert.strictEqual(releaseCallCount, 1);
    assert.strictEqual(capturedReleaseBody.sourceID, dottedSourceId);

    // 3. Verify SOURCE_ID_REGEX accepts up to 256 chars with dots, hyphens, underscores
    const maxLenSourceId = 'a'.repeat(240) + '_pkg-v1.0.tar.gz';
    assert.strictEqual(maxLenSourceId.length, 256);
    assert.strictEqual(SOURCE_ID_REGEX.test(maxLenSourceId), true);
  });

  it('sanitizes malformed upload sourceID into safe diagnostic metadata without leaking raw values or canary tokens', async () => {
    const testCases: Array<{
      body: Record<string, unknown>;
      expectedSubstrings: string[];
      prohibitedSubstrings: string[];
    }> = [
      {
        // Disallowed chars with canary token
        body: {
          sourceID: `invalid$token-${CANARY_SECRETS.apiToken}`,
          status: 'success',
          secret_deploy_token: CANARY_SECRETS.jwtSecret,
          untrusted_meta: 'sensitive-internal-id',
        },
        expectedSubstrings: [
          'type: string',
          'hasDisallowedChars',
          'keys: sourceID,status',
        ],
        prohibitedSubstrings: [
          CANARY_SECRETS.apiToken,
          CANARY_SECRETS.jwtSecret,
          'invalid$token',
          'secret_deploy_token',
          'untrusted_meta',
          'sensitive-internal-id',
        ],
      },
      {
        // Slash path traversal
        body: {
          sourceID: `path/traversal/${CANARY_SECRETS.dbPassword}`,
        },
        expectedSubstrings: ['type: string', 'hasSlash'],
        prohibitedSubstrings: [CANARY_SECRETS.dbPassword, 'traversal'],
      },
      {
        // Whitespace
        body: {
          sourceID: 'invalid id with spaces',
        },
        expectedSubstrings: ['type: string', 'hasWhitespace'],
        prohibitedSubstrings: ['invalid id with spaces'],
      },
      {
        // Exceeds 256 characters
        body: {
          sourceID: 'a'.repeat(300),
        },
        expectedSubstrings: ['type: string', 'len: 300', 'lenExceeds256'],
        prohibitedSubstrings: ['a'.repeat(20)],
      },
      {
        // Non-string (e.g. object containing canary)
        body: {
          sourceID: { nestedSecret: CANARY_SECRETS.apiToken },
          message: 'unexpected format',
        },
        expectedSubstrings: ['type: object', 'keys: sourceID,message'],
        prohibitedSubstrings: [CANARY_SECRETS.apiToken, 'nestedSecret'],
      },
      {
        // Non-string number
        body: {
          sourceID: 123456789,
        },
        expectedSubstrings: ['type: number', 'keys: sourceID'],
        prohibitedSubstrings: ['123456789'],
      },
    ];

    for (const tc of testCases) {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify(tc.body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const adapter = new LiaraOperationalAdapter({
        apiKey: 'test-token',
        fetchFn: mockFetch,
      });

      const outcome = await adapter.uploadSource(
        {
          appSlug: 'test-app',
          sourceArchiveBytes: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        },
        validAuthority
      );

      assert.strictEqual(outcome.status, 'unknown');
      if (outcome.status === 'unknown') {
        assert.strictEqual(outcome.code, 'MALFORMED_RESPONSE_UNCERTAIN');

        for (const expected of tc.expectedSubstrings) {
          assert(
            outcome.safeMessage.includes(expected),
            `safeMessage "${outcome.safeMessage}" must include "${expected}"`
          );
        }

        const serialized = JSON.stringify(outcome);
        for (const prohibited of tc.prohibitedSubstrings) {
          assert(
            !serialized.includes(prohibited),
            `Serialized outcome must NEVER leak prohibited value "${prohibited}"`
          );
        }
      }
    }
  });

  it('preserves STRICT_ID_REGEX for releaseId and appSlug and strictly rejects dotted IDs', async () => {
    // 1. STRICT_ID_REGEX rejects dots, slashes, and oversized strings
    assert.strictEqual(STRICT_ID_REGEX.test('release.with.dots'), false);
    assert.strictEqual(STRICT_ID_REGEX.test('release/with/slashes'), false);
    assert.strictEqual(STRICT_ID_REGEX.test('valid-release_123'), true);
    assert.strictEqual(STRICT_ID_REGEX.test('a'.repeat(129)), false);

    // 2. In contrast, SOURCE_ID_REGEX allows dots and up to 256 chars
    assert.strictEqual(SOURCE_ID_REGEX.test('release.with.dots'), true);
    assert.strictEqual(SOURCE_ID_REGEX.test('a'.repeat(200)), true);

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
    });

    // 3. getReleaseDetail rejects dotted releaseId before dispatch
    await assert.rejects(
      async () => {
        await adapter.getReleaseDetail('my-app', 'release.dotted.123');
      },
      /Valid strict releaseId is required/
    );

    // 4. getBoundedLogs rejects dotted releaseId before dispatch
    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('my-app', { releaseId: 'release.dotted.123' });
      },
      /Valid strict releaseId is required/
    );

    // 5. createRelease rejects malformed releaseId returned by server with STRICT_ID_REGEX
    const mockFetchDottedRelease: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          releaseID: 'rel.dotted.invalid',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const adapterDotted = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetchDottedRelease,
    });

    const releaseOutcome = await adapterDotted.createRelease(
      {
        appSlug: 'my-app',
        sourceId: 'valid-source-id.tar.gz',
      },
      validAuthority
    );

    assert.strictEqual(releaseOutcome.status, 'unknown');
    if (releaseOutcome.status === 'unknown') {
      assert.strictEqual(releaseOutcome.code, 'MALFORMED_RESPONSE_UNCERTAIN');
      assert.strictEqual(
        releaseOutcome.safeMessage,
        'Liara API returned unexpected create release payload; status uncertain'
      );
    }
  });
});

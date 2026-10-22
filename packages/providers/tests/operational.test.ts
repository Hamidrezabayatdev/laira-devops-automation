import { describe, it } from 'vitest';
import assert from 'node:assert';
import {
  LiaraOperationalAdapter,
  redactLogSecrets,
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

  it('verifies actual release state via app-scoped getReleaseDetail list match', async () => {
    const mockFetch: typeof fetch = async (input) => {
      assert.strictEqual(input.toString(), 'https://api.liara.ir/v1/projects/my-frontend-app/releases');
      return new Response(
        JSON.stringify(RAW_LIARA_RELEASES_RESPONSE),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const detail = await adapter.getReleaseDetail('my-frontend-app', 'release-internal-id-101');
    assert(detail !== null);
    assert.strictEqual(detail.id, 'release-internal-id-101');
    assert.strictEqual(detail.status, 'ready');
    assert.strictEqual(detail.tag, 'v1.2.0');

    const notFound = await adapter.getReleaseDetail('my-frontend-app', 'release-non-existent');
    assert.strictEqual(notFound, null);
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

  it('enforces line and byte budgets when retrieving bounded logs', async () => {
    const clientKey = 'CLIENT_KEY_EXPLICIT_REDACT';
    const mockLogs = [
      { type: 'stdout', datetime: '2026-10-22T10:00:00Z', message: `Server listening with key ${clientKey} and token ${CANARY_SECRETS.apiToken}` },
      { type: 'stdout', datetime: '2026-10-22T10:00:01Z', message: 'Ready for traffic' },
      { type: 'stderr', datetime: '2026-10-22T10:00:02Z', message: 'Warning: slow query' },
    ];

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(mockLogs), {
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

  it('defaults since to ISO timestamp from 15 min ago and validates since options', async () => {
    let capturedUrl = '';

    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new LiaraOperationalAdapter({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    // Case 1: Default since
    const beforeCall = Date.now() - 15 * 60 * 1000;
    await adapter.getBoundedLogs('test-app');
    const afterCall = Date.now() - 15 * 60 * 1000;

    const parsedUrl = new URL(capturedUrl);
    const sinceParam = parsedUrl.searchParams.get('since');
    assert(sinceParam !== null, 'since query param must be present');
    const sinceTime = Date.parse(sinceParam);
    assert(!Number.isNaN(sinceTime), 'since must be a valid date');
    assert(sinceTime >= beforeCall - 2000 && sinceTime <= afterCall + 2000);

    // Case 2: Explicit valid since timestamp
    await adapter.getBoundedLogs('test-app', { since: 1729600000 });
    assert.strictEqual(new URL(capturedUrl).searchParams.get('since'), '1729600000');

    // Case 3: Rejects huge or invalid since input
    await assert.rejects(
      async () => {
        await adapter.getBoundedLogs('test-app', { since: 'a'.repeat(100) });
      },
      /Invalid since parameter/
    );
  });

  it('redacts metadata secrets: allowlists log type and sanitizes datetime to prevent secret leakage', async () => {
    const clientSecretKey = 'SUPER_SECRET_CLIENT_KEY_999';
    const mockLogs = [
      {
        type: `custom-${clientSecretKey}`, // Arbitrary unallowlisted type containing secret
        datetime: clientSecretKey, // Secret in datetime field
        message: 'log entry with untrusted metadata',
      },
      {
        type: 'STDOUT', // Case-insensitive allowlisted type
        datetime: '2026-10-22T10:00:00.000Z', // Valid ISO datetime
        message: 'normal log entry',
      },
    ];

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(mockLogs), {
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

    // Entry 1: Allowlisted type lowercase 'stdout', preserved valid ISO datetime
    assert.strictEqual(result.lines[1].type, 'stdout');
    assert.strictEqual(result.lines[1].datetime, '2026-10-22T10:00:00.000Z');
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
});

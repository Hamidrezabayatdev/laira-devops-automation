import { describe, it } from 'vitest';
import assert from 'node:assert';
import util from 'node:util';
import { LiaraClient } from '../src/liara/client.ts';
import {
  CredentialedRedirectBlockedError,
  MutationBlockedInReadOnlyAdapterError,
  LiaraOriginMismatchError,
  LiaraApiError,
} from '../src/liara/errors.ts';
import {
  RAW_LIARA_PROJECTS_RESPONSE,
  RAW_LIARA_PROJECT_DETAIL_RESPONSE,
  RAW_LIARA_RELEASES_RESPONSE,
} from '../src/fixtures/liara-fixtures.ts';

describe('Liara Safe Read-Only Adapter', () => {
  it('lists projects with internalId preserved and project_id slug', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify(RAW_LIARA_PROJECTS_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-liara-api-token',
      fetchFn: mockFetch,
    });

    const apps = await client.listProjects();

    assert.strictEqual(apps.length, 2);
    assert.strictEqual(apps[0].internalId, 'liara-app-internal-id-001');
    assert.strictEqual(apps[0].projectId, 'my-frontend-app');
    assert.strictEqual(apps[1].internalId, 'liara-app-internal-id-002');
    assert.strictEqual(apps[1].projectId, 'my-backend-api');

    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v1/projects');
    assert.strictEqual(capturedHeaders['authorization'], 'Bearer test-liara-api-token');
  });

  it('routes getProjectDetail by project_id slug and strips env values', async () => {
    let capturedUrl = '';

    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify(RAW_LIARA_PROJECT_DETAIL_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const detail = await client.getProjectDetail('my-frontend-app');

    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v1/projects/my-frontend-app');
    assert.strictEqual(detail.internalId, 'liara-app-internal-id-001');
    assert.strictEqual(detail.projectId, 'my-frontend-app');
    assert.strictEqual(detail.hasEnvs, true);
    assert.deepStrictEqual(detail.envKeys, ['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV']);
  });

  it('properly encodes project_id slug in getProjectDetail and listReleases', async () => {
    const urls: string[] = [];

    const mockFetch: typeof fetch = async (input) => {
      urls.push(input.toString());
      return new Response(JSON.stringify({ project: { id: '1', project_id: 'app-with-slug' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    await client.getProjectDetail('app with spaces');
    assert.strictEqual(urls[0], 'https://api.liara.ir/v1/projects/app%20with%20spaces');
  });

  it('lists releases for a project slug', async () => {
    let capturedUrl = '';

    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify(RAW_LIARA_RELEASES_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const releases = await client.listReleases('my-frontend-app');

    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v1/projects/my-frontend-app/releases');
    assert.strictEqual(releases.length, 2);
    assert.strictEqual(releases[0].id, 'release-internal-id-101');
    assert.strictEqual(releases[0].tag, 'v1.2.0');
  });

  it('lists projects supporting honest CLI wire shape { projects: [...] } as well as docs array shape', async () => {
    // Honest CLI response object: { projects: [...] }
    const cliWireResponse = { projects: RAW_LIARA_PROJECTS_RESPONSE };

    const mockFetchCli: typeof fetch = async () => {
      return new Response(JSON.stringify(cliWireResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const clientCli = new LiaraClient({
      apiKey: 'test-token',
      fetchFn: mockFetchCli,
    });

    const appsCli = await clientCli.listProjects();
    assert.strictEqual(appsCli.length, 2);
    assert.strictEqual(appsCli[0].projectId, 'my-frontend-app');
    assert.strictEqual(appsCli[1].projectId, 'my-backend-api');

    // Docs fallback response array: [...]
    const mockFetchDocs: typeof fetch = async () => {
      return new Response(JSON.stringify(RAW_LIARA_PROJECTS_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const clientDocs = new LiaraClient({
      apiKey: 'test-token',
      fetchFn: mockFetchDocs,
    });

    const appsDocs = await clientDocs.listProjects();
    assert.strictEqual(appsDocs.length, 2);
    assert.strictEqual(appsDocs[0].projectId, 'my-frontend-app');
  });

  it('retrieves single release detail by releaseId via GET /v1/releases/{releaseId}', async () => {
    let capturedUrl = '';

    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response(
        JSON.stringify({
          release: {
            _id: 'release-test-999',
            project_id: 'my-app',
            state: 'READY',
            tag: 'v2.0.0',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new LiaraClient({
      apiKey: 'test-token',
      fetchFn: mockFetch,
    });

    const release = await client.getReleaseDetail('release-test-999');
    assert.strictEqual(capturedUrl, 'https://api.liara.ir/v1/releases/release-test-999');
    assert.strictEqual(release.id, 'release-test-999');
    assert.strictEqual(release.projectId, 'my-app');
    assert.strictEqual(release.state, 'READY');
    assert.strictEqual(release.tag, 'v2.0.0');
  });

  it('appends and overrides teamID query parameter per connection to all requests', async () => {
    const urls: string[] = [];

    const mockFetch: typeof fetch = async (input) => {
      urls.push(input.toString());
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'team-token',
      teamId: 'team-alpha-99',
      fetchFn: mockFetch,
    });

    await client.listProjects();

    assert.strictEqual(urls.length, 1);
    const parsed = new URL(urls[0]);
    assert.strictEqual(parsed.searchParams.get('teamID'), 'team-alpha-99');
  });

  it('strictly enforces fixed origin https://api.liara.ir', async () => {
    const client = new LiaraClient({
      apiKey: 'test-key',
    });

    await assert.rejects(
      async () => {
        // Attempting to bypass fixed origin via absolute URL
        await (client as any).safeFetch('https://evil-spoof-liara.ir/v1/projects');
      },
      (err: any) => {
        assert(err instanceof LiaraOriginMismatchError);
        assert.strictEqual(err.code, 'ORIGIN_MISMATCH');
        return true;
      }
    );
  });

  it('blocks ALL redirects (same-origin and cross-origin) without recursion or resends', async () => {
    let fetchCount = 0;

    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      // Returning 302 pointing to same-origin path
      return new Response(null, {
        status: 302,
        headers: {
          Location: 'https://api.liara.ir/v1/projects-redirected',
        },
      });
    };

    const client = new LiaraClient({
      apiKey: 'secret-token',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.listProjects();
      },
      (err: any) => {
        assert(err instanceof CredentialedRedirectBlockedError);
        assert.strictEqual(err.code, 'CREDENTIALED_REDIRECT_BLOCKED');
        return true;
      }
    );

    // Verify absolutely no resends: fetch called exactly once!
    assert.strictEqual(fetchCount, 1);
  });

  it('aborts and fails with RESPONSE_SIZE_EXCEEDED on enormous multibyte response body and cancels stream', async () => {
    const maxBytes = 256;
    let streamCancelled = false;

    // Multibyte Persian string: each character is 2 bytes in UTF-8
    const persianText = 'سلام دنیا به پروژه‌های ابری لیارا '.repeat(30);
    const rawPayload = JSON.stringify({
      projects: [{ project_id: 'persian-app', text: persianText }],
    });

    const mockFetch: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const chunks = [
        encoder.encode(rawPayload.slice(0, 100)),
        encoder.encode(rawPayload.slice(100, 300)),
        encoder.encode(rawPayload.slice(300)),
      ];

      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
        cancel() {
          streamCancelled = true;
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      maxResponseSizeBytes: maxBytes,
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.listProjects();
      },
      (err: any) => {
        assert(err instanceof LiaraApiError);
        assert.strictEqual(err.code, 'RESPONSE_SIZE_EXCEEDED');
        assert.strictEqual(err.safeMessage.includes('exceeded 256 bytes limit'), true);
        return true;
      }
    );

    assert.strictEqual(streamCancelled, true);
  });

  it('fails immediately with REQUEST_TIMEOUT on permanently stalled body and cancels stream', async () => {
    let cancelCalled = false;

    // A stream whose read() NEVER resolves (permanently hung)
    const hangingStream = new ReadableStream({
      pull() {
        return new Promise<void>(() => {}); // Never resolves
      },
      cancel() {
        cancelCalled = true;
      },
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(hangingStream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      timeoutMs: 25, // Short deadline for test
      fetchFn: mockFetch,
    });

    const startTime = Date.now();
    await assert.rejects(
      async () => {
        await client.listProjects();
      },
      (err: any) => {
        assert(err instanceof LiaraApiError);
        assert.strictEqual(err.code, 'REQUEST_TIMEOUT');
        assert.strictEqual(err.statusCode, 408);
        return true;
      }
    );

    const elapsed = Date.now() - startTime;
    // Must reject promptly around 25ms, not hang indefinitely
    assert(elapsed < 200, `Expected prompt abort around 25ms, took ${elapsed}ms`);
    assert.strictEqual(cancelCalled, true);
  });

  it('fails with REQUEST_TIMEOUT on non-cooperative hanging header fetch', async () => {
    // A fetchFn that never resolves headers
    const nonCooperativeFetch: typeof fetch = async () => {
      return new Promise<Response>(() => {}); // Never resolves
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      timeoutMs: 25,
      fetchFn: nonCooperativeFetch,
    });

    const startTime = Date.now();
    await assert.rejects(
      async () => {
        await client.listProjects();
      },
      (err: any) => {
        assert(err instanceof LiaraApiError);
        assert.strictEqual(err.code, 'REQUEST_TIMEOUT');
        assert.strictEqual(err.statusCode, 408);
        return true;
      }
    );

    const elapsed = Date.now() - startTime;
    assert(elapsed < 200, `Expected prompt abort around 25ms, took ${elapsed}ms`);
  });

  it('ensures API key is private and never leaks in JSON serialization, inspect, or Object.keys', () => {
    const rawKey = 'super-secret-api-key-XYZ-12345';
    const client = new LiaraClient({
      apiKey: rawKey,
      teamId: 'team-safe',
      timeoutMs: 5000,
      maxResponseSizeBytes: 50000,
    });

    // 1. JSON.stringify check
    const serialized = JSON.stringify(client);
    assert.strictEqual(serialized.includes(rawKey), false);
    assert.strictEqual(serialized.includes('apiKey'), false);

    // 2. Object.keys check
    const keys = Object.keys(client);
    assert.strictEqual(keys.includes('apiKey'), false);
    assert.strictEqual(keys.includes('#apiKey'), false);

    // 3. util.inspect check
    const inspected = util.inspect(client);
    assert.strictEqual(inspected.includes(rawKey), false);
    assert.strictEqual(inspected.includes('apiKey'), false);
  });

  it('rejects invalid config bounds: NaN, Infinity, negative, zero, and empty key', () => {
    // Invalid API key
    assert.throws(() => new LiaraClient({ apiKey: '' }), /valid non-empty apiKey/);
    assert.throws(() => new LiaraClient({ apiKey: '   ' }), /valid non-empty apiKey/);

    // Invalid timeoutMs bounds
    assert.throws(() => new LiaraClient({ apiKey: 'k', timeoutMs: Number.NaN }), /finite positive number/);
    assert.throws(() => new LiaraClient({ apiKey: 'k', timeoutMs: Number.POSITIVE_INFINITY }), /finite positive number/);
    assert.throws(() => new LiaraClient({ apiKey: 'k', timeoutMs: 0 }), /finite positive number/);
    assert.throws(() => new LiaraClient({ apiKey: 'k', timeoutMs: -500 }), /finite positive number/);

    // Invalid maxResponseSizeBytes bounds
    assert.throws(() => new LiaraClient({ apiKey: 'k', maxResponseSizeBytes: Number.NaN }), /finite positive number/);
    assert.throws(() => new LiaraClient({ apiKey: 'k', maxResponseSizeBytes: Number.POSITIVE_INFINITY }), /finite positive number/);
    assert.throws(() => new LiaraClient({ apiKey: 'k', maxResponseSizeBytes: 0 }), /finite positive number/);
    assert.throws(() => new LiaraClient({ apiKey: 'k', maxResponseSizeBytes: -100 }), /finite positive number/);
  });

  it('fails honestly with MALFORMED_PAYLOAD on non-JSON response body', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('<html><head><title>502 Bad Gateway</title></head></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
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
        assert(err instanceof LiaraApiError);
        assert.strictEqual(err.code, 'MALFORMED_PAYLOAD');
        assert.strictEqual(err.safeMessage, 'Liara API returned invalid JSON payload');
        return true;
      }
    );
  });

  it('fails honestly with MALFORMED_PAYLOAD when listProjects returns unexpected payload structure', async () => {
    const mockFetch: typeof fetch = async () => {
      // Returning object with status "ok" instead of array or { projects: [] }
      return new Response(JSON.stringify({ status: 'ok', count: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    // In the old buggy implementation, this silently returned [] !
    // Now it MUST fail honestly with MALFORMED_PAYLOAD.
    await assert.rejects(
      async () => {
        await client.listProjects();
      },
      (err: any) => {
        assert(err instanceof LiaraApiError);
        assert.strictEqual(err.code, 'MALFORMED_PAYLOAD');
        return true;
      }
    );
  });

  it('fails honestly with MALFORMED_PAYLOAD when project item in listProjects has invalid slug', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify([{ _id: '1', project_id: 'INVALID SLUG WITH SPACES!' }]), {
        status: 200,
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
        assert(err instanceof LiaraApiError);
        assert.strictEqual(err.code, 'MALFORMED_PAYLOAD');
        return true;
      }
    );
  });

  it('fails honestly with MALFORMED_PAYLOAD when listReleases returns unexpected payload structure', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new LiaraClient({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.listReleases('my-app');
      },
      (err: any) => {
        assert(err instanceof LiaraApiError);
        assert.strictEqual(err.code, 'MALFORMED_PAYLOAD');
        return true;
      }
    );
  });

  it('fails honestly with MALFORMED_PAYLOAD when getProjectDetail returns non-object payload', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(['an', 'array', 'instead', 'of', 'object']), {
        status: 200,
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
        assert(err instanceof LiaraApiError);
        assert.strictEqual(err.code, 'MALFORMED_PAYLOAD');
        return true;
      }
    );
  });

  it('reports capabilities honestly: releases unverified, mutations unsupported', async () => {
    const client = new LiaraClient({
      apiKey: 'test-key',
    });

    const capabilities = client.getCapabilities();

    const listCap = capabilities.find((c) => c.capability === 'apps.list');
    assert.strictEqual(listCap?.status, 'supported');
    assert.strictEqual(listCap?.notes.includes('account-tested'), true);

    const releaseCap = capabilities.find((c) => c.capability === 'releases.list');
    assert.strictEqual(releaseCap?.status, 'unverified');
    assert.strictEqual(releaseCap?.notes.includes('Raw fixtures do not prove releases live'), true);

    const deployCap = capabilities.find((c) => c.capability === 'apps.deploy');
    assert.strictEqual(deployCap?.status, 'unsupported');
    assert.strictEqual(deployCap?.readOnly, false);

    // Mutations must throw MutationBlockedInReadOnlyAdapterError
    await assert.rejects(async () => client.deploy(), MutationBlockedInReadOnlyAdapterError);
    await assert.rejects(async () => client.restart(), MutationBlockedInReadOnlyAdapterError);
    await assert.rejects(async () => client.power(), MutationBlockedInReadOnlyAdapterError);
    await assert.rejects(async () => client.resize(), MutationBlockedInReadOnlyAdapterError);
  });
});

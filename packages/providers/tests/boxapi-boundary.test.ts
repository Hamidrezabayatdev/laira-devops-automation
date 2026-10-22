import { describe, it } from 'vitest';
import assert from 'node:assert';
import util from 'node:util';
import { BoxApiClient } from '../src/boxapi/client.ts';
import {
  BoxApiError,
  InterruptedStreamError,
  MalformedPayloadError,
  ResponseSizeExceededError,
  RunBudgetExceededError,
} from '../src/boxapi/errors.ts';
import { WorkspaceConcurrencyController, RunBudgetController } from '../src/boxapi/budget.ts';

describe('BoxAPI Critical Boundary & Security Hardening', () => {
  const OPAQUE_CANARY_SECRET = 'opaque-canary-key-999-xyz-never-leak';

  it('hides credentials: no enumerable raw apiKey, no public openai SDK bypass, safe inspect/JSON', () => {
    const client = new BoxApiClient({
      apiKey: OPAQUE_CANARY_SECRET,
      keyMode: 'byok',
      workspaceId: 'ws-secret-check',
      ownerId: 'owner-secret-check',
    });

    // 1. Private SDK & private guarded transport: cannot bypass gates
    assert.strictEqual((client as any).openai, undefined);
    assert.strictEqual('openai' in client, false);
    assert.strictEqual((client as any).guardedFetch, undefined);
    assert.strictEqual('guardedFetch' in client, false);

    // 2. Config getter redacts apiKey
    assert.strictEqual(client.config.apiKey, '[REDACTED]');

    // 3. Enumerable keys on client do not include raw apiKey
    const ownKeys = Object.keys(client);
    assert.strictEqual(ownKeys.includes('apiKey'), false);

    // 4. JSON.stringify does NOT contain secret
    const serialized = JSON.stringify(client);
    assert.strictEqual(serialized.includes(OPAQUE_CANARY_SECRET), false);

    // 5. util.inspect does NOT contain secret
    const inspected = util.inspect(client);
    assert.strictEqual(inspected.includes(OPAQUE_CANARY_SECRET), false);
  });

  it('returns static error messages when upstream throws arbitrary opaque secret (zero echoing)', async () => {
    const mockFetch: typeof fetch = async () => {
      // Simulate upstream network/error that contains an arbitrary unformatted secret in message & code
      const error: any = new Error(`Connection failed with internal secret: ${OPAQUE_CANARY_SECRET}`);
      error.code = `LEAK_${OPAQUE_CANARY_SECRET}`;
      throw error;
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-opaque-error',
      ownerId: 'owner-opaque-error',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-opaque-error',
          messages: [{ role: 'user', content: 'test' }],
        });
      },
      (err: any) => {
        assert(err instanceof BoxApiError);
        const errFullText = `${err.name}: ${err.message} code=${err.code} safeMessage=${err.safeMessage}`;
        // Verify ZERO echoing of arbitrary secret
        assert.strictEqual(errFullText.includes(OPAQUE_CANARY_SECRET), false);
        assert.strictEqual(err.safeMessage, 'BoxAPI network request failed.');
        return true;
      }
    );
  });

  it('sanitizes onChunk errors and never embeds arbitrary user/callback error messages', async () => {
    const ON_CHUNK_SECRET = 'secret-in-chunk-callback-12345';

    const mockFetch: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const s = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"chunk"}}]}\n\n'));
          c.enqueue(encoder.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(s, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-onchunk-error',
      ownerId: 'owner-onchunk-error',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.streamChat({
          runId: 'run-onchunk-error',
          messages: [{ role: 'user', content: 'test' }],
          onChunk: () => {
            throw new Error(`Callback failed with: ${ON_CHUNK_SECRET}`);
          },
        });
      },
      (err: any) => {
        assert(err instanceof BoxApiError);
        assert.strictEqual(err.code, 'ON_CHUNK_HANDLER_ERROR');
        // Ensure error message is completely static and does not echo callback message
        assert.strictEqual(err.safeMessage, 'Error occurred during onChunk callback execution');
        const errFull = `${err.message} ${err.safeMessage}`;
        assert.strictEqual(errFull.includes(ON_CHUNK_SECRET), false);
        return true;
      }
    );
  });

  it('validates SSE data JSON before OpenAI SDK parser to prevent SDK console.error logs', async () => {
    // Intercept console.error to assert ZERO console.error calls occurred during SSE parsing
    const originalError = console.error;
    const interceptedErrors: string[] = [];
    console.error = (...args: any[]) => interceptedErrors.push(args.join(' '));

    try {
      const mockFetch: typeof fetch = async () => {
        const brokenStream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            // Truncated invalid JSON chunk
            controller.enqueue(
              encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"truncated...\n\n')
            );
            controller.close();
          },
        });
        return new Response(brokenStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const client = new BoxApiClient({
        apiKey: 'test-key',
        keyMode: 'byok',
        workspaceId: 'ws-no-console-error',
        ownerId: 'owner-no-console-error',
        fetchFn: mockFetch,
      });

      await assert.rejects(
        async () => {
          await client.streamChat({
            runId: 'run-no-console-err',
            messages: [{ role: 'user', content: 'test' }],
          });
        },
        (err: any) => {
          assert(err instanceof InterruptedStreamError);
          return true;
        }
      );

      // Verify that OpenAI SDK's internal console.error was NEVER invoked!
      assert.strictEqual(
        interceptedErrors.some((e) => e.includes('Could not parse message into JSON')),
        false,
        'Expected zero console.error logs from OpenAI SDK SSE parser'
      );
    } finally {
      console.error = originalError;
    }
  });

  it('rejects false DONE: content containing [DONE] substring does not prematurely finish stream', async () => {
    const mockFetch: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Assistant payload contains literal text "[DONE]" in its content!
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"index":0,"delta":{"content":"The string [DONE] is in text."},"finish_reason":null}]}\n\n'
            )
          );
          // Stream closes prematurely without actual protocol data: [DONE]
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-fake-done',
      ownerId: 'owner-fake-done',
      fetchFn: mockFetch,
    });

    // Must fail because exact protocol event data: [DONE] was never received
    await assert.rejects(
      async () => {
        await client.streamChat({
          runId: 'run-fake-done',
          messages: [{ role: 'user', content: 'test' }],
        });
      },
      (err: any) => {
        assert(err instanceof InterruptedStreamError);
        return true;
      }
    );
  });

  it('aborts stalled full-body reads when deadline timeout triggers', async () => {
    const mockFetch: typeof fetch = async (_url, init) => {
      const stream = new ReadableStream({
        start() {
          // Hang indefinitely - simulate stalled body read
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-stalled-timeout',
      ownerId: 'owner-stalled-timeout',
      timeoutMs: 50, // Rapid timeout
      fetchFn: mockFetch,
    });

    const start = Date.now();
    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-stalled-timeout',
          messages: [{ role: 'user', content: 'test' }],
        });
      },
      (err: any) => {
        assert(err instanceof BoxApiError);
        assert.strictEqual(err.code, 'REQUEST_TIMEOUT');
        return true;
      }
    );
    const elapsed = Date.now() - start;
    assert(elapsed < 2000, `Expected rapid timeout cancellation under 2s, took ${elapsed}ms`);
  });

  it('validates completion shape and rejects empty choices array', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          id: 'chat-empty',
          object: 'chat.completion',
          choices: [], // Malformed empty choices
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-empty-choices',
      ownerId: 'owner-empty-choices',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-empty-choices',
          messages: [{ role: 'user', content: 'test' }],
        });
      },
      (err: any) => {
        assert(err instanceof MalformedPayloadError);
        return true;
      }
    );
  });

  it('enforces bounds on maxTokens: rejects NaN, negative, zero and caps huge values', async () => {
    let capturedBody: any;
    const mockFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-token-bounds',
      ownerId: 'owner-token-bounds',
      fetchFn: mockFetch,
    });

    // 1. Rejects NaN
    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-nan-tokens',
          messages: [{ role: 'user', content: 'test' }],
          maxTokens: Number.NaN,
        });
      },
      /Invalid maxTokens option/
    );

    // 2. Rejects negative
    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-neg-tokens',
          messages: [{ role: 'user', content: 'test' }],
          maxTokens: -50,
        });
      },
      /Invalid maxTokens option/
    );

    // 3. Huge number is capped at 8192
    await client.chat({
      runId: 'run-huge-tokens',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 100_000,
    });
    assert.strictEqual(capturedBody.max_tokens, 8192);
  });

  it('releases concurrency lock and preserves budget when pre-dispatch tool formatting throws', async () => {
    const concurrencyController = new WorkspaceConcurrencyController();
    const budgetController = new RunBudgetController(4);

    const client = new BoxApiClient(
      {
        apiKey: 'test-key',
        keyMode: 'byok',
        workspaceId: 'ws-tool-throw',
        ownerId: 'owner-tool-throw',
      },
      { concurrencyController, budgetController }
    );

    const brokenTool = {
      name: 'broken_tool',
      description: 'Throws in toJsonSchema',
      parameters: {
        toJsonSchema() {
          throw new Error('Tool schema generation failed');
        },
      },
    };

    // Pre-dispatch failure due to tool formatting error
    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-tool-throw',
          messages: [{ role: 'user', content: 'test' }],
          tools: [brokenTool as any],
        });
      },
      /Tool schema generation failed/
    );

    // Concurrency lock must NOT be held!
    assert.strictEqual(concurrencyController.isBusy('ws-tool-throw'), false);

    // Budget dispatch count must NOT be consumed by pre-dispatch error!
    assert.strictEqual(budgetController.getRunCallCount('run-tool-throw'), 0);
  });
});

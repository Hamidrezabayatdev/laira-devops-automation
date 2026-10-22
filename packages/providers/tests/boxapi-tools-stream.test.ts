import { describe, it } from 'vitest';
import assert from 'node:assert';
import { BoxApiClient } from '../src/boxapi/client.ts';
import { s } from '../src/schema/validator.ts';
import {
  MalformedToolCallError,
  InterruptedStreamError,
  ResponseSizeExceededError,
  MalformedPayloadError,
} from '../src/boxapi/errors.ts';
import {
  BOXAPI_TOOL_CALL_RESPONSE,
  BOXAPI_MALFORMED_JSON_TOOL_CALL,
  BOXAPI_INVALID_SCHEMA_TOOL_CALL,
  BOXAPI_STREAM_CHUNKS,
} from '../src/fixtures/boxapi-fixtures.ts';

describe('BoxAPI Strict Tools & Streaming Handling', () => {
  const getAppSummaryTool = {
    name: 'get_app_summary',
    description: 'Get application summary',
    parameters: s.object({
      app_slug: s.string({ minLength: 1, maxLength: 64 }),
    }),
  };

  it('validates and parses valid tool call arguments from model', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(BOXAPI_TOOL_CALL_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-tool-valid',
      ownerId: 'owner-tool-valid',
      fetchFn: mockFetch,
    });

    const result = await client.chat({
      runId: 'run-tool-valid',
      messages: [{ role: 'user', content: 'Check status' }],
      tools: [getAppSummaryTool],
    });

    assert(result.toolCalls);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, 'get_app_summary');
    assert.deepStrictEqual(result.toolCalls[0].arguments, { app_slug: 'laira-test-app' });
  });

  it('supports direct Zod-like schema with safeParse and _def in tool definition', async () => {
    // Mock ZodObject structure
    const zodLikeSchema = {
      _def: {
        typeName: 'ZodObject',
        shape: () => ({
          app_slug: { _def: { typeName: 'ZodString' } },
        }),
      },
      safeParse(input: any) {
        if (input && typeof input.app_slug === 'string') {
          return { success: true, data: input };
        }
        return { success: false, error: { issues: [{ path: ['app_slug'], message: 'Expected string' }] } };
      },
    };

    const zodTool = {
      name: 'get_app_summary',
      description: 'Zod compatible tool',
      parameters: zodLikeSchema,
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(BOXAPI_TOOL_CALL_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-zod',
      ownerId: 'owner-zod',
      fetchFn: mockFetch,
    });

    const result = await client.chat({
      runId: 'run-zod',
      messages: [{ role: 'user', content: 'Zod test' }],
      tools: [zodTool],
    });

    assert(result.toolCalls);
    assert.strictEqual((result.toolCalls[0].arguments as any).app_slug, 'laira-test-app');
  });

  it('rejects malformed JSON syntax in tool call with MalformedToolCallError', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(BOXAPI_MALFORMED_JSON_TOOL_CALL), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-malformed-json',
      ownerId: 'owner-malformed-json',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-malformed-json',
          messages: [{ role: 'user', content: 'Check status' }],
          tools: [getAppSummaryTool],
        });
      },
      (err: any) => {
        assert(err instanceof MalformedToolCallError);
        assert.strictEqual(err.code, 'MALFORMED_TOOL_CALL');
        assert.strictEqual(err.errors[0].includes('invalid JSON syntax'), true);
        return true;
      }
    );
  });

  it('rejects tool arguments failing schema validation with MalformedToolCallError', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(BOXAPI_INVALID_SCHEMA_TOOL_CALL), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-invalid-schema',
      ownerId: 'owner-invalid-schema',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-invalid-schema',
          messages: [{ role: 'user', content: 'Check status' }],
          tools: [getAppSummaryTool],
        });
      },
      (err: any) => {
        assert(err instanceof MalformedToolCallError);
        assert.strictEqual(err.code, 'MALFORMED_TOOL_CALL');
        return true;
      }
    );
  });

  it('parses streamed SSE chunks and aggregates content and usage', async () => {
    const mockFetch: typeof fetch = async () => {
      const sseStream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of BOXAPI_STREAM_CHUNKS) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(sseStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-stream',
      ownerId: 'owner-stream',
      fetchFn: mockFetch,
    });

    const receivedChunks: string[] = [];

    const streamResult = await client.streamChat({
      runId: 'run-stream-test',
      messages: [{ role: 'user', content: 'Stream test' }],
      onChunk: (chunk) => {
        if (chunk.content) receivedChunks.push(chunk.content);
      },
    });

    assert.strictEqual(
      streamResult.content,
      'برنامه laira-test-app با وضعیت running در حال اجراست.'
    );
    assert.strictEqual(receivedChunks.join(''), streamResult.content);
    assert.strictEqual(streamResult.finishReason, 'stop');
    assert(streamResult.usage);
    assert.strictEqual(streamResult.usage.totalTokens, 60);
    assert.strictEqual(streamResult.usage.providerReportedCost, 0.000006);
  });

  it('fails with InterruptedStreamError on interrupted stream without [DONE]', async () => {
    const mockFetch: typeof fetch = async () => {
      const brokenStream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"partial content"}}\n\n'));
          // Abruptly terminate stream without [DONE]
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
      workspaceId: 'ws-stream-interrupted',
      ownerId: 'owner-stream-interrupted',
      fetchFn: mockFetch,
    });

    // Policy: MUST fail on interrupted stream, never claim success!
    await assert.rejects(
      async () => {
        await client.streamChat({
          runId: 'run-broken-stream',
          messages: [{ role: 'user', content: 'Interrupted test' }],
        });
      },
      (err: any) => {
        assert(err instanceof InterruptedStreamError);
        assert.strictEqual(err.code, 'STREAM_INTERRUPTED');
        return true;
      }
    );
  });

  it('enforces response byte limits and throws ResponseSizeExceededError', async () => {
    const largePayload = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'A'.repeat(5000) } }],
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(largePayload, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-oversized',
      ownerId: 'owner-oversized',
      maxBytes: 1000, // Small 1KB limit
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-oversized',
          messages: [{ role: 'user', content: 'Big test' }],
        });
      },
      (err: any) => {
        assert(err instanceof ResponseSizeExceededError);
        assert.strictEqual(err.code, 'RESPONSE_SIZE_EXCEEDED');
        return true;
      }
    );
  });

  it('throws MalformedPayloadError when response body is not valid JSON', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('<html><body>502 Bad Gateway from Cloudflare</body></html>', {
        status: 200, // In some proxy failures, HTML comes back with 200
        headers: { 'Content-Type': 'text/html' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-malformed-body',
      ownerId: 'owner-malformed-body',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-malformed-body',
          messages: [{ role: 'user', content: 'Test' }],
        });
      },
      (err: any) => {
        assert(err instanceof MalformedPayloadError);
        assert.strictEqual(err.code, 'MALFORMED_PAYLOAD');
        return true;
      }
    );
  });
});

import { describe, it, expect } from 'vitest';
import assert from 'node:assert';
import OpenAI from 'openai';
import { z } from 'zod';
import { BoxApiClient } from '../src/boxapi/client.ts';
import {
  BoxApiRedirectError,
  BoxApiOriginMismatchError,
  ResponseSizeExceededError,
  InterruptedStreamError,
  AuthDeniedDisableError,
  BoxApiError,
  MalformedToolCallError,
} from '../src/boxapi/errors.ts';
import { formatToolsForOpenAi, validateAndParseToolCall } from '../src/boxapi/tools.ts';
import { zodToJsonSchema } from '../src/schema/validator.ts';
import { GPT_5_4_MINI_MODEL } from '../src/boxapi/types.ts';

describe('Official OpenAI SDK Integration & Acceptance Criteria', () => {
  it('instantiates actual official OpenAI SDK instance internally without public bypass', () => {
    const client = new BoxApiClient({
      apiKey: 'test-api-key',
      keyMode: 'byok',
      workspaceId: 'ws-sdk-test',
      ownerId: 'owner-sdk-test',
      timeoutMs: 15_000,
    });

    // 1. Verify SDK instance and guardedFetch are private (#fields) and not exposed for bypass
    assert.strictEqual((client as any).openai, undefined);
    assert.strictEqual((client as any).guardedFetch, undefined);

    // 2. Verify credentials cannot leak via config or serialization
    assert.strictEqual(client.config.apiKey, '[REDACTED]');
    const jsonStr = JSON.stringify(client);
    assert.strictEqual(jsonStr.includes('test-api-key'), false);
  });

  it('routes chat requests through OpenAI SDK and guarded fetch', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const mockFetch: typeof fetch = async (url, init) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-sdk-test',
          object: 'chat.completion',
          created: 1729600000,
          model: 'qwen/qwen3.7-flash',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'SDK integration confirmed' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new BoxApiClient({
      apiKey: 'secret-key-123',
      keyMode: 'byok',
      workspaceId: 'ws-sdk-flow',
      ownerId: 'owner-sdk-flow',
      fetchFn: mockFetch,
    });

    const res = await client.chat({
      runId: 'run-sdk-flow',
      messages: [{ role: 'user', content: 'Ping via SDK' }],
    });

    assert.strictEqual(res.content, 'SDK integration confirmed');
    assert.strictEqual(res.finishReason, 'stop');
    assert.strictEqual(capturedUrl, 'https://ai.boxapi.ir/ai/v1/chat/completions');
    // Verify redirect: 'error' forced on fetch
    assert.strictEqual(capturedInit?.redirect, 'error');
    // Verify authorization header
    const headers = new Headers(capturedInit?.headers);
    assert.strictEqual(headers.get('authorization'), 'Bearer secret-key-123');
  });

  it('forces redirect: error and blocks redirect attempts on completions', async () => {
    // Redirect response status 302
    const redirectFetch: typeof fetch = async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.com' },
      });
    };

    const clientRedirect = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-redirect-test-2',
      ownerId: 'owner-redirect-test-2',
      fetchFn: redirectFetch,
    });

    await assert.rejects(
      async () => {
        await clientRedirect.chat({
          runId: 'run-redirect',
          messages: [{ role: 'user', content: 'test' }],
        });
      },
      (err: any) => {
        assert(err instanceof BoxApiRedirectError);
        return true;
      }
    );
  });

  it('bounds whole body bytes for non-streaming JSON responses', async () => {
    // 500 byte limit
    const mockFetch: typeof fetch = async () => {
      const largeContent = 'X'.repeat(1000);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: largeContent } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-byte-bound',
      ownerId: 'owner-byte-bound',
      maxBytes: 500,
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-byte-bound',
          messages: [{ role: 'user', content: 'test' }],
        });
      },
      (err: any) => {
        assert(err instanceof ResponseSizeExceededError);
        assert.strictEqual(err.limitBytes, 500);
        return true;
      }
    );
  });

  it('bounds whole body bytes for streaming SSE responses', async () => {
    const mockFetch: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Send 600 bytes in chunks, with a 300 byte limit
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"' + 'A'.repeat(200) + '"}}]}\n\n')
          );
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"' + 'B'.repeat(200) + '"}}]}\n\n')
          );
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"' + 'C'.repeat(200) + '"}}]}\n\n')
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
      workspaceId: 'ws-stream-byte-bound',
      ownerId: 'owner-stream-byte-bound',
      maxBytes: 300,
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.streamChat({
          runId: 'run-stream-byte-bound',
          messages: [{ role: 'user', content: 'test' }],
        });
      },
      (err: any) => {
        assert(err instanceof ResponseSizeExceededError);
        return true;
      }
    );
  });

  it('sanitizes raw SDK errors and never exposes credentials or bearer tokens', async () => {
    const CANARY_KEY = 'canary-secret-super-private-token-999';

    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: `Bearer ${CANARY_KEY} was rejected by upstream gateway`,
            code: 'gateway_error',
          },
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new BoxApiClient({
      apiKey: CANARY_KEY,
      keyMode: 'byok',
      workspaceId: 'ws-canary',
      ownerId: 'owner-canary',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-canary',
          messages: [{ role: 'user', content: 'test' }],
        });
      },
      (err: any) => {
        assert(err instanceof BoxApiError);
        const errStr = `${err.name}: ${err.message} ${err.safeMessage}`;
        assert.strictEqual(errStr.includes(CANARY_KEY), false);
        return true;
      }
    );
  });

  it('enforces mini compatibility: max_completion_tokens for mini, max_tokens for qwen', async () => {
    let capturedBodyMini: any;
    let capturedBodyQwen: any;

    const mockFetchMini: typeof fetch = async (_url, init) => {
      capturedBodyMini = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'mini' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const mockFetchQwen: typeof fetch = async (_url, init) => {
      capturedBodyQwen = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'qwen' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    // 1. Mini Client
    const clientMini = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-mini-compat',
      ownerId: 'owner-mini-compat',
      configuredModel: GPT_5_4_MINI_MODEL,
      fetchFn: mockFetchMini,
    });

    await clientMini.chat({
      runId: 'run-mini-compat',
      messages: [{ role: 'user', content: 'test' }],
    });

    assert.strictEqual(capturedBodyMini.model, 'openai/gpt-5.4-mini');
    assert.strictEqual(capturedBodyMini.max_completion_tokens, 256);
    assert.strictEqual(capturedBodyMini.max_tokens, undefined);
    assert.strictEqual(capturedBodyMini.temperature, undefined);

    // 2. Qwen Client
    const clientQwen = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-qwen-compat',
      ownerId: 'owner-qwen-compat',
      fetchFn: mockFetchQwen,
    });

    await clientQwen.chat({
      runId: 'run-qwen-compat',
      messages: [{ role: 'user', content: 'test' }],
    });

    assert.strictEqual(capturedBodyQwen.model, 'qwen/qwen3.7-flash');
    assert.strictEqual(capturedBodyQwen.max_tokens, 1200);
    assert.strictEqual(capturedBodyQwen.max_completion_tokens, undefined);
    assert.strictEqual(capturedBodyQwen.temperature, undefined);
  });

  it('converts Zod schema with official SDK zod helper without losing strict constraints', () => {
    const deploymentSchema = z.object({
      app_name: z.string().min(3).max(32),
      replicas: z.number().int().min(1).max(10),
      plan: z.enum(['standard', 'pro', 'enterprise']),
      auto_scale: z.boolean(),
    });

    const jsonSchema = zodToJsonSchema(deploymentSchema);

    // Verify official strict JSON schema output
    assert.strictEqual(jsonSchema.type, 'object');
    assert.strictEqual(jsonSchema.additionalProperties, false);
    assert(jsonSchema.properties && typeof jsonSchema.properties === 'object');
    const props = jsonSchema.properties as Record<string, any>;

    // minLength / maxLength preserved
    assert.strictEqual(props.app_name.type, 'string');
    assert.strictEqual(props.app_name.minLength, 3);
    assert.strictEqual(props.app_name.maxLength, 32);

    // int / min / max preserved
    assert.strictEqual(props.replicas.type, 'integer');
    assert.strictEqual(props.replicas.minimum, 1);
    assert.strictEqual(props.replicas.maximum, 10);

    // enum preserved
    assert.deepStrictEqual(props.plan.enum, ['standard', 'pro', 'enterprise']);

    // boolean preserved
    assert.strictEqual(props.auto_scale.type, 'boolean');

    // formatToolsForOpenAi produces strict tool definition
    const tools = formatToolsForOpenAi([
      {
        name: 'deploy_app',
        description: 'Deploy an app configuration',
        parameters: deploymentSchema,
      },
    ]);

    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].type, 'function');
    assert.strictEqual(tools[0].function.name, 'deploy_app');
    assert.strictEqual(tools[0].function.strict, true);
  });

  it('enforces typed validation after tool generation', () => {
    const scaleSchema = z.object({
      replicas: z.number().int().min(1).max(5),
    });

    const toolDef = {
      name: 'scale_app',
      description: 'Scale application instances',
      parameters: scaleSchema,
    };

    // 1. Valid tool call
    const validCall = validateAndParseToolCall(
      {
        id: 'call_1',
        function: {
          name: 'scale_app',
          arguments: '{"replicas": 3}',
        },
      },
      toolDef
    );

    assert.strictEqual(validCall.name, 'scale_app');
    assert.deepStrictEqual(validCall.arguments, { replicas: 3 });

    // 2. Out-of-bounds replicas (schema failure)
    assert.throws(
      () => {
        validateAndParseToolCall(
          {
            id: 'call_2',
            function: {
              name: 'scale_app',
              arguments: '{"replicas": 10}', // max is 5
            },
          },
          toolDef
        );
      },
      (err: any) => {
        assert(err instanceof MalformedToolCallError);
        assert.strictEqual(err.toolName, 'scale_app');
        return true;
      }
    );
  });
});

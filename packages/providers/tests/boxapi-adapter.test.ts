import { describe, it } from 'vitest';
import assert from 'node:assert';
import { BoxApiClient } from '../src/boxapi/client.ts';
import {
  AuthDeniedDisableError,
  BoxApiError,
  BoxApiRedirectError,
} from '../src/boxapi/errors.ts';
import { calculateUsage } from '../src/boxapi/usage.ts';
import { GPT_5_4_MINI_MODEL } from '../src/boxapi/types.ts';

describe('BoxAPI Adapter Model & Fallback Policy', () => {
  it('uses qwen/qwen3.7-flash as default model and sends max_tokens', async () => {
    let capturedPayload: any;

    const mockFetch: typeof fetch = async (_input, init) => {
      capturedPayload = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          model: 'qwen/qwen3.7-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'test' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new BoxApiClient({
      apiKey: 'test-box-api-key',
      keyMode: 'byok',
      workspaceId: 'ws-default-model',
      ownerId: 'owner-default-model',
      fetchFn: mockFetch,
    });

    assert.strictEqual(client.model, 'qwen/qwen3.7-flash');

    const response = await client.chat({
      runId: 'run-default-model',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    assert.strictEqual(capturedPayload.model, 'qwen/qwen3.7-flash');
    assert.strictEqual(capturedPayload.max_tokens, 1200);
    assert.strictEqual(capturedPayload.max_completion_tokens, undefined);
    // Verify no unsupported default temperature is sent
    assert.strictEqual(capturedPayload.temperature, undefined);
    assert.strictEqual(response.model, 'qwen/qwen3.7-flash');
  });

  it('formats max_completion_tokens for openai/gpt-5.4-mini and omits temperature', async () => {
    let capturedPayload: any;

    const mockFetch: typeof fetch = async (_input, init) => {
      capturedPayload = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          model: GPT_5_4_MINI_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'mini response' } }],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-mini',
      ownerId: 'owner-mini',
      configuredModel: GPT_5_4_MINI_MODEL,
      fetchFn: mockFetch,
    });

    assert.strictEqual(client.model, 'openai/gpt-5.4-mini');

    await client.chat({
      runId: 'run-mini',
      messages: [{ role: 'user', content: 'Ping' }],
      // maxTokens not passed: should default to miniMaxCompletionTokens (256)
    });

    assert.strictEqual(capturedPayload.model, 'openai/gpt-5.4-mini');
    assert.strictEqual(capturedPayload.max_completion_tokens, 256);
    assert.strictEqual(capturedPayload.max_tokens, undefined);
    assert.strictEqual(capturedPayload.temperature, undefined);
  });

  it('strictly enforces no runtime fallback when primary model request fails', async () => {
    let fetchCallCount = 0;
    const requestedModels: string[] = [];

    const mockFetch: typeof fetch = async (_input, init) => {
      fetchCallCount++;
      const body = JSON.parse(init?.body as string);
      requestedModels.push(body.model);

      return new Response(JSON.stringify({ error: 'Model overloaded or unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-no-fallback',
      ownerId: 'owner-no-fallback',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-no-fallback',
          messages: [{ role: 'user', content: 'Ping' }],
        });
      },
      (err: any) => {
        assert(err instanceof BoxApiError);
        assert.strictEqual(err.statusCode, 503);
        assert.strictEqual(err.safeMessage.includes('No fallback attempted'), true);
        return true;
      }
    );

    assert.strictEqual(fetchCallCount, 1);
    assert.deepStrictEqual(requestedModels, ['qwen/qwen3.7-flash']);
  });

  it('disables live AI on 401/403 auth denial with explicit prerequisite instructions', async () => {
    let fetchCount = 0;

    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify({ error: 'Invalid API Key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'invalid-key',
      keyMode: 'byok',
      workspaceId: 'ws-auth-denial',
      ownerId: 'owner-auth-denial',
      fetchFn: mockFetch,
    });

    assert.strictEqual(client.isLiveAiDisabled(), false);

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-auth-denial',
          messages: [{ role: 'user', content: 'Hello' }],
        });
      },
      (err: any) => {
        assert(err instanceof AuthDeniedDisableError);
        assert.strictEqual(err.code, 'AUTH_DENIED_LIVE_AI_DISABLED');
        assert.strictEqual(err.statusCode, 401);
        assert.strictEqual(err.safeMessage.includes('Live AI is disabled'), true);
        assert.strictEqual(err.safeMessage.includes('Automatic fallback is disabled'), true);
        return true;
      }
    );

    assert.strictEqual(client.isLiveAiDisabled(), true);

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-subsequent',
          messages: [{ role: 'user', content: 'Retry' }],
        });
      },
      (err: any) => {
        assert(err instanceof AuthDeniedDisableError);
        return true;
      }
    );

    assert.strictEqual(fetchCount, 1);
  });

  it('rejects unexpected redirects on BoxAPI with BoxApiRedirectError', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(null, {
        status: 301,
        headers: { Location: 'https://attacker.com/steal-token' },
      });
    };

    const client = new BoxApiClient({
      apiKey: 'test-key',
      keyMode: 'byok',
      workspaceId: 'ws-redirect',
      ownerId: 'owner-redirect',
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-redirect',
          messages: [{ role: 'user', content: 'Test' }],
        });
      },
      (err: any) => {
        assert(err instanceof BoxApiRedirectError);
        assert.strictEqual(err.code, 'BOXAPI_REDIRECT_BLOCKED');
        return true;
      }
    );
  });

  it('calculates observed catalog rates for gpt-5.4-mini and leaves unknown models undefined', () => {
    // 1. gpt-5.4-mini: $0.8625 input, $5.175 output, $0.0863 cached per million
    const miniUsage = calculateUsage(
      {
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        total_tokens: 2_000_000,
        prompt_tokens_details: { cached_tokens: 500_000 },
        cost: 3.5,
        cost_unit: 'USD',
      },
      'openai/gpt-5.4-mini'
    );

    assert.strictEqual(miniUsage.promptTokens, 1_000_000);
    assert.strictEqual(miniUsage.completionTokens, 1_000_000);
    assert.strictEqual(miniUsage.cachedPromptTokens, 500_000);
    assert.strictEqual(miniUsage.providerReportedCost, 3.5);
    assert.strictEqual(miniUsage.providerCostUnit, 'USD');

    // Expected catalog calculation:
    // 500k non-cached input: (500k / 1M) * 0.8625 = 0.43125
    // 500k cached input: (500k / 1M) * 0.0863 = 0.04315
    // 1M output: (1M / 1M) * 5.175 = 5.175
    // Total = 0.43125 + 0.04315 + 5.175 = 5.6494
    assert.strictEqual(miniUsage.catalogEstimatedCostUsd, 5.6494);

    // 2. Unknown model: NEVER guess or assume Qwen rates!
    const unknownUsage = calculateUsage(
      {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      },
      'unregistered/custom-experimental-model'
    );

    assert.strictEqual(unknownUsage.totalTokens, 1500);
    assert.strictEqual(unknownUsage.catalogEstimatedCostUsd, undefined);
  });
});

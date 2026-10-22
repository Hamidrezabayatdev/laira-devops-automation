import { describe, it } from 'vitest';
import assert from 'node:assert';
import { BoxApiClient } from '../src/boxapi/client.ts';
import {
  RunBudgetExceededError,
  WorkspaceConcurrencyLimitExceededError,
  AiStoppedError,
  DemoOperatorKeyDeniedError,
  RateLimitExceededError,
} from '../src/boxapi/errors.ts';
import {
  RunBudgetController,
  WorkspaceConcurrencyController,
  AiStopController,
} from '../src/boxapi/budget.ts';

describe('BoxAPI Budget, Concurrency, and Identity Gating', () => {
  it('counts 429 rate limit attempts against run allowance and exhausts 4/run budget', async () => {
    let callCount = 0;

    const mockFetch: typeof fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: 'Rate limit' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
      });
    };

    const budgetController = new RunBudgetController(4);
    const client = new BoxApiClient(
      {
        apiKey: 'test-key',
        keyMode: 'byok',
        workspaceId: 'ws-429-budget',
        ownerId: 'owner-429',
        fetchFn: mockFetch,
      },
      { budgetController }
    );

    const runId = 'run-429-test';

    // Dispatches 1 through 4 fail with RateLimitExceededError, but count against budget
    for (let i = 1; i <= 4; i++) {
      await assert.rejects(
        async () => {
          await client.chat({
            runId,
            messages: [{ role: 'user', content: `Attempt ${i}` }],
          });
        },
        (err: any) => {
          assert(err instanceof RateLimitExceededError);
          assert.strictEqual(err.statusCode, 429);
          return true;
        }
      );
      assert.strictEqual(budgetController.getRunCallCount(runId), i);
    }

    assert.strictEqual(callCount, 4);

    // 5th attempt must be rejected immediately by RunBudgetExceededError before network
    await assert.rejects(
      async () => {
        await client.chat({
          runId,
          messages: [{ role: 'user', content: 'Attempt 5' }],
        });
      },
      (err: any) => {
        assert(err instanceof RunBudgetExceededError);
        assert.strictEqual(err.code, 'RUN_BUDGET_EXCEEDED');
        return true;
      }
    );

    // No 5th fetch should have happened
    assert.strictEqual(callCount, 4);
  });

  it('enforces concurrency limit of 1 active call per workspace', async () => {
    let resolveFirstFetch: () => void = () => {};
    const firstFetchPromise = new Promise<void>((resolve) => {
      resolveFirstFetch = resolve;
    });

    const mockFetch: typeof fetch = async () => {
      await firstFetchPromise;
      return new Response(
        JSON.stringify({
          model: 'qwen/qwen3.7-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const concurrencyController = new WorkspaceConcurrencyController();
    const client = new BoxApiClient(
      {
        apiKey: 'test-key',
        keyMode: 'byok',
        workspaceId: 'ws-single-concurrent',
        ownerId: 'owner-concurrent',
        fetchFn: mockFetch,
      },
      { concurrencyController }
    );

    // Start first call in flight (hangs until resolveFirstFetch)
    const call1Promise = client.chat({
      runId: 'run-concurrent-1',
      messages: [{ role: 'user', content: 'First' }],
    });

    // Attempt second call concurrently for the same workspace
    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-concurrent-2',
          messages: [{ role: 'user', content: 'Second' }],
        });
      },
      (err: any) => {
        assert(err instanceof WorkspaceConcurrencyLimitExceededError);
        assert.strictEqual(err.code, 'WORKSPACE_CONCURRENCY_LIMIT_EXCEEDED');
        return true;
      }
    );

    // Release first call
    resolveFirstFetch();
    const result1 = await call1Promise;
    assert.strictEqual(result1.content, 'done');

    // Concurrency lock is released, subsequent call can now proceed
    const call3Result = await client.chat({
      runId: 'run-concurrent-3',
      messages: [{ role: 'user', content: 'Third' }],
    });
    assert.strictEqual(call3Result.content, 'done');
  });

  it('blocks dispatch when workspace AI is stopped via AI stop controller', async () => {
    const aiStopController = new AiStopController();
    const workspaceId = 'ws-stopped-ai';

    const client = new BoxApiClient(
      {
        apiKey: 'test-key',
        keyMode: 'byok',
        workspaceId,
        ownerId: 'owner-stopped',
      },
      { aiStopController }
    );

    // Stop AI for workspace
    aiStopController.setStopped(workspaceId, true);
    assert.strictEqual(aiStopController.isStopped(workspaceId), true);

    await assert.rejects(
      async () => {
        await client.chat({
          runId: 'run-stopped',
          messages: [{ role: 'user', content: 'Test' }],
        });
      },
      (err: any) => {
        assert(err instanceof AiStoppedError);
        assert.strictEqual(err.code, 'AI_STOPPED');
        return true;
      }
    );

    // Resume AI
    aiStopController.setStopped(workspaceId, false);
    assert.strictEqual(aiStopController.isStopped(workspaceId), false);
  });

  it('verifies owner identity gate for demo operator key vs BYOK', async () => {
    const DEMO_OWNER = 'github|authorized-demo-owner';
    const UNAUTHORIZED_OWNER = 'github|other-user';

    // 1. Authorized demo owner using demo_operator mode: allowed
    const validDemoClient = new BoxApiClient({
      apiKey: 'operator-secret-key',
      keyMode: 'demo_operator',
      workspaceId: 'ws-demo',
      ownerId: DEMO_OWNER,
      demoOwnerId: DEMO_OWNER,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: 'demo OK' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    const demoRes = await validDemoClient.chat({
      runId: 'run-demo-valid',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.strictEqual(demoRes.content, 'demo OK');

    // 2. Unauthorized owner attempting to use demo_operator key: blocked
    const invalidDemoClient = new BoxApiClient({
      apiKey: 'operator-secret-key',
      keyMode: 'demo_operator',
      workspaceId: 'ws-demo-attack',
      ownerId: UNAUTHORIZED_OWNER,
      demoOwnerId: DEMO_OWNER,
    });

    await assert.rejects(
      async () => {
        await invalidDemoClient.chat({
          runId: 'run-demo-invalid',
          messages: [{ role: 'user', content: 'Hi' }],
        });
      },
      (err: any) => {
        assert(err instanceof DemoOperatorKeyDeniedError);
        assert.strictEqual(err.code, 'DEMO_OPERATOR_KEY_DENIED');
        return true;
      }
    );
  });
});

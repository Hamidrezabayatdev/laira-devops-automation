import { describe, it, expect, vi } from 'vitest';
import assert from 'node:assert';
import { z } from 'zod';
import * as deepagentsModule from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { BoxApiClient, TOKEN_BOUNDS } from '@laira/providers/boxapi';
import {
  BoxApiChatModel,
  runDevOpsAgent,
  createLiaraAgent,
  createReadSourceTool,
  DEFAULT_DEVOPS_SYSTEM_PROMPT,
  type AgentTool,
  type AgentProgress,
} from '../src/index.js';
import * as distAgent from '../dist/index.js';

function createMockBoxApiClient(responses: Array<{
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  prompt_tokens?: number;
  completion_tokens?: number;
}>) {
  let callIndex = 0;
  const recordedRequests: any[] = [];

  const mockFetch: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(init?.body as string);
    recordedRequests.push(payload);

    const resp = responses[callIndex] || { content: 'Default response' };
    callIndex++;

    const pTokens = resp.prompt_tokens ?? 100;
    const cTokens = resp.completion_tokens ?? 50;

    return new Response(
      JSON.stringify({
        model: 'qwen/qwen3.7-flash',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: resp.content ?? null,
              tool_calls: resp.tool_calls,
            },
            finish_reason: resp.tool_calls ? 'tool_calls' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: pTokens,
          completion_tokens: cTokens,
          total_tokens: pTokens + cTokens,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const client = new BoxApiClient({
    apiKey: 'test-box-api-key',
    keyMode: 'byok',
    workspaceId: 'ws-agent-test',
    ownerId: 'owner-agent-test',
    fetchFn: mockFetch,
  });

  return { client, recordedRequests, getCallCount: () => callIndex };
}

vi.mock('deepagents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('deepagents')>();
  return {
    ...actual,
    createDeepAgent: vi.fn(actual.createDeepAgent),
  };
});

describe('BoxApiChatModel Bridge', () => {
  it('implements LangChain BaseChatModel contract and maps messages & usage', async () => {
    const { client, recordedRequests } = createMockBoxApiClient([
      {
        content: 'I have analyzed the container logs.',
        prompt_tokens: 150,
        completion_tokens: 35,
      },
    ]);

    const model = new BoxApiChatModel({
      client,
      runId: 'run-model-bridge-1',
    });

    assert.strictEqual(model._llmType(), 'boxapi');
    assert.strictEqual(model.modelName, 'qwen/qwen3.7-flash');

    const result = await model.invoke([
      new SystemMessage('You are a DevOps assistant'),
      new HumanMessage('Check the logs for errors'),
    ]);

    assert.strictEqual(result.content, 'I have analyzed the container logs.');
    assert.deepStrictEqual(result.usage_metadata, {
      input_tokens: 150,
      output_tokens: 35,
      total_tokens: 185,
    });

    assert.strictEqual(recordedRequests.length, 1);
    assert.strictEqual(recordedRequests[0].messages.length, 2);
    assert.strictEqual(recordedRequests[0].max_tokens, TOKEN_BOUNDS.defaultOutputTokens);
  });

  it('passes AbortSignal to BoxApiClient for in-flight cancellation', async () => {
    let capturedSignal: AbortSignal | undefined;
    const client = {
      model: 'qwen/qwen3.7-flash',
      chat: async (opts: any) => {
        capturedSignal = opts.signal;
        opts.signal?.throwIfAborted();
        return {
          model: 'qwen/qwen3.7-flash',
          content: 'ok',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    } as any;

    const model = new BoxApiChatModel({ client, runId: 'run-signal-test' });
    const controller = new AbortController();

    await model._generate([new HumanMessage('Hello')], {
      signal: controller.signal,
    } as any);

    assert.strictEqual(capturedSignal, controller.signal);
  });

  it('enforces 4-call hard budget cap across bindTools clones', async () => {
    const { client } = createMockBoxApiClient([
      { content: '1' },
      { content: '2' },
      { content: '3' },
      { content: '4' },
      { content: '5' },
    ]);

    const rootModel = new BoxApiChatModel({ client, runId: 'run-clone-budget' });
    const bound1 = rootModel.bindTools([]);
    const bound2 = bound1.bindTools([]);

    // 4 calls succeed
    await rootModel._generate([new HumanMessage('c1')], {} as any);
    await bound1._generate([new HumanMessage('c2')], {} as any);
    await bound2._generate([new HumanMessage('c3')], {} as any);
    await rootModel._generate([new HumanMessage('c4')], {} as any);

    // 5th call across clones must throw
    await expect(
      bound2._generate([new HumanMessage('c5')], {} as any)
    ).rejects.toThrow(/budget exceeded/i);
  });

  it('counts failed chat calls against 4-call budget limit before dispatch', async () => {
    let callAttempts = 0;
    const failingClient = {
      model: 'qwen/qwen3.7-flash',
      chat: async () => {
        callAttempts++;
        throw new Error('500 Internal Server Error from Provider');
      },
    } as any;

    const model = new BoxApiChatModel({ client: failingClient, runId: 'run-fail-budget' });

    // 4 failed calls are made
    for (let i = 0; i < 4; i++) {
      await expect(
        model._generate([new HumanMessage(`attempt ${i}`)], {} as any)
      ).rejects.toThrow(/500 Internal Server Error/);
    }
    assert.strictEqual(callAttempts, 4);
    assert.strictEqual(model.callTracker.count, 4);

    // 5th call is rejected by budget cap without even reaching client.chat
    await expect(
      model._generate([new HumanMessage('attempt 5')], {} as any)
    ).rejects.toThrow(/budget exceeded/i);
    assert.strictEqual(callAttempts, 4);
  });

  it('increments call counter before await protecting against concurrent race conditions', async () => {
    let inFlightDispatches = 0;
    let maxConcurrent = 0;
    const slowClient = {
      model: 'qwen/qwen3.7-flash',
      chat: async () => {
        inFlightDispatches++;
        maxConcurrent = Math.max(maxConcurrent, inFlightDispatches);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlightDispatches--;
        return {
          model: 'qwen/qwen3.7-flash',
          content: 'done',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        };
      },
    } as any;

    const model = new BoxApiChatModel({ client: slowClient, runId: 'run-concurrent-race' });

    // Dispatch 4 calls concurrently
    const promises = [
      model._generate([new HumanMessage('p1')], {} as any),
      model._generate([new HumanMessage('p2')], {} as any),
      model._generate([new HumanMessage('p3')], {} as any),
      model._generate([new HumanMessage('p4')], {} as any),
    ];

    await Promise.all(promises);
    assert.strictEqual(model.callTracker.count, 4);
    assert(maxConcurrent > 1, 'Should have executed concurrently');

    // 5th call is blocked immediately
    await expect(
      model._generate([new HumanMessage('p5')], {} as any)
    ).rejects.toThrow(/budget exceeded/i);
  });

  it('rejects oversized input payload exceeding conservative 12k token / 40k byte target before client.chat', async () => {
    const { client, recordedRequests } = createMockBoxApiClient([]);
    const model = new BoxApiChatModel({ client, runId: 'run-oversized-input' });

    // Create a message that exceeds the 40,000 byte / 12,000 estimated token limit
    const hugeContent = 'X'.repeat(45_000);
    const hugeMessage = new HumanMessage(hugeContent);

    await expect(
      model._generate([hugeMessage], {} as any)
    ).rejects.toThrow(/Input payload exceeds conservative 12k token target/i);

    // Verify it was rejected before client.chat / network fetch
    assert.strictEqual(recordedRequests.length, 0);
  });
});

describe('DeepAgents Harness Integration', () => {
  it('actually calls createDeepAgent with StateBackend and converted tools', async () => {
    const spy = vi.mocked(deepagentsModule.createDeepAgent);
    spy.mockClear();

    const { client } = createMockBoxApiClient([{ content: 'Agent ready' }]);

    const testTool: AgentTool = {
      name: 'ping_service',
      description: 'Ping service',
      schema: z.object({}),
      execute: async () => ({ status: 'pong' }),
    };

    createLiaraAgent({
      model: client,
      runId: 'run-spy-test',
      tools: [testTool],
    });

    expect(spy).toHaveBeenCalled();
    const callArgs = spy.mock.calls[0]?.[0];
    assert(callArgs !== undefined);
    assert(callArgs.model instanceof BoxApiChatModel);
    assert(typeof callArgs.backend === 'function');
    assert.strictEqual(callArgs.tools?.length, 1);
  });

  it('executes actual tool loop through DeepAgents with StateBackend and worker proposal tool', async () => {
    const { client } = createMockBoxApiClient([
      {
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: {
              name: 'read_source',
              arguments: JSON.stringify({ path: 'liara.json' }),
            },
          },
        ],
        prompt_tokens: 120,
        completion_tokens: 30,
      },
      {
        content: null,
        tool_calls: [
          {
            id: 'call_restart_2',
            type: 'function',
            function: {
              name: 'propose_restart',
              arguments: JSON.stringify({
                appId: 'demo-flask',
                reason: 'Configuration updated in liara.json',
              }),
            },
          },
        ],
        prompt_tokens: 220,
        completion_tokens: 40,
      },
      {
        content: 'Inspected liara.json and proposed restart for demo-flask.',
        prompt_tokens: 310,
        completion_tokens: 20,
      },
    ]);

    const readSourceTool = createReadSourceTool(async (path) => {
      if (path === 'liara.json') return '{"app": "demo-flask", "port": 80}';
      return null;
    });

    const proposeRestartTool: AgentTool = {
      name: 'propose_restart',
      description: 'Propose restart action for an app',
      schema: z.object({ appId: z.string(), reason: z.string() }),
      execute: async ({ appId, reason }) => ({
        status: 'PROPOSED',
        proposedAction: {
          type: 'restart_app',
          title: `Restart ${appId}`,
          payload: { appId },
          reasoning: reason,
          riskLevel: 'low' as const,
        },
      }),
    };

    const progressEvents: AgentProgress[] = [];

    const result = await runDevOpsAgent({
      task: 'Check liara.json and plan restart if necessary',
      runId: 'run-deepagents-actual',
      model: client,
      tools: [readSourceTool, proposeRestartTool],
      onEvent: (event) => {
        progressEvents.push(event);
      },
    });

    assert.strictEqual(
      result.message,
      'Inspected liara.json and proposed restart for demo-flask.'
    );

    assert(result.proposedAction !== undefined);
    assert.strictEqual(result.proposedAction.type, 'restart_app');
    assert.strictEqual(result.proposedAction.title, 'Restart demo-flask');
    assert.strictEqual(result.proposedAction.riskLevel, 'low');
    assert.deepStrictEqual(result.proposedAction.payload, { appId: 'demo-flask' });

    assert.strictEqual(result.toolTrace.length, 2);
    assert.strictEqual(result.toolTrace[0]?.toolName, 'read_source');
    assert.strictEqual(result.toolTrace[1]?.toolName, 'propose_restart');

    const eventTypes = progressEvents.map((e) => e.type);
    assert(eventTypes.includes('start'));
    assert(eventTypes.includes('thinking'));
    assert(eventTypes.includes('tool_start'));
    assert(eventTypes.includes('tool_end'));
    assert(eventTypes.includes('action_proposed'));
    assert(eventTypes.includes('finish'));

    // Verify progress events omit raw data payloads
    const toolStart = progressEvents.find((e) => e.type === 'tool_start');
    assert.strictEqual(toolStart?.toolCall?.name, 'read_source');
    assert.strictEqual((toolStart?.toolCall as any)?.input, undefined);

    const startEvent = progressEvents.find((e) => e.type === 'start');
    assert.strictEqual(startEvent?.message, 'DevOps Agent execution started');
    const finishEvent = progressEvents.find((e) => e.type === 'finish');
    assert.strictEqual(finishEvent?.message, 'DevOps Agent execution finished');
  });

  it('preserves exact JSON schema properties (appId, port, platform) for worker tools and executes valid tool invocation', async () => {
    let executedArgs: any = null;

    const jsonSchemaDeployTool: AgentTool = {
      name: 'deploy_app',
      description: 'Deploy application to Liara Cloud with exact port and platform',
      schema: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: 'Application unique name' },
          port: { type: 'number', description: 'Target container listening port' },
          platform: { type: 'string', description: 'Runtime platform (e.g. node, python, docker)' },
        },
        required: ['appId', 'port', 'platform'],
      },
      execute: async (args: any) => {
        executedArgs = args;
        return {
          status: 'SUCCESS',
          deployedApp: args.appId,
          targetPort: args.port,
          targetPlatform: args.platform,
        };
      },
    };

    const { client, recordedRequests } = createMockBoxApiClient([
      {
        content: null,
        tool_calls: [
          {
            id: 'call_deploy_json_schema',
            type: 'function',
            function: {
              name: 'deploy_app',
              arguments: JSON.stringify({
                appId: 'payment-gateway',
                port: 3000,
                platform: 'node',
              }),
            },
          },
        ],
      },
      {
        content: 'Deployed payment-gateway successfully on port 3000 using platform node.',
      },
    ]);

    const result = await runDevOpsAgent({
      task: 'Deploy payment-gateway on port 3000 using platform node',
      runId: 'run-json-schema-test',
      model: client,
      tools: [jsonSchemaDeployTool],
    });

    // 1. Check that BoxAPI was called with exact JSON Schema parameters (not collapsed into z.record(z.any()))
    assert.strictEqual(recordedRequests.length, 2);
    const sentTools = recordedRequests[0]?.tools;
    assert(Array.isArray(sentTools));
    const deployToolDef = sentTools.find((t: any) => t.function?.name === 'deploy_app');
    assert(deployToolDef !== undefined, 'deploy_app tool must be passed to model');
    const sentToolParams = deployToolDef.function?.parameters;
    assert(sentToolParams !== undefined, 'Tools parameters should be sent to BoxAPI');
    assert.strictEqual(sentToolParams.type, 'object');
    assert.strictEqual(sentToolParams.properties?.appId?.type, 'string');
    assert.strictEqual(sentToolParams.properties?.port?.type, 'number');
    assert.strictEqual(sentToolParams.properties?.platform?.type, 'string');
    assert.deepStrictEqual(sentToolParams.required, ['appId', 'port', 'platform']);

    // 2. Check that the tool executed with the exact parsed arguments
    assert.deepStrictEqual(executedArgs, {
      appId: 'payment-gateway',
      port: 3000,
      platform: 'node',
    });

    // 3. Check final agent output
    assert.match(result.message, /Deployed payment-gateway successfully/);
  });

  it('propagates progress callback errors immediately without swallowing', async () => {
    const { client } = createMockBoxApiClient([{ content: 'Test' }]);

    const fencingError = new Error('FENCING_TOKEN_REVOKED: workspace lock lost');

    await expect(
      runDevOpsAgent({
        task: 'Test callback error',
        runId: 'run-fencing-err',
        model: client,
        onEvent: () => {
          throw fencingError;
        },
      })
    ).rejects.toThrow('FENCING_TOKEN_REVOKED');
  });

  it('propagates fencing and abort errors thrown inside tools without swallowing', async () => {
    const fencingTool: AgentTool = {
      name: 'critical_op',
      description: 'Critical operation',
      schema: { type: 'object', properties: {} },
      execute: async () => {
        const fencingErr = new Error('FENCING_TOKEN_REVOKED: concurrency lease expired');
        throw fencingErr;
      },
    };

    const { client } = createMockBoxApiClient([
      {
        content: null,
        tool_calls: [
          {
            id: 'call_fence_1',
            type: 'function',
            function: {
              name: 'critical_op',
              arguments: '{}',
            },
          },
        ],
      },
    ]);

    await expect(
      runDevOpsAgent({
        task: 'Execute critical op',
        runId: 'run-fence-tool',
        model: client,
        tools: [fencingTool],
      })
    ).rejects.toThrow(/FENCING_TOKEN_REVOKED/);
  });

  it('masks generic tool execution errors to prevent credential or secret leakage', async () => {
    const sensitiveErrorTool: AgentTool = {
      name: 'failing_tool',
      description: 'Tool that throws an internal secret',
      schema: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('Connection failed to postgresql://postgres:super_secret_password_123@10.0.0.5:5432/prod');
      },
    };

    const { client } = createMockBoxApiClient([
      {
        content: null,
        tool_calls: [
          {
            id: 'call_fail_1',
            type: 'function',
            function: {
              name: 'failing_tool',
              arguments: '{}',
            },
          },
        ],
      },
      {
        content: 'Failing tool was attempted and handled.',
      },
    ]);

    const result = await runDevOpsAgent({
      task: 'Run failing tool',
      runId: 'run-leak-prevention',
      model: client,
      tools: [sensitiveErrorTool],
    });

    // Verify trace error message is generic and did not leak the secret
    assert.strictEqual(result.toolTrace.length, 1);
    assert.strictEqual(result.toolTrace[0]?.error, 'Tool execution failed');
    assert(!result.toolTrace[0]?.error?.includes('super_secret_password_123'));
  });

  it('persists conversation history across turns using real LangGraph MemorySaver', async () => {
    const { client } = createMockBoxApiClient([
      { content: 'Step 1 noted.' },
      { content: 'Step 2 complete.' },
    ]);

    const memorySaver = new MemorySaver();

    const res1 = await runDevOpsAgent({
      task: 'Plan step 1',
      runId: 'run-saver-1',
      threadId: 'thread-real-saver',
      model: client,
      checkpointer: memorySaver,
    });
    assert.strictEqual(res1.message, 'Step 1 noted.');

    const res2 = await runDevOpsAgent({
      task: 'Plan step 2',
      runId: 'run-saver-2',
      threadId: 'thread-real-saver',
      model: client,
      checkpointer: memorySaver,
    });
    assert.strictEqual(res2.message, 'Step 2 complete.');
  });

  it('handles cancellation gracefully via AbortSignal', async () => {
    const { client } = createMockBoxApiClient([]);
    const controller = new AbortController();
    controller.abort();

    const result = await runDevOpsAgent({
      task: 'Pre-aborted task',
      runId: 'run-pre-abort',
      model: client,
      signal: controller.signal,
    });

    assert.strictEqual(result.interrupted, true);
  });

  it('read_source blocks traversal, absolute paths, and sensitive credential files, and bounds content <= 8KiB', async () => {
    let mockContent = 'small valid content';
    const tool = createReadSourceTool(async () => mockContent);

    // Traversal blocked
    const res1 = (await tool.execute({ path: '../etc/passwd' })) as any;
    assert.match(res1.error, /access denied/i);

    // Absolute path blocked (not silently stripped)
    const res2 = (await tool.execute({ path: '/etc/shadow' })) as any;
    assert.match(res2.error, /access denied/i);

    // Sensitive files blocked
    const res3 = (await tool.execute({ path: '.env' })) as any;
    assert.match(res3.error, /access denied/i);

    const res4 = (await tool.execute({ path: '.env.production' })) as any;
    assert.match(res4.error, /access denied/i);

    const res5 = (await tool.execute({ path: 'id_rsa' })) as any;
    assert.match(res5.error, /access denied/i);

    const res6 = (await tool.execute({ path: 'secret.key' })) as any;
    assert.match(res6.error, /access denied/i);

    const res7 = (await tool.execute({ path: 'AGENTS.md' })) as any;
    assert.match(res7.error, /access denied/i);

    // Bounded <= 8KiB
    mockContent = 'A'.repeat(10000);
    const res8 = (await tool.execute({ path: 'package.json' })) as any;
    assert(res8.content !== undefined);
    assert(res8.content.length < 9000);
    assert(res8.content.includes('[Truncated: file inspection bounded to 8KiB]'));
  });

  it('verifies system prompt explicitly instructs data untrusted and no external actions', () => {
    assert.match(DEFAULT_DEVOPS_SYSTEM_PROMPT, /UNTRUSTED/i);
    assert.match(DEFAULT_DEVOPS_SYSTEM_PROMPT, /never claim a deployment.*succeeded/i);
    assert.match(DEFAULT_DEVOPS_SYSTEM_PROMPT, /never perform or propose actions outside/i);
  });

  it('runs successfully from compiled dist consumer boundary', async () => {
    const { client } = createMockBoxApiClient([{ content: 'Compiled dist agent response' }]);

    const result = await distAgent.runDevOpsAgent({
      task: 'Run compiled test',
      runId: 'run-dist-boundary',
      model: client,
    });

    assert.strictEqual(result.message, 'Compiled dist agent response');
  });
});

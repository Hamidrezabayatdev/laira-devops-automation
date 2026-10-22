import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ChatResult, ChatGeneration } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BoxApiClient, TOKEN_BOUNDS, RUN_LIMITS } from '@laira/providers/boxapi';
import type {
  ChatMessage,
  SafeToolDefinition,
  BoxApiChatResponse,
} from '@laira/providers/boxapi';

export const INPUT_BUDGET_LIMITS = {
  maxSerializedBytes: 40_000,
  maxEstimatedTokens: 12_000,
} as const;

/**
 * Conservative token and payload estimator for chat messages and tool definitions.
 * Note: This is an explicit conservative heuristic approximation, not a tokenizer guarantee.
 * - Bound: serialized payload byte bound <= 40,000 UTF-8 bytes.
 * - Approx tokens: Math.ceil(asciiChars / 3) + unicodeCodepointCount <= 12,000.
 */
export function estimatePayloadTokens(
  messages: ChatMessage[],
  tools?: SafeToolDefinition<any>[]
): { estimatedTokens: number; byteLength: number } {
  const serialized = JSON.stringify({ messages, tools: tools ?? [] });
  const byteLength = new TextEncoder().encode(serialized).length;

  let asciiLen = 0;
  let unicodeCount = 0;
  for (const char of serialized) {
    if (char.charCodeAt(0) < 128) {
      asciiLen++;
    } else {
      unicodeCount++;
    }
  }

  const estimatedTokens = Math.ceil(asciiLen / 3) + unicodeCount;
  return { estimatedTokens, byteLength };
}

export interface CallTracker {
  count: number;
  usage: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    catalogEstimatedCostUsd?: number;
  };
}

export interface BoxApiChatModelOptions {
  client: BoxApiClient;
  runId?: string;
  maxTokens?: number;
  temperature?: number;
  boundTools?: Array<SafeToolDefinition<any>>;
  callTracker?: CallTracker;
}

export interface BoxApiCallOptions extends BaseChatModelCallOptions {
  runId?: string;
  tools?: Array<SafeToolDefinition<any> | any>;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Maps LangChain BaseMessage instances to BoxAPI ChatMessage protocol.
 */
export function mapLangChainMessagesToBoxApi(messages: BaseMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    const type = typeof (msg as any)._getType === 'function'
      ? (msg as any)._getType()
      : typeof (msg as any).getType === 'function'
        ? (msg as any).getType()
        : (msg as any).type || 'user';

    const textContent = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((c: any) => (typeof c === 'string' ? c : c?.text || JSON.stringify(c))).join('\n')
        : String(msg.content ?? '');

    if (type === 'system') {
      return { role: 'system', content: textContent };
    }

    if (type === 'human' || type === 'user') {
      return { role: 'user', content: textContent };
    }

    if (type === 'ai' || type === 'assistant') {
      const chatMsg: ChatMessage = {
        role: 'assistant',
        content: textContent || null,
      };

      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        chatMsg.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
          },
        }));
      }

      return chatMsg;
    }

    if (type === 'tool') {
      return {
        role: 'tool',
        tool_call_id: (msg as any).tool_call_id || (msg as any).toolCallId || 'call_0',
        content: textContent,
      };
    }

    return { role: 'user', content: textContent };
  });
}

/**
 * Normalizes any tool object (LangChain DynamicStructuredTool, OpenAI tool, or AgentTool)
 * to a SafeToolDefinition expected by BoxApiClient.
 */
export function normalizeToSafeToolDefinition(tool: any): SafeToolDefinition {
  if (tool.parameters && tool.name && tool.description) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  if (tool.schema && tool.name && tool.description) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    };
  }

  if (tool.type === 'function' && tool.function) {
    return {
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    };
  }

  return {
    name: tool.name || 'unnamed_tool',
    description: tool.description || '',
    parameters: { type: 'object', properties: {} },
  };
}

/**
 * LangChain BaseChatModel implementation backed by BoxApiClient.
 * Enforces:
 * - Fixed origin https://ai.boxapi.ir/ai/v1 (guarded inside BoxApiClient)
 * - 4-call per run budget gate shared across bindTools clones
 * - 12,000 input tokens / 1,200 default output tokens bound
 * - No silent fallback, deliberate model selection only
 * - In-flight cancellation propagation via signal to BoxApiClient
 */
export class BoxApiChatModel extends BaseChatModel<BoxApiCallOptions> {
  readonly client: BoxApiClient;
  readonly defaultRunId?: string;
  readonly defaultMaxTokens: number;
  readonly defaultTemperature?: number;
  readonly boundTools: Array<SafeToolDefinition<any>>;
  readonly callTracker: CallTracker;

  constructor(options: BoxApiChatModelOptions) {
    super({});
    if (!options?.client) {
      throw new Error('BoxApiChatModel requires a valid BoxApiClient instance');
    }
    this.client = options.client;
    this.defaultRunId = options.runId;
    this.defaultMaxTokens = options.maxTokens ?? TOKEN_BOUNDS.defaultOutputTokens;
    this.defaultTemperature = options.temperature;
    this.boundTools = options.boundTools ?? [];
    this.callTracker = options.callTracker ?? {
      count: 0,
      usage: {
        model: options.client.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        catalogEstimatedCostUsd: 0,
      },
    };
  }

  _llmType(): string {
    return 'boxapi';
  }

  get modelName(): string {
    return this.client.model;
  }

  override bindTools(
    tools: any[],
    kwargs?: Partial<BoxApiCallOptions>
  ): any {
    const formattedTools = tools.map((t) => normalizeToSafeToolDefinition(t));
    return new BoxApiChatModel({
      client: this.client,
      runId: kwargs?.runId ?? this.defaultRunId,
      maxTokens: kwargs?.maxTokens ?? this.defaultMaxTokens,
      temperature: kwargs?.temperature ?? this.defaultTemperature,
      boundTools: [...this.boundTools, ...formattedTools],
      callTracker: this.callTracker, // Share call counter across all clones
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const callOpts = options as BoxApiCallOptions;
    const signal = callOpts.signal;

    if (signal?.aborted) {
      const abortErr = new Error('Model execution cancelled by caller signal');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    // Enforce 4-call hard budget cap per run across model wrapper clones
    if (this.callTracker.count >= RUN_LIMITS.maxCallsPerRun) {
      throw new Error(`Run call budget exceeded: maximum of ${RUN_LIMITS.maxCallsPerRun} model calls allowed per run.`);
    }

    const runId = callOpts.runId || this.defaultRunId;
    if (!runId) {
      throw new Error('BoxApiChatModel invocation requires a runId (pass in constructor or call options)');
    }

    const chatMessages = mapLangChainMessagesToBoxApi(messages);

    const callTools: SafeToolDefinition<any>[] = [
      ...this.boundTools,
      ...(callOpts.tools ? callOpts.tools.map((t: any) => normalizeToSafeToolDefinition(t)) : []),
    ];

    const maxTokens = callOpts.maxTokens ?? this.defaultMaxTokens;
    const temperature = callOpts.temperature ?? this.defaultTemperature;

    // Conservative 12,000 input token target & 40,000 serialized byte limit check
    const { estimatedTokens, byteLength } = estimatePayloadTokens(
      chatMessages,
      callTools.length > 0 ? callTools : undefined
    );
    if (
      byteLength > INPUT_BUDGET_LIMITS.maxSerializedBytes ||
      estimatedTokens > INPUT_BUDGET_LIMITS.maxEstimatedTokens
    ) {
      throw new Error(
        `Input payload exceeds conservative 12k token target: estimated ~${estimatedTokens} tokens (${byteLength} bytes, limit: ${INPUT_BUDGET_LIMITS.maxSerializedBytes} bytes / ~${INPUT_BUDGET_LIMITS.maxEstimatedTokens} tokens approximation).`
      );
    }

    // Increment before dispatch to count attempts (including failed/errored calls)
    // and protect against parallel dispatch races across model clones
    this.callTracker.count += 1;

    // Dispatch chat completion to BoxAPI with signal passed for in-flight cancellation
    const response: BoxApiChatResponse = await this.client.chat({
      runId,
      messages: chatMessages,
      tools: callTools.length > 0 ? callTools : undefined,
      maxTokens,
      temperature,
      signal,
    } as any);

    if (response.usage) {
      this.callTracker.usage.promptTokens += response.usage.promptTokens;
      this.callTracker.usage.completionTokens += response.usage.completionTokens;
      this.callTracker.usage.totalTokens += response.usage.totalTokens;
      if (typeof response.usage.catalogEstimatedCostUsd === 'number') {
        this.callTracker.usage.catalogEstimatedCostUsd =
          (this.callTracker.usage.catalogEstimatedCostUsd || 0) + response.usage.catalogEstimatedCostUsd;
      }
    }

    const toolCalls = response.toolCalls?.map((tc) => ({
      name: tc.name,
      args: (typeof tc.arguments === 'object' && tc.arguments !== null ? tc.arguments : {}) as Record<string, any>,
      id: tc.id,
      type: 'tool_call' as const,
    })) || [];

    const usageMetadata = response.usage ? {
      input_tokens: response.usage.promptTokens,
      output_tokens: response.usage.completionTokens,
      total_tokens: response.usage.totalTokens,
    } : undefined;

    const aiMessage = new AIMessage({
      content: response.content ?? '',
      tool_calls: toolCalls,
      usage_metadata: usageMetadata,
    });

    const generation: ChatGeneration = {
      text: response.content ?? '',
      message: aiMessage,
      generationInfo: {
        finish_reason: response.finishReason,
        usage: response.usage,
      },
    };

    return {
      generations: [generation],
      llmOutput: {
        model: response.model,
        usage: response.usage,
      },
    };
  }
}

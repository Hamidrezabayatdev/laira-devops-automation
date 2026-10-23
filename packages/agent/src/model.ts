import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ChatResult, ChatGeneration } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { isLangChainTool, convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
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
 * Safely converts any schema representation (Zod v3, Zod v4, StandardSchema, or custom)
 * to a standard plain JSON Schema object, preventing raw Zod internals from leaking.
 *
 * Enforces fail-closed static validation:
 * - Truly schemaless tools (schema === undefined || schema === null) preserve empty default { type: 'object', properties: {} }
 * - For provided schemas, conversion must produce a valid JSON Schema object without Zod internals (_def, def)
 * - Fails closed with an Error instead of silently weakening or broadening to an empty schema
 */
export function convertSchemaToJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema === undefined || schema === null) {
    return { type: 'object', properties: {} };
  }

  if (typeof schema !== 'object') {
    throw new Error('Unsupported or invalid tool schema: schema must be an object or undefined');
  }

  // 1. If the object provides its own toJsonSchema() method (e.g. TypedValidator)
  if (typeof (schema as any).toJsonSchema === 'function') {
    try {
      const res = (schema as any).toJsonSchema();
      if (res && typeof res === 'object' && !('_def' in res) && !('def' in res)) {
        return res as Record<string, unknown>;
      }
    } catch {
      throw new Error('Unsupported or invalid tool schema: custom conversion failed');
    }
  }

  // 2. LangChain toJsonSchema conversion (Zod v3, Zod v4, StandardSchema)
  try {
    const res = toJsonSchema(schema as any);
    if (res && typeof res === 'object' && !('_def' in res) && !('def' in res)) {
      if (
        'type' in res ||
        'properties' in res ||
        '$ref' in res ||
        'allOf' in res ||
        'anyOf' in res ||
        'oneOf' in res ||
        Object.keys(res).length === 0
      ) {
        return res as Record<string, unknown>;
      }
    }
  } catch {
    // Fall back to inspect plain object
  }

  // 3. If already a valid plain JSON Schema without Zod internals
  if (
    ('type' in (schema as any) ||
      'properties' in (schema as any) ||
      '$ref' in (schema as any) ||
      'allOf' in (schema as any) ||
      'anyOf' in (schema as any) ||
      'oneOf' in (schema as any)) &&
    !('_def' in (schema as any)) &&
    !('def' in (schema as any))
  ) {
    return schema as Record<string, unknown>;
  }

  // 4. Fail closed: never silently broaden or weaken invalid/unsupported provided schemas to empty objects
  throw new Error(
    'Unsupported or invalid tool schema: unable to convert to valid JSON Schema without leaking internal definition'
  );
}

/**
 * Normalizes any tool object (LangChain DynamicStructuredTool, OpenAI tool, or AgentTool)
 * to a SafeToolDefinition expected by BoxApiClient with valid JSON Schema parameters.
 *
 * Guarantees:
 * - Robust conversion for Zod v3 and Zod v4 schemas (including objects, pipes, transforms)
 * - Preserves plain canonical JSON schemas unchanged
 * - Never leaks Zod internals (_def, def) or weakens schemas to empty objects
 * - Fails closed on unsupported / invalid provided schemas
 * - Attaches safe validation callback when original schema provides safeParse
 */
export function normalizeToSafeToolDefinition(tool: any): SafeToolDefinition {
  if (!tool || typeof tool !== 'object') {
    return {
      name: 'unnamed_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
    };
  }

  // 1. LangChain tool (DynamicStructuredTool, StructuredTool, DeepAgents builtin tool, etc.)
  if (isLangChainTool(tool)) {
    try {
      const openAiTool = convertToOpenAITool(tool);
      if (openAiTool && openAiTool.function) {
        const anyTool = tool as any;
        const rawSchema = anyTool.schema ?? anyTool.parameters;
        const validator = anyTool.validator || (
          rawSchema && typeof rawSchema.safeParse === 'function'
            ? (rawArgs: unknown) => {
                const res = rawSchema.safeParse(rawArgs);
                if (res.success) return { success: true, data: res.data };
                const errs = res.error?.issues
                  ? res.error.issues.map((i: any) => `${i.path?.join('.') || 'field'}: ${i.message}`)
                  : ['Validation failed'];
                return { success: false, errors: errs };
              }
            : undefined
        );

        return {
          name: openAiTool.function.name,
          description: openAiTool.function.description || '',
          parameters: convertSchemaToJsonSchema(openAiTool.function.parameters),
          ...(validator ? { validator } : {}),
        };
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Unsupported or invalid tool schema')) {
        throw err;
      }
      // Fall through to manual extraction
    }
  }

  // 2. OpenAI formatted tool definition
  if (tool.type === 'function' && tool.function) {
    const rawSchema = tool.function.parameters;
    const validator = tool.validator || (
      rawSchema && typeof rawSchema.safeParse === 'function'
        ? (rawArgs: unknown) => {
            const res = rawSchema.safeParse(rawArgs);
            if (res.success) return { success: true, data: res.data };
            const errs = res.error?.issues
              ? res.error.issues.map((i: any) => `${i.path?.join('.') || 'field'}: ${i.message}`)
              : ['Validation failed'];
            return { success: false, errors: errs };
          }
        : undefined
    );

    return {
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: convertSchemaToJsonSchema(rawSchema),
      ...(validator ? { validator } : {}),
    };
  }

  // 3. Tool with schema field (e.g. AgentTool or custom tool object)
  if ('schema' in tool && tool.name) {
    const rawSchema = tool.schema;
    const validator = tool.validator || (
      rawSchema && typeof rawSchema.safeParse === 'function'
        ? (rawArgs: unknown) => {
            const res = rawSchema.safeParse(rawArgs);
            if (res.success) return { success: true, data: res.data };
            const errs = res.error?.issues
              ? res.error.issues.map((i: any) => `${i.path?.join('.') || 'field'}: ${i.message}`)
              : ['Validation failed'];
            return { success: false, errors: errs };
          }
        : undefined
    );

    return {
      name: tool.name,
      description: tool.description || '',
      parameters: convertSchemaToJsonSchema(rawSchema),
      ...(validator ? { validator } : {}),
    };
  }

  // 4. Tool with parameters field (e.g. SafeToolDefinition)
  if ('parameters' in tool && tool.name) {
    const rawSchema = tool.parameters;
    const validator = tool.validator || (
      rawSchema && typeof rawSchema.safeParse === 'function'
        ? (rawArgs: unknown) => {
            const res = rawSchema.safeParse(rawArgs);
            if (res.success) return { success: true, data: res.data };
            const errs = res.error?.issues
              ? res.error.issues.map((i: any) => `${i.path?.join('.') || 'field'}: ${i.message}`)
              : ['Validation failed'];
            return { success: false, errors: errs };
          }
        : undefined
    );

    return {
      name: tool.name,
      description: tool.description || '',
      parameters: convertSchemaToJsonSchema(rawSchema),
      ...(validator ? { validator } : {}),
    };
  }

  // 5. Fallback for unnamed / unspecified tools
  return {
    name: tool.name || 'unnamed_tool',
    description: tool.description || '',
    parameters: { type: 'object', properties: {} },
    ...(tool.validator ? { validator: tool.validator } : {}),
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

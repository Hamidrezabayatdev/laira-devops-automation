import type { TypedValidator } from '../schema/validator.js';

export const BOXAPI_ORIGIN = 'https://ai.boxapi.ir/ai/v1';
export const DEFAULT_BOXAPI_MODEL = 'qwen/qwen3.7-flash';
export const GPT_5_4_MINI_MODEL = 'openai/gpt-5.4-mini';

export interface ModelCatalogRate {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
}

/**
 * Observed catalog rates (USD per million tokens).
 * NOTE: Catalog rates are estimates only, not billing guarantees.
 */
export const KNOWN_MODEL_CATALOG_RATES: Record<string, ModelCatalogRate> = {
  'qwen/qwen3.7-flash': {
    inputUsdPerMillion: 0.0345,
    outputUsdPerMillion: 0.1495,
    cachedInputUsdPerMillion: 0.0069,
  },
  'openai/gpt-5.4-mini': {
    inputUsdPerMillion: 0.8625,
    outputUsdPerMillion: 5.175,
    cachedInputUsdPerMillion: 0.0863,
  },
};

export const TOKEN_BOUNDS = {
  maxTargetInputTokens: 12_000,
  defaultOutputTokens: 1_200,
  planningOutputTokens: 1_600,
  smokeCapOutputTokens: 100,
  miniMaxCompletionTokens: 256,
  legacyMaxTokens: 400,
};

export const RUN_LIMITS = {
  maxCallsPerRun: 4,
  maxConcurrentPerWorkspace: 1,
  defaultMaxBytes: 1024 * 1024, // 1 MiB bounded response
};

export type KeyMode = 'byok' | 'demo_operator';

export interface BoxApiConfig {
  apiKey: string;
  keyMode: KeyMode;
  workspaceId: string;
  ownerId: string;
  /**
   * Static deliberate model selection. Defaults to 'qwen/qwen3.7-flash'.
   * Can be configured to 'openai/gpt-5.4-mini'.
   * Policy: Support deliberate config model change only, NOT runtime fallback.
   */
  configuredModel?: string;
  /**
   * Explicitly configured identity of the demo owner.
   * Required if keyMode is 'demo_operator'.
   */
  demoOwnerId?: string;
  timeoutMs?: number; // bounded timeout (default 30_000 ms across full body reading)
  maxBytes?: number; // bounded response byte limit (default 1 MiB)
  maxTokens?: number; // output token cap
  fetchFn?: typeof fetch;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface SafeToolDefinition<T = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown> | TypedValidator<T> | { safeParse(input: unknown): any };
  validator?: (rawArgs: unknown) => { success: boolean; data?: T; errors?: string[] };
}

export interface SafeToolCall<T = unknown> {
  id: string;
  name: string;
  arguments: T;
  rawArguments: string;
}

export interface ProviderUsageRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  totalTokens: number;
  /**
   * Actual provider-reported cost if present in response.
   * Kept strictly distinct from catalog estimates; currency is not assumed.
   */
  providerReportedCost?: number;
  providerCostUnit?: string;
  /**
   * Catalog estimated cost computed in USD based on published rates.
   * Undefined if model catalog rates are unknown (never assumed or guessed).
   */
  catalogEstimatedCostUsd?: number;
}

export interface BoxApiChatResponse {
  model: string;
  content: string | null;
  toolCalls?: SafeToolCall[];
  usage: ProviderUsageRecord;
  finishReason?: string;
}

export interface BoxApiStreamChunk {
  content?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsChunk?: string;
  }>;
  finishReason?: string;
  usage?: ProviderUsageRecord;
}

// Controller Interfaces for shared / injectable implementations
export interface IRunBudgetController {
  checkAndRecordDispatch(runId: string): number;
  getRunCallCount(runId: string): number;
  resetRun(runId: string): void;
}

export interface IWorkspaceConcurrencyController {
  acquire(workspaceId: string): () => void;
  isBusy(workspaceId: string): boolean;
}

export interface IAiStopController {
  setStopped(workspaceId: string, stopped: boolean): void;
  isStopped(workspaceId: string): boolean;
  assertNotStopped(workspaceId: string): void;
}

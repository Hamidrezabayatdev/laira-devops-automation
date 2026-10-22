import type { BoxApiClient } from '@laira/providers/boxapi';

/**
 * Structural parser interface compatible with Zod 3, Zod 4, and TypedValidator.
 */
export interface SchemaParser<T = any> {
  safeParse?(input: unknown): { success: boolean; data?: T; error?: unknown; errors?: string[] };
  parse?(input: unknown): T;
}

/**
 * Tool schema contract accepting either a structural parser (Zod 3/4) or a raw JSON Schema object.
 */
export type AgentToolSchema<T = any> = SchemaParser<T> | Record<string, unknown>;

export interface AgentTool<T = any> {
  name: string;
  description: string;
  schema: AgentToolSchema<T>;
  execute(args: T): Promise<unknown>;
}

export interface ProposedAction {
  type: string;
  title: string;
  payload: Record<string, unknown>;
  reasoning: string;
  riskLevel?: 'low' | 'medium' | 'high';
}

export interface ToolTraceItem {
  toolName: string;
  callId?: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface AgentRunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  catalogEstimatedCostUsd?: number;
  callsCount?: number;
}

export type AgentProgressType =
  | 'start'
  | 'thinking'
  | 'tool_start'
  | 'tool_end'
  | 'tool_error'
  | 'action_proposed'
  | 'finish'
  | 'error';

export interface AgentProgress {
  type: AgentProgressType;
  step?: number;
  message?: string;
  toolCall?: {
    name: string;
    id?: string;
  };
  toolResult?: {
    name: string;
    id?: string;
    error?: string;
  };
  proposedAction?: ProposedAction;
  usage?: AgentRunUsage;
  timestamp: number;
}

export interface RunDevOpsAgentOptions {
  task: string;
  runId: string;
  model: BoxApiClient | any;
  tools?: AgentTool[];
  onEvent?: (event: AgentProgress) => Promise<void> | void;
  checkpointer?: any;
  threadId?: string;
  signal?: AbortSignal;
  maxIterations?: number;
  systemPrompt?: string;
  defaultMaxTokens?: number;
}

export interface RunDevOpsAgentResult {
  message: string;
  proposedAction?: ProposedAction;
  usage: AgentRunUsage;
  toolTrace: ToolTraceItem[];
  interrupted?: boolean;
}

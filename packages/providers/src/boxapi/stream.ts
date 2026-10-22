import type { BoxApiStreamChunk, SafeToolCall, SafeToolDefinition } from './types.js';
import { calculateUsage } from './usage.js';
import { validateAndParseToolCall } from './tools.js';
import { InterruptedStreamError, ResponseSizeExceededError } from './errors.js';

export interface AccumulatedStreamResult {
  content: string;
  toolCalls?: SafeToolCall[];
  finishReason?: string;
  usage?: import('./types.js').ProviderUsageRecord;
}

export interface ParseSseStreamOptions {
  maxBytes?: number;
}

export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: ParseSseStreamOptions = {}
): AsyncGenerator<{ payload: string; isDone: boolean }, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  let receivedDone = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new ResponseSizeExceededError(maxBytes);
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep unfinished line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // Skip empty lines and SSE comments
        if (trimmed.startsWith('data: ')) {
          const payload = trimmed.slice(6).trim();
          if (payload === '[DONE]') {
            receivedDone = true;
            yield { payload, isDone: true };
            return;
          }
          yield { payload, isDone: false };
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        const payload = trimmed.slice(6).trim();
        if (payload === '[DONE]') {
          receivedDone = true;
          yield { payload, isDone: true };
          return;
        } else if (payload) {
          yield { payload, isDone: false };
        }
      }
    }

    if (!receivedDone) {
      // Stream closed before receiving [DONE]
      throw new InterruptedStreamError('SSE stream closed by server without [DONE] signal');
    }
  } finally {
    reader.releaseLock();
  }
}

export class StreamAccumulator {
  private content = '';
  private toolCallMap = new Map<number, { id: string; name: string; argumentsChunks: string[] }>();
  private finishReason?: string;
  private rawUsage?: unknown;
  private sawDone = false;
  readonly model: string;
  readonly tools?: Array<SafeToolDefinition<any>>;

  constructor(model: string, tools?: Array<SafeToolDefinition<any>>) {
    this.model = model;
    this.tools = tools;
  }

  markDone(): void {
    this.sawDone = true;
  }

  processChunk(payloadJson: string | object): BoxApiStreamChunk | null {
    if (typeof payloadJson === 'string') {
      if (payloadJson === '[DONE]') {
        this.sawDone = true;
        return null;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(payloadJson);
      } catch {
        // Safely ignore malformed individual stream chunk without crashing
        return null;
      }
      return this.processParsedChunk(parsed);
    }

    return this.processParsedChunk(payloadJson as any);
  }

  private processParsedChunk(parsed: any): BoxApiStreamChunk | null {
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta;
    const chunkResult: BoxApiStreamChunk = {};

    if (delta?.content) {
      this.content += delta.content;
      chunkResult.content = delta.content;
    }

    if (choice?.finish_reason) {
      this.finishReason = choice.finish_reason;
      chunkResult.finishReason = choice.finish_reason;
    }

    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      chunkResult.toolCalls = [];
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        let existing = this.toolCallMap.get(index);
        if (!existing) {
          existing = {
            id: tc.id || '',
            name: tc.function?.name || '',
            argumentsChunks: [],
          };
          this.toolCallMap.set(index, existing);
        } else {
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
        }

        if (tc.function?.arguments) {
          existing.argumentsChunks.push(tc.function.arguments);
        }

        chunkResult.toolCalls.push({
          index,
          id: tc.id,
          name: tc.function?.name,
          argumentsChunk: tc.function?.arguments,
        });
      }
    }

    if (parsed.usage) {
      this.rawUsage = parsed.usage;
      chunkResult.usage = calculateUsage(parsed.usage, this.model);
    }

    return chunkResult;
  }

  finalize(): AccumulatedStreamResult {
    // Fail on interrupted stream: must have seen [DONE] or a valid terminal finish_reason
    if (!this.sawDone && !this.finishReason) {
      throw new InterruptedStreamError('Stream terminated prematurely before completion [DONE]');
    }

    let validatedToolCalls: SafeToolCall[] | undefined;

    if (this.toolCallMap.size > 0) {
      validatedToolCalls = [];
      const toolDefMap = new Map(this.tools?.map((t) => [t.name, t]) || []);

      for (const [, item] of this.toolCallMap.entries()) {
        const fullArgs = item.argumentsChunks.join('');
        const toolDef = toolDefMap.get(item.name);
        const validated = validateAndParseToolCall(
          {
            id: item.id,
            function: {
              name: item.name,
              arguments: fullArgs,
            },
          },
          toolDef
        );
        validatedToolCalls.push(validated);
      }
    }

    const usage = calculateUsage(this.rawUsage, this.model);

    return {
      content: this.content,
      toolCalls: validatedToolCalls,
      finishReason: this.finishReason || (this.sawDone ? 'stop' : undefined),
      usage,
    };
  }
}

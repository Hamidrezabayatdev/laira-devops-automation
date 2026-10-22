import OpenAI from 'openai';
import {
  BOXAPI_ORIGIN,
  DEFAULT_BOXAPI_MODEL,
  GPT_5_4_MINI_MODEL,
  TOKEN_BOUNDS,
  RUN_LIMITS,
  type BoxApiConfig,
  type ChatMessage,
  type SafeToolDefinition,
  type BoxApiChatResponse,
  type BoxApiStreamChunk,
  type IRunBudgetController,
  type IWorkspaceConcurrencyController,
  type IAiStopController,
} from './types.js';
import {
  BoxApiError,
  AuthDeniedDisableError,
  RateLimitExceededError,
  BoxApiOriginMismatchError,
  BoxApiRedirectError,
  ResponseSizeExceededError,
  MalformedPayloadError,
  InterruptedStreamError,
  MalformedToolCallError,
} from './errors.js';
import {
  RunBudgetController,
  WorkspaceConcurrencyController,
  AiStopController,
  OwnerIdentityGate,
} from './budget.js';
import { formatToolsForOpenAi, validateAndParseToolCall } from './tools.js';
import { calculateUsage } from './usage.js';
import { StreamAccumulator, type AccumulatedStreamResult } from './stream.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ALLOWED_OUTPUT_TOKENS = 8_192;

export interface ChatDispatchOptions {
  runId: string;
  signal?: AbortSignal;
  messages: ChatMessage[];
  tools?: Array<SafeToolDefinition<any>>;
  maxTokens?: number;
  temperature?: number;
}

export interface StreamDispatchOptions extends ChatDispatchOptions {
  onChunk?: (chunk: BoxApiStreamChunk) => void;
}

function clampMaxTokens(
  tokens: number | undefined,
  defaultTokens: number,
  maxCap: number = MAX_ALLOWED_OUTPUT_TOKENS
): number {
  if (tokens === undefined || tokens === null) {
    return defaultTokens;
  }
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || Number.isNaN(tokens)) {
    throw new Error(`Invalid maxTokens option: expected a finite positive number, received ${String(tokens)}`);
  }
  const intVal = Math.floor(tokens);
  if (intVal < 1) {
    throw new Error(`Invalid maxTokens option: must be >= 1, received ${intVal}`);
  }
  return Math.min(intVal, maxCap);
}

export class BoxApiClient {
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchFn: typeof fetch;

  // Private actual official OpenAI SDK instance (cannot be bypassed by callers)
  readonly #openai: OpenAI;

  // Private raw config preserving secret isolation
  readonly #config: BoxApiConfig;

  // Controllers (in-memory single-process by default, or injected shared instances)
  readonly budgetController: IRunBudgetController;
  readonly concurrencyController: IWorkspaceConcurrencyController;
  readonly aiStopController: IAiStopController;

  private _liveAiDisabled = false;

  constructor(
    config: BoxApiConfig,
    controllers?: {
      budgetController?: IRunBudgetController;
      concurrencyController?: IWorkspaceConcurrencyController;
      aiStopController?: IAiStopController;
    }
  ) {
    if (!config.apiKey || typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
      throw new Error('BoxApiConfig requires a valid non-empty apiKey');
    }
    if (!config.workspaceId || typeof config.workspaceId !== 'string') {
      throw new Error('BoxApiConfig requires a valid workspaceId');
    }
    if (!config.ownerId || typeof config.ownerId !== 'string') {
      throw new Error('BoxApiConfig requires a valid ownerId');
    }

    this.#config = {
      ...config,
      apiKey: config.apiKey.trim(),
    };

    // Deliberate configuration model selection. Defaults to 'qwen/qwen3.7-flash'.
    // User can deliberately configure 'openai/gpt-5.4-mini'.
    // Policy: Support deliberate config model change only, NOT runtime fallback.
    this.model = config.configuredModel || DEFAULT_BOXAPI_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = config.maxBytes ?? RUN_LIMITS.defaultMaxBytes;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;

    this.budgetController = controllers?.budgetController ?? new RunBudgetController();
    this.concurrencyController = controllers?.concurrencyController ?? new WorkspaceConcurrencyController();
    this.aiStopController = controllers?.aiStopController ?? new AiStopController();

    // Actual OpenAI constructor with private bounded guarded fetch
    this.#openai = new OpenAI({
      baseURL: BOXAPI_ORIGIN,
      apiKey: this.#config.apiKey,
      maxRetries: 0,
      timeout: this.timeoutMs,
      fetch: this.#guardedFetch.bind(this) as any,
    });
  }

  /**
   * Safe non-leaking config representation.
   * Prevents raw apiKey leakage through property enumeration.
   */
  get config(): Omit<BoxApiConfig, 'apiKey'> & { apiKey: string } {
    return {
      ...this.#config,
      apiKey: '[REDACTED]',
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      model: this.model,
      workspaceId: this.#config.workspaceId,
      ownerId: this.#config.ownerId,
      keyMode: this.#config.keyMode,
      configuredModel: this.#config.configuredModel,
    };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `BoxApiClient { model: '${this.model}', workspaceId: '${this.#config.workspaceId}', ownerId: '${this.#config.ownerId}' }`;
  }

  isLiveAiDisabled(): boolean {
    return this._liveAiDisabled;
  }

  /**
   * Private guarded fetch implementation passed into the OpenAI SDK:
   * 1. Validates destination URL origin (must match https://ai.boxapi.ir)
   * 2. Forces redirect: 'error' to avoid credential forwarding
   * 3. Intercepts non-2xx responses and returns sanitized safe errors
   * 4. Enforces bounded body byte consumption across both JSON and SSE streams
   * 5. Validates SSE data chunks before SDK parser so SDK never console.errors malformed lines
   * 6. Enforces exact protocol data event [DONE] (preventing false DONE on message content)
   * 7. Enforces full-body stalled reads cancellation via abort listener
   */
  async #guardedFetch(input: any, init?: any): Promise<Response> {
    const urlString =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : typeof input === 'object' && input !== null && 'url' in input && typeof input.url === 'string'
            ? input.url
            : String(input);

    const parsedUrl = new URL(urlString);
    if (parsedUrl.origin !== 'https://ai.boxapi.ir') {
      throw new BoxApiOriginMismatchError(urlString);
    }

    // Force redirect: 'error'
    const fetchInit: RequestInit = {
      ...init,
      redirect: 'error',
    };

    let response: Response;
    try {
      response = await this.fetchFn(input, fetchInit);
    } catch (err: unknown) {
      if (
        err instanceof BoxApiOriginMismatchError ||
        err instanceof BoxApiRedirectError ||
        err instanceof ResponseSizeExceededError ||
        err instanceof AuthDeniedDisableError ||
        err instanceof RateLimitExceededError ||
        err instanceof InterruptedStreamError ||
        err instanceof BoxApiError
      ) {
        throw err;
      }

      const rawMsg = err instanceof Error ? err.message : '';

      if (rawMsg.toLowerCase().includes('redirect')) {
        throw new BoxApiRedirectError();
      }

      if (err instanceof Error && err.name === 'AbortError') {
        throw new BoxApiError({
          code: 'REQUEST_TIMEOUT',
          statusCode: 408,
          safeMessage: `BoxAPI request timed out after ${this.timeoutMs}ms`,
          retryable: true,
        });
      }

      // Static safe error: NEVER echo raw unknown error message/code which might contain arbitrary secrets!
      throw new BoxApiError({
        code: 'NETWORK_FAILURE',
        statusCode: 0,
        safeMessage: 'BoxAPI network request failed.',
        retryable: true,
      });
    }

    // Block unexpected HTTP redirect status codes
    if (response.status >= 300 && response.status < 400) {
      throw new BoxApiRedirectError();
    }

    // Handle provider error statuses without exposing credentials or bodies
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this._liveAiDisabled = true;
        throw new AuthDeniedDisableError(response.status);
      }

      if (response.status === 429) {
        const retryAfterHeader = response.headers?.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
        throw new RateLimitExceededError(Number.isNaN(retryAfterSeconds) ? undefined : retryAfterSeconds);
      }

      throw new BoxApiError({
        code: `HTTP_${response.status}`,
        statusCode: response.status,
        safeMessage: `BoxAPI chat completion failed with HTTP status ${response.status}. No fallback attempted.`,
        retryable: response.status >= 500,
      });
    }

    // Wrap response body with bounded stream validator for both JSON and SSE streaming
    if (response.body) {
      const maxBytes = this.maxBytes;
      const isSse = response.headers?.get('content-type')?.includes('text/event-stream') || false;
      const signal = init?.signal as AbortSignal | undefined;

      let bytesRead = 0;
      let lineBuffer = '';
      let sawDone = false;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const transform = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          if (signal) {
            const onAbort = () => {
              try {
                controller.error(
                  new BoxApiError({
                    code: 'REQUEST_TIMEOUT',
                    statusCode: 408,
                    safeMessage: 'BoxAPI request timed out while reading response body',
                    retryable: true,
                  })
                );
              } catch {
                // Ignore if stream already completed
              }
            };

            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener('abort', onAbort, { once: true });
            }
          }
        },
        transform(chunk, controller) {
          bytesRead += chunk.byteLength;
          if (bytesRead > maxBytes) {
            controller.error(new ResponseSizeExceededError(maxBytes));
            return;
          }

          if (isSse) {
            lineBuffer += decoder.decode(chunk, { stream: true });
            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) {
                controller.enqueue(encoder.encode(line + '\n'));
                continue;
              }

              // Exact protocol data event parsing (never substring match content)
              if (trimmed.startsWith('data:')) {
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') {
                  sawDone = true;
                } else if (payload.length > 0) {
                  // Validate JSON before OpenAI SDK parser to avoid console.error leaks
                  try {
                    JSON.parse(payload);
                  } catch {
                    controller.error(new InterruptedStreamError('Malformed or truncated SSE data chunk'));
                    return;
                  }
                }
              }

              controller.enqueue(encoder.encode(line + '\n'));
            }
          } else {
            controller.enqueue(chunk);
          }
        },
        flush(controller) {
          if (isSse) {
            if (lineBuffer.trim()) {
              const trimmed = lineBuffer.trim();
              if (trimmed.startsWith('data:')) {
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') {
                  sawDone = true;
                } else {
                  try {
                    JSON.parse(payload);
                  } catch {
                    controller.error(new InterruptedStreamError('Truncated SSE data chunk'));
                    return;
                  }
                }
              } else {
                controller.error(new InterruptedStreamError('SSE stream terminated mid-line'));
                return;
              }
            }

            if (!sawDone) {
              controller.error(new InterruptedStreamError('SSE stream closed by server without [DONE] signal'));
            }
          }
        },
      });

      return new Response(response.body.pipeThrough(transform), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  }

  /**
   * Builds and validates request payload prior to lock acquisition.
   * Prevents concurrency lock leaks and budget consumption when validation fails.
   */
  private buildPayload(options: ChatDispatchOptions, stream: boolean): Record<string, unknown> {
    const isModernOpenAi = this.model.startsWith('openai/') || this.model === GPT_5_4_MINI_MODEL;
    const defaultTokens = isModernOpenAi
      ? TOKEN_BOUNDS.miniMaxCompletionTokens
      : TOKEN_BOUNDS.defaultOutputTokens;

    const maxTokens = clampMaxTokens(options.maxTokens, defaultTokens);

    const payload: Record<string, unknown> = {
      model: this.model,
      messages: options.messages,
      stream,
    };

    if (isModernOpenAi) {
      payload.max_completion_tokens = maxTokens;
    } else {
      payload.max_tokens = maxTokens;
    }

    if (options.temperature !== undefined) {
      if (typeof options.temperature !== 'number' || !Number.isFinite(options.temperature)) {
        throw new Error('Invalid temperature option: must be a finite number');
      }
      payload.temperature = options.temperature;
    }

    if (options.tools && options.tools.length > 0) {
      payload.tools = formatToolsForOpenAi(options.tools);
    }

    return payload;
  }

  /**
   * Preflight validation:
   * 1. Live AI disabled check
   * 2. Workspace AI stopped check
   * 3. Owner Identity Gate (BYOK vs Demo Operator key)
   * 4. Build & validate payload (fails BEFORE lock acquisition)
   * 5. Workspace Concurrency lock (1 concurrent model call)
   * 6. Run Budget counter (4 calls per run limit) - released on failure
   */
  private async preflight(
    runId: string,
    stream: boolean,
    options: ChatDispatchOptions
  ): Promise<{ payload: Record<string, unknown>; releaseConcurrency: () => void }> {
    if (this._liveAiDisabled) {
      throw new AuthDeniedDisableError(403);
    }

    // 1. AI stopped gate
    this.aiStopController.assertNotStopped(this.#config.workspaceId);

    // 2. Owner identity gate
    OwnerIdentityGate.verifyGate(this.#config);

    // 3. Validate options and format payload BEFORE acquiring locks
    const payload = this.buildPayload(options, stream);

    // 4. Workspace concurrency gate (1 concurrent call)
    const releaseConcurrency = this.concurrencyController.acquire(this.#config.workspaceId);

    try {
      // 5. Run budget gate (every dispatch including retries counts)
      this.budgetController.checkAndRecordDispatch(runId);
    } catch (err) {
      releaseConcurrency();
      throw err;
    }

    return { payload, releaseConcurrency };
  }

  /**
   * Dispatches a non-streaming chat completion to BoxAPI using official OpenAI SDK.
   */
  async chat(options: ChatDispatchOptions): Promise<BoxApiChatResponse> {
    options.signal?.throwIfAborted();
    const { payload, releaseConcurrency } = await this.preflight(options.runId, false, options);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const completion: any = await this.#openai.chat.completions.create(payload as any, {
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });

      // Strict completion shape validation
      if (
        typeof completion !== 'object' ||
        !completion ||
        !('choices' in completion) ||
        !Array.isArray(completion.choices) ||
        completion.choices.length === 0
      ) {
        throw new MalformedPayloadError('Invalid JSON in chat completion body: missing or empty choices array');
      }

      const choice = completion.choices[0];
      if (!choice || typeof choice !== 'object' || !choice.message || typeof choice.message !== 'object') {
        throw new MalformedPayloadError('Invalid JSON in chat completion body: missing message in choice');
      }

      const message = choice.message;

      let toolCalls: import('./types.js').SafeToolCall[] | undefined;
      if (message?.tool_calls && Array.isArray(message.tool_calls)) {
        const toolDefMap = new Map(options.tools?.map((t) => [t.name, t]) || []);
        toolCalls = message.tool_calls.map((tc: any) => {
          const toolDef = toolDefMap.get(tc.function?.name);
          return validateAndParseToolCall(tc, toolDef);
        });
      }

      const usage = calculateUsage(completion.usage, this.model);

      return {
        model: completion.model || this.model,
        content: message?.content ?? null,
        toolCalls,
        usage,
        finishReason: choice?.finish_reason,
      };
    } catch (err: unknown) {
      this.handleSdkCatch(err);
    } finally {
      clearTimeout(timeoutId);
      releaseConcurrency();
    }
  }

  /**
   * Dispatches a streaming chat completion to BoxAPI using official OpenAI SDK.
   */
  async streamChat(options: StreamDispatchOptions): Promise<AccumulatedStreamResult> {
    options.signal?.throwIfAborted();
    const { payload, releaseConcurrency } = await this.preflight(options.runId, true, options);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const stream: any = await this.#openai.chat.completions.create(
        {
          ...(payload as any),
          stream: true,
          stream_options: { include_usage: true },
        },
        {
          signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
        }
      );

      const accumulator = new StreamAccumulator(this.model, options.tools);

      for await (const chunk of stream) {
        const processed = accumulator.processChunk(chunk);
        if (processed && options.onChunk) {
          try {
            options.onChunk(processed);
          } catch {
            // Static safe message: NEVER echo raw onChunk error message which might contain secrets
            throw new BoxApiError({
              code: 'ON_CHUNK_HANDLER_ERROR',
              statusCode: 0,
              safeMessage: 'Error occurred during onChunk callback execution',
              retryable: false,
            });
          }
        }
      }

      accumulator.markDone();
      return accumulator.finalize();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        throw new InterruptedStreamError('Stream interrupted mid-chunk with invalid SSE syntax');
      }
      this.handleSdkCatch(err);
    } finally {
      clearTimeout(timeoutId);
      releaseConcurrency();
    }
  }

  /**
   * Unwraps and sanitizes errors thrown by the SDK or underlying guarded fetch.
   * Completely static safe messages: NEVER echoes raw unknown messages/codes.
   */
  private handleSdkCatch(err: unknown): never {
    const unwrapped =
      err instanceof Error && err.cause instanceof Error ? err.cause : err;

    if (
      unwrapped instanceof BoxApiError ||
      unwrapped instanceof AuthDeniedDisableError ||
      unwrapped instanceof RateLimitExceededError ||
      unwrapped instanceof BoxApiOriginMismatchError ||
      unwrapped instanceof BoxApiRedirectError ||
      unwrapped instanceof ResponseSizeExceededError ||
      unwrapped instanceof InterruptedStreamError ||
      unwrapped instanceof MalformedPayloadError ||
      unwrapped instanceof MalformedToolCallError
    ) {
      throw unwrapped;
    }

    if (
      err instanceof BoxApiError ||
      err instanceof AuthDeniedDisableError ||
      err instanceof RateLimitExceededError ||
      err instanceof BoxApiOriginMismatchError ||
      err instanceof BoxApiRedirectError ||
      err instanceof ResponseSizeExceededError ||
      err instanceof InterruptedStreamError ||
      err instanceof MalformedPayloadError ||
      err instanceof MalformedToolCallError
    ) {
      throw err;
    }

    if (err instanceof SyntaxError) {
      throw new MalformedPayloadError('Malformed JSON payload received from provider');
    }

    if (err instanceof Error && err.name === 'AbortError') {
      throw new BoxApiError({
        code: 'REQUEST_TIMEOUT',
        statusCode: 408,
        safeMessage: `BoxAPI request timed out after ${this.timeoutMs}ms`,
        retryable: true,
      });
    }

    const status = typeof (err as any)?.status === 'number' ? (err as any).status : undefined;
    if (status === 401 || status === 403) {
      this._liveAiDisabled = true;
      throw new AuthDeniedDisableError(status);
    }
    if (status === 429) {
      throw new RateLimitExceededError();
    }

    // Completely static safe messages: NEVER echo raw err.message or raw err.code
    const safeCode = status ? `HTTP_${status}` : 'API_ERROR';
    const safeMessage = status
      ? `BoxAPI chat completion failed with HTTP status ${status}. No fallback attempted.`
      : 'BoxAPI chat completion request failed due to an upstream or network error.';

    throw new BoxApiError({
      code: safeCode,
      statusCode: status || 0,
      safeMessage,
      retryable: Boolean(status && status >= 500),
    });
  }
}

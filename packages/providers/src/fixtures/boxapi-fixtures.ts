/**
 * BoxAPI Provider Fixtures
 * Includes realistic responses for Qwen3.7 Flash tool calling,
 * SSE streaming chunks, malformed tool arguments, and canary secrets.
 */

export const BOXAPI_CANARY_SECRETS = {
  boxApiKey: 'boxapi-sk-CANARY-SECRET-TOKEN-DO-NOT-LEAK-999',
  serverInternalDump: 'INTERNAL_SERVER_DEBUG_CANARY_SECRET_DATA_XYZ',
};

// Request 1: Model decides to call get_app_summary tool
export const BOXAPI_TOOL_CALL_RESPONSE = {
  id: 'chatcmpl-test-001',
  object: 'chat.completion',
  created: 1729600000,
  model: 'qwen/qwen3.7-flash',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_qwen_123456',
            type: 'function',
            function: {
              name: 'get_app_summary',
              arguments: JSON.stringify({ app_slug: 'laira-test-app' }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: {
    prompt_tokens: 35,
    completion_tokens: 18,
    total_tokens: 53,
    prompt_tokens_details: {
      cached_tokens: 10,
    },
    // Realistic provider-reported cost (unit not assumed)
    cost: 0.000005,
    cost_unit: 'USD',
  },
};

// Malformed tool call: invalid JSON in arguments
export const BOXAPI_MALFORMED_JSON_TOOL_CALL = {
  id: 'chatcmpl-test-malformed-001',
  object: 'chat.completion',
  created: 1729600000,
  model: 'qwen/qwen3.7-flash',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bad_json',
            type: 'function',
            function: {
              name: 'get_app_summary',
              arguments: '{"app_slug": "laira-test-app", INVALID_JSON_TRAILING',
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
};

// Malformed tool call: valid JSON but fails schema (wrong property type or missing required)
export const BOXAPI_INVALID_SCHEMA_TOOL_CALL = {
  id: 'chatcmpl-test-invalid-schema',
  object: 'chat.completion',
  created: 1729600000,
  model: 'qwen/qwen3.7-flash',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bad_schema',
            type: 'function',
            function: {
              name: 'get_app_summary',
              arguments: JSON.stringify({ wrong_key: 12345 }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
};

// Request 2: Streamed chunks (SSE) returning final response after tool execution
export const BOXAPI_STREAM_CHUNKS: string[] = [
  'data: {"id":"chatcmpl-stream-001","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-stream-001","choices":[{"index":0,"delta":{"content":"برنامه "},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-stream-001","choices":[{"index":0,"delta":{"content":"laira-test-app "},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-stream-001","choices":[{"index":0,"delta":{"content":"با وضعیت "},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-stream-001","choices":[{"index":0,"delta":{"content":"running در حال اجراست."},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-stream-001","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":45,"completion_tokens":15,"total_tokens":60,"cost":0.000006}}\n\n',
  'data: [DONE]\n\n',
];

export const BOXAPI_RAW_401_BODY = JSON.stringify({
  error: {
    message: `Invalid Bearer token: ${BOXAPI_CANARY_SECRETS.boxApiKey}`,
    type: 'invalid_request_error',
    code: 'invalid_api_key',
    internal_debug: BOXAPI_CANARY_SECRETS.serverInternalDump,
  },
});

export const BOXAPI_RAW_429_BODY = JSON.stringify({
  error: {
    message: 'Rate limit exceeded for qwen/qwen3.7-flash. Please slow down.',
    type: 'rate_limit_exceeded',
    code: 'rate_limit_exceeded',
  },
});

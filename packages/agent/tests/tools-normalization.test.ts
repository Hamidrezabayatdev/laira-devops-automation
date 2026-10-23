import { describe, it, expect } from 'vitest';
import assert from 'node:assert';
import { z } from 'zod';
import { createDeepAgent, StateBackend } from 'deepagents';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { formatToolsForOpenAi, BoxApiClient } from '@laira/providers/boxapi';
import {
  normalizeToSafeToolDefinition,
  convertSchemaToJsonSchema,
  BoxApiChatModel,
  runDevOpsAgent,
  createReadSourceTool,
  type AgentTool,
} from '../src/index.js';

describe('Tools Normalization & JSON Schema Conversion', () => {
  describe('Fixture: real createDeepAgent built-in tools', () => {
    it('normalizes all 8 built-in DeepAgents tools to valid JSON Schema without Zod internals', async () => {
      let capturedBoundTools: any[] = [];

      class CapturingChatModel extends BaseChatModel {
        _llmType() {
          return 'capturing';
        }
        override bindTools(tools: any[]) {
          capturedBoundTools = tools;
          return this;
        }
        async _generate() {
          return {
            generations: [{ message: new AIMessage({ content: 'ok' }), text: 'ok' }],
          };
        }
      }

      const agent = createDeepAgent({
        model: new CapturingChatModel({}),
        backend: (config) => new StateBackend(config),
      });

      // Invoke agent to trigger graph execution and bindTools
      await agent.invoke({ messages: [{ role: 'user', content: 'test fixture' }] });

      expect(capturedBoundTools.length).toBeGreaterThanOrEqual(8);

      const expectedBuiltins = [
        'ls',
        'read_file',
        'write_file',
        'edit_file',
        'delete',
        'glob',
        'grep',
        'task',
      ];

      const capturedToolNames = capturedBoundTools.map((t) => t.name);
      for (const name of expectedBuiltins) {
        expect(capturedToolNames).toContain(name);
      }

      // Normalize all captured tools to SafeToolDefinition
      const normalizedTools = capturedBoundTools.map((t) => normalizeToSafeToolDefinition(t));
      const toolMap = new Map(normalizedTools.map((t) => [t.name, t]));

      // 1. Verify 'ls' tool
      const lsTool = toolMap.get('ls');
      assert(lsTool !== undefined, 'ls tool should be defined');
      expect((lsTool.parameters as any).type).toBe('object');
      expect((lsTool.parameters as any).properties).toBeDefined();
      expect((lsTool.parameters as any).properties.path).toBeDefined();

      // 2. Verify 'read_file' tool (Zod v4 pipe with transform)
      const readFileTool = toolMap.get('read_file');
      assert(readFileTool !== undefined, 'read_file tool should be defined');
      expect((readFileTool.parameters as any).type).toBe('object');
      expect((readFileTool.parameters as any).properties).toBeDefined();
      expect((readFileTool.parameters as any).properties.file_path).toBeDefined();
      expect((readFileTool.parameters as any).properties.offset).toBeDefined();
      expect((readFileTool.parameters as any).properties.limit).toBeDefined();

      // 3. Verify 'write_file' tool (Zod v4 pipe)
      const writeFileTool = toolMap.get('write_file');
      assert(writeFileTool !== undefined, 'write_file tool should be defined');
      expect((writeFileTool.parameters as any).type).toBe('object');
      expect((writeFileTool.parameters as any).properties.file_path).toBeDefined();
      expect((writeFileTool.parameters as any).properties.content).toBeDefined();

      // 4. Verify 'edit_file' tool (Zod v4 pipe)
      const editFileTool = toolMap.get('edit_file');
      assert(editFileTool !== undefined, 'edit_file tool should be defined');
      expect((editFileTool.parameters as any).type).toBe('object');
      expect((editFileTool.parameters as any).properties.file_path).toBeDefined();
      expect((editFileTool.parameters as any).properties.old_string).toBeDefined();
      expect((editFileTool.parameters as any).properties.new_string).toBeDefined();
      expect((editFileTool.parameters as any).properties.replace_all).toBeDefined();

      // 5. Verify 'delete' tool (Zod v4 pipe)
      const deleteTool = toolMap.get('delete');
      assert(deleteTool !== undefined, 'delete tool should be defined');
      expect((deleteTool.parameters as any).type).toBe('object');
      expect((deleteTool.parameters as any).properties.file_path).toBeDefined();

      // 6. Verify 'glob' tool
      const globTool = toolMap.get('glob');
      assert(globTool !== undefined, 'glob tool should be defined');
      expect((globTool.parameters as any).type).toBe('object');
      expect((globTool.parameters as any).properties.pattern).toBeDefined();

      // 7. Verify 'grep' tool
      const grepTool = toolMap.get('grep');
      assert(grepTool !== undefined, 'grep tool should be defined');
      expect((grepTool.parameters as any).type).toBe('object');
      expect((grepTool.parameters as any).properties.pattern).toBeDefined();
      expect((grepTool.parameters as any).properties.output_mode).toBeDefined();

      // 8. Verify 'task' tool
      const taskTool = toolMap.get('task');
      assert(taskTool !== undefined, 'task tool should be defined');
      expect((taskTool.parameters as any).type).toBe('object');
      expect((taskTool.parameters as any).properties.description).toBeDefined();
      expect((taskTool.parameters as any).properties.subagent_type).toBeDefined();

      // Verify NO tool contains Zod internals (_def, def) in parameters or serialized JSON
      for (const tool of normalizedTools) {
        expect('_def' in (tool.parameters as any)).toBe(false);
        expect('def' in (tool.parameters as any)).toBe(false);

        const serialized = JSON.stringify(tool.parameters);
        expect(serialized).not.toContain('_def');
        expect(serialized).not.toContain('"def":');
      }

      // Verify formatToolsForOpenAi produces valid parameters without collapsing to empty schema
      const openAiFormatted = formatToolsForOpenAi(normalizedTools);
      expect(openAiFormatted.length).toBe(normalizedTools.length);

      for (const formatted of openAiFormatted) {
        expect(formatted.type).toBe('function');
        expect(formatted.function.name).toBeDefined();
        expect(formatted.function.parameters).toBeDefined();
        expect(formatted.function.parameters.type).toBe('object');

        const propKeys = Object.keys((formatted.function.parameters as any).properties || {});
        expect(propKeys.length).toBeGreaterThan(0);
        expect((formatted.function as any).strict).not.toBe(true);
      }
    });
  });

  describe('Preservation of Canonical JSON Schemas', () => {
    it('preserves plain canonical JSON schema tools like check_connection intact', () => {
      const canonicalTool = {
        name: 'check_connection',
        description: 'Verify connectivity to target host and port',
        parameters: {
          type: 'object',
          properties: {
            host: { type: 'string', description: 'Target hostname or IP' },
            port: { type: 'number', description: 'Port number' },
          },
          required: ['host', 'port'],
        },
      };

      const normalized = normalizeToSafeToolDefinition(canonicalTool);

      expect(normalized.name).toBe('check_connection');
      expect(normalized.description).toBe('Verify connectivity to target host and port');
      expect(normalized.parameters).toEqual(canonicalTool.parameters);
      expect((normalized.parameters as any).properties.host.type).toBe('string');
      expect((normalized.parameters as any).properties.port.type).toBe('number');
      expect((normalized.parameters as any).required).toEqual(['host', 'port']);

      // Passes safely through formatToolsForOpenAi
      const formatted = formatToolsForOpenAi([normalized]);
      expect(formatted[0].function.parameters).toEqual(canonicalTool.parameters);
    });

    it('preserves tool schema when tool.schema is already a plain JSON Schema', () => {
      const schemaTool = {
        name: 'restart_container',
        description: 'Restart container with app name',
        schema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
          },
          required: ['appId'],
        },
      };

      const normalized = normalizeToSafeToolDefinition(schemaTool);
      expect(normalized.name).toBe('restart_container');
      expect((normalized.parameters as any).type).toBe('object');
      expect((normalized.parameters as any).properties.appId.type).toBe('string');
      expect((normalized.parameters as any).required).toEqual(['appId']);
    });
  });

  describe('Zod Schema Conversions (Zod v3 and Zod v4)', () => {
    it('converts Zod v4 object schemas to valid JSON schema', () => {
      const zodTool = {
        name: 'scale_app',
        description: 'Scale app replica count',
        schema: z.object({
          appId: z.string().describe('Target app name'),
          replicas: z.number().int().min(1).max(10).describe('Desired replica count'),
        }),
      };

      const normalized = normalizeToSafeToolDefinition(zodTool);
      expect(normalized.name).toBe('scale_app');
      expect((normalized.parameters as any).type).toBe('object');
      expect((normalized.parameters as any).properties.appId).toBeDefined();
      expect((normalized.parameters as any).properties.replicas).toBeDefined();
      expect('_def' in (normalized.parameters as any)).toBe(false);

      // Validator preserves runtime check
      expect(normalized.validator).toBeDefined();
      const valid = normalized.validator!({ appId: 'web', replicas: 3 });
      expect(valid.success).toBe(true);

      const invalid = normalized.validator!({ appId: 'web', replicas: 0 });
      expect(invalid.success).toBe(false);
    });

    it('converts Zod v4 transform/pipe schemas into proper input JSON schema', () => {
      const pipeTool = {
        name: 'transform_tool',
        description: 'Tool with pipeline schema',
        schema: z
          .string()
          .transform((s) => s.trim())
          .pipe(z.string().min(1)),
      };

      const normalized = normalizeToSafeToolDefinition(pipeTool);
      expect(normalized.name).toBe('transform_tool');
      expect((normalized.parameters as any).type).toBe('string');
      expect('_def' in (normalized.parameters as any)).toBe(false);
    });

    it('converts LangChain DynamicStructuredTool instances cleanly', () => {
      const dynamicTool = new DynamicStructuredTool({
        name: 'dns_lookup',
        description: 'Perform DNS resolution',
        schema: z.object({
          hostname: z.string().describe('Host name to lookup'),
        }),
        func: async () => '127.0.0.1',
      });

      const normalized = normalizeToSafeToolDefinition(dynamicTool);
      expect(normalized.name).toBe('dns_lookup');
      expect((normalized.parameters as any).type).toBe('object');
      expect((normalized.parameters as any).properties.hostname.type).toBe('string');
      expect('_def' in (normalized.parameters as any)).toBe(false);
    });

    it('does not expose custom schema conversion error details', () => {
      const schema = { toJsonSchema() { throw new Error('fixture-sensitive-detail'); } };
      expect(() => normalizeToSafeToolDefinition({ name: 'custom_failure', description: 'Custom failure', schema }))
        .toThrow('Unsupported or invalid tool schema: custom conversion failed');
      try {
        normalizeToSafeToolDefinition({ name: 'custom_failure', description: 'Custom failure', schema });
      } catch (error) {
        expect(String(error)).not.toContain('fixture-sensitive-detail');
      }
    });

    it('converts custom objects with toJsonSchema method', () => {
      const customValidatorTool = {
        name: 'custom_validator',
        description: 'Tool with custom toJsonSchema method',
        parameters: {
          toJsonSchema: () => ({
            type: 'object',
            properties: {
              metricName: { type: 'string' },
            },
            required: ['metricName'],
          }),
        },
      };

      const normalized = normalizeToSafeToolDefinition(customValidatorTool);
      expect((normalized.parameters as any).properties.metricName.type).toBe('string');
      expect((normalized.parameters as any).required).toEqual(['metricName']);
    });

    it('converts actual Zod v3 schemas to valid JSON schema (permanent fixture)', async () => {
      // Import installed Zod 3 package via exact file URL
      const zod3Url = new URL(
        '../../../node_modules/.pnpm/zod@3.24.2/node_modules/zod/lib/index.mjs',
        import.meta.url
      ).href;
      const { default: zod3 } = await import(zod3Url);

      const z3Schema = zod3.object({
        clusterId: zod3.string().uuid().describe('Target cluster identifier'),
        nodeCount: zod3.number().int().min(1).max(20).describe('Number of nodes'),
        tags: zod3.array(zod3.string()).optional(),
      });

      const z3Tool = {
        name: 'provision_cluster',
        description: 'Provision cluster with Zod 3 schema',
        schema: z3Schema,
      };

      const normalized = normalizeToSafeToolDefinition(z3Tool);
      expect(normalized.name).toBe('provision_cluster');
      expect((normalized.parameters as any).type).toBe('object');
      expect((normalized.parameters as any).properties.clusterId).toBeDefined();
      expect((normalized.parameters as any).properties.nodeCount).toBeDefined();
      expect((normalized.parameters as any).properties.tags).toBeDefined();
      expect('_def' in (normalized.parameters as any)).toBe(false);
      expect('def' in (normalized.parameters as any)).toBe(false);

      // Verify validator
      expect(normalized.validator).toBeDefined();
      const valid = normalized.validator!({
        clusterId: '123e4567-e89b-12d3-a456-426614174000',
        nodeCount: 3,
      });
      expect(valid.success).toBe(true);

      const invalid = normalized.validator!({
        clusterId: 'not-a-uuid',
        nodeCount: 0,
      });
      expect(invalid.success).toBe(false);
    });
  });

  describe('Fail-closed static validation for invalid/unsupported schemas', () => {
    it('preserves empty default { type: "object", properties: {} } for truly schemaless tools', () => {
      const schemalessTool = {
        name: 'ping',
        description: 'Ping without arguments',
      };

      const normalized = normalizeToSafeToolDefinition(schemalessTool);
      expect(normalized.parameters).toEqual({ type: 'object', properties: {} });

      const explicitlyUndefinedSchemaTool = {
        name: 'pong',
        description: 'Pong with undefined schema',
        schema: undefined,
      };
      const normalizedUndefined = normalizeToSafeToolDefinition(explicitlyUndefinedSchemaTool);
      expect(normalizedUndefined.parameters).toEqual({ type: 'object', properties: {} });
    });

    it('fails closed and throws error when an invalid or unsupported schema is provided', () => {
      // 1. Invalid object that cannot be converted to JSON schema
      const invalidObjectTool = {
        name: 'broken_tool',
        description: 'Broken tool',
        schema: { notAValidJsonSchemaOrZod: true, randomMethod: () => {} },
      };
      expect(() => normalizeToSafeToolDefinition(invalidObjectTool)).toThrow(
        /Unsupported or invalid tool schema/
      );

      // 2. Corrupted Zod-like object with _def that cannot be parsed
      const corruptedZodTool = {
        name: 'corrupted_tool',
        description: 'Corrupted tool',
        parameters: { _def: { typeName: 'NonExistentZodType' } },
      };
      expect(() => normalizeToSafeToolDefinition(corruptedZodTool)).toThrow(
        /Unsupported or invalid tool schema/
      );

      // 3. Primitive non-object schema provided
      const invalidPrimitiveTool = {
        name: 'primitive_tool',
        description: 'Primitive tool',
        schema: 'not-an-object',
      };
      expect(() => normalizeToSafeToolDefinition(invalidPrimitiveTool)).toThrow(
        /Unsupported or invalid tool schema/
      );
    });
  });

  describe('End-to-End runDevOpsAgent wire format verification', () => {
    it('sends valid JSON schema for all tools over the wire to BoxAPI (never raw Zod internals or empty schema)', async () => {
      const recordedRequests: any[] = [];

      const mockFetch: typeof fetch = async (_input, init) => {
        const payload = JSON.parse(init?.body as string);
        recordedRequests.push(payload);

        return new Response(
          JSON.stringify({
            model: 'qwen/qwen3.7-flash',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'All tools inspected and task completed successfully.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const client = new BoxApiClient({
        apiKey: 'test-wire-key',
        keyMode: 'byok',
        workspaceId: 'ws-wire-test',
        ownerId: 'owner-wire-test',
        fetchFn: mockFetch,
      });

      const readSourceTool = createReadSourceTool(async () => 'hello');

      const customTool: AgentTool = {
        name: 'check_database_port',
        description: 'Check DB connection on port',
        schema: z.object({
          port: z.number().int().describe('Database port'),
        }),
        execute: async () => ({ status: 'UP' }),
      };

      const result = await runDevOpsAgent({
        task: 'Inspect configuration and report',
        runId: 'run-wire-verification',
        model: client,
        tools: [readSourceTool, customTool],
      });

      expect(result.message).toContain('All tools inspected');
      expect(recordedRequests.length).toBe(1);

      const sentTools = recordedRequests[0].tools;
      expect(Array.isArray(sentTools)).toBe(true);
      expect(sentTools.length).toBeGreaterThanOrEqual(10); // 8 builtins + 2 user tools

      for (const tool of sentTools) {
        expect(tool.type).toBe('function');
        expect(tool.function).toBeDefined();
        expect(tool.function.name).toBeDefined();

        const params = tool.function.parameters;
        expect(params).toBeDefined();
        expect(params.type).toBe('object');

        // Parameter properties must be defined and not empty
        const properties = params.properties;
        expect(properties).toBeDefined();
        expect(Object.keys(properties).length).toBeGreaterThan(0);

        // Crucial requirement: No Zod internals or def objects in serialized request payload
        const serializedParams = JSON.stringify(params);
        expect(serializedParams).not.toContain('_def');
        expect(serializedParams).not.toContain('"def":');

        // Crucial requirement: Not collapsed into empty schema { "$schema": "..." } with strict: true
        expect(tool.function.strict).not.toBe(true);
      }
    });
  });
});

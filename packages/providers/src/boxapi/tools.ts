import type { SafeToolDefinition, SafeToolCall } from './types.ts';
import { MalformedToolCallError } from './errors.ts';
import { zodToJsonSchema, type TypedValidator } from '../schema/validator.ts';
import { zodFunction } from 'openai/helpers/zod';
import { z } from 'zod';

export function formatToolsForOpenAi(
  tools: Array<SafeToolDefinition<any>>
): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean } }> {
  return tools.map((tool) => {
    // If it's a real Zod schema, use official SDK zod helper zodFunction directly!
    if (
      tool.parameters instanceof z.ZodType ||
      ('_def' in tool.parameters && typeof (tool.parameters as any).parse === 'function')
    ) {
      try {
        const sdkTool = zodFunction({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as any,
        });
        return {
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: sdkTool.function.parameters as Record<string, unknown>,
            strict: true,
          },
        };
      } catch {
        // Fall back below for mock/partial schemas
      }
    }

    let parameters: Record<string, unknown>;

    if ('toJsonSchema' in tool.parameters && typeof (tool.parameters as TypedValidator<any>).toJsonSchema === 'function') {
      parameters = (tool.parameters as TypedValidator<any>).toJsonSchema();
    } else if ('_def' in tool.parameters) {
      // Direct Zod schema compatibility
      parameters = zodToJsonSchema(tool.parameters);
    } else {
      parameters = tool.parameters as Record<string, unknown>;
    }

    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
      },
    };
  });
}

export function validateAndParseToolCall<T = unknown>(
  rawCall: { id: string; function: { name: string; arguments: string } },
  toolDef?: SafeToolDefinition<T>
): SafeToolCall<T> {
  const toolName = rawCall.function?.name || 'unknown_tool';
  const rawArguments = rawCall.function?.arguments ?? '{}';

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawArguments);
  } catch (err: unknown) {
    throw new MalformedToolCallError(toolName, [
      `Arguments contain invalid JSON syntax: ${err instanceof Error ? err.message : 'JSON parse failure'}`,
    ]);
  }

  if (!toolDef) {
    // If no tool definition passed, return raw parsed JSON as arguments
    return {
      id: rawCall.id,
      name: toolName,
      arguments: parsedJson as T,
      rawArguments,
    };
  }

  // Validate using tool definition's validator or schema safeParse
  let validationResult: { success: boolean; data?: T; errors?: string[] };

  if (toolDef.validator) {
    validationResult = toolDef.validator(parsedJson);
  } else if ('safeParse' in toolDef.parameters && typeof (toolDef.parameters as any).safeParse === 'function') {
    const parseRes = (toolDef.parameters as any).safeParse(parsedJson);
    if (parseRes.success) {
      validationResult = { success: true, data: parseRes.data };
    } else {
      const errs = parseRes.error?.issues
        ? parseRes.error.issues.map((i: any) => `${i.path?.join('.') || 'field'}: ${i.message}`)
        : parseRes.errors || ['Validation failed'];
      validationResult = { success: false, errors: errs };
    }
  } else {
    validationResult = { success: true, data: parsedJson as T };
  }

  if (!validationResult.success) {
    throw new MalformedToolCallError(toolName, validationResult.errors || ['Schema validation failed']);
  }

  return {
    id: rawCall.id,
    name: toolName,
    arguments: (validationResult.data !== undefined ? validationResult.data : parsedJson) as T,
    rawArguments,
  };
}

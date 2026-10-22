import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { AgentTool, ProposedAction, ToolTraceItem } from './types.js';

export const ReadSourceSchema = z.object({
  path: z.string().describe('Relative path of the source file to inspect (e.g. Dockerfile, package.json, liara.json)'),
});

export type ReadSourceInput = z.infer<typeof ReadSourceSchema>;

const BLOCKED_FILE_PATTERNS = [
  /^\.env/i,
  /\.env(\..+)?$/i,
  /\.git/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /secret/i,
  /credential/i,
  /token/i,
  /password/i,
  /AGENTS\.md/i,
];

/**
 * Creates a bounded read-only source file inspection tool.
 * Preserves safety:
 * - Does not read host filesystem
 * - Confined strictly to provided virtual source getter
 * - Rejects absolute paths, path traversal, and sensitive credential files
 * - Bounds returned source contents to <= 8 KiB (8192 characters)
 */
export function createReadSourceTool(
  fileGetter: (filePath: string) => Promise<string | null> | string | null
): AgentTool<ReadSourceInput> {
  return {
    name: 'read_source',
    description:
      'Inspect project source configuration files (such as Dockerfile, package.json, liara.json, requirements.txt). Returns the file content or an error if not found.',
    schema: ReadSourceSchema,
    async execute(input: ReadSourceInput): Promise<{ path: string; content?: string; error?: string }> {
      const rawPath = input.path?.trim() ?? '';
      if (!rawPath) {
        return { path: rawPath, error: 'Path must not be empty' };
      }

      // Block absolute paths and path traversal explicitly (no silent stripping of leading slash)
      if (rawPath.startsWith('/') || rawPath.includes('..') || rawPath.includes('\\')) {
        return {
          path: rawPath,
          error: 'Access denied: absolute paths or path traversal are not allowed',
        };
      }

      // Check blocked file and credential patterns
      const isBlocked = BLOCKED_FILE_PATTERNS.some((pattern) => pattern.test(rawPath));
      if (isBlocked) {
        return {
          path: rawPath,
          error: 'Access denied: access to sensitive credential or control files is forbidden',
        };
      }

      const content = await fileGetter(rawPath);
      if (content === null || content === undefined) {
        return { path: rawPath, error: `File not found: ${rawPath}` };
      }

      // Enforce 8 KiB upper bound on returned inspection payload
      const MAX_INSPECTION_BYTES = 8192;
      const boundedContent =
        content.length > MAX_INSPECTION_BYTES
          ? content.slice(0, MAX_INSPECTION_BYTES) + '\n[Truncated: file inspection bounded to 8KiB]'
          : content;

      return { path: rawPath, content: boundedContent };
    },
  };
}

/**
 * In-memory virtual scratchpad backend conforming to StateBackend virtual memory only:
 * No host disk access, no sandbox execution.
 */
export class VirtualStateBackend {
  private files: Map<string, string> = new Map();

  constructor(initialFiles?: Record<string, string>) {
    if (initialFiles) {
      for (const [k, v] of Object.entries(initialFiles)) {
        this.files.set(k.replace(/^\/+/, ''), v);
      }
    }
  }

  readFile(path: string): string | null {
    const key = path.replace(/^\/+/, '');
    return this.files.get(key) ?? null;
  }

  writeFile(path: string, content: string): void {
    const key = path.replace(/^\/+/, '');
    this.files.set(key, content);
  }

  listFiles(): string[] {
    return Array.from(this.files.keys());
  }

  hasFile(path: string): boolean {
    const key = path.replace(/^\/+/, '');
    return this.files.has(key);
  }
}

/**
 * Converts an AgentTool into a LangChain DynamicStructuredTool.
 * Preserves exact JSON schema and Zod schema parameters without discarding properties.
 * Captures execution timing, trace recording, and safe error reporting.
 */
export function convertAgentToolToLangChainTool(
  agentTool: AgentTool,
  options?: {
    onActionProposed?: (action: ProposedAction) => void;
    traceCollector?: (item: ToolTraceItem) => void;
  }
): DynamicStructuredTool {
  let schema: any;

  if (agentTool.schema && (typeof (agentTool.schema as any).parse === 'function' || typeof (agentTool.schema as any).safeParse === 'function')) {
    schema = agentTool.schema;
  } else if (typeof agentTool.schema === 'object' && agentTool.schema !== null) {
    // Preserve exact JSON Schema objects directly (appId, port, platform, etc.)
    schema = agentTool.schema;
  } else {
    // Fallback closed for invalid/empty schemas
    schema = z.record(z.string(), z.unknown());
  }

  return new DynamicStructuredTool({
    name: agentTool.name,
    description: agentTool.description,
    schema,
    func: async (input: any): Promise<string> => {
      const startTime = Date.now();
      try {
        const rawResult = await agentTool.execute(input);
        const durationMs = Date.now() - startTime;

        // If the tool execution explicitly returned a canonical proposedAction, capture it
        if (rawResult && typeof rawResult === 'object') {
          const actionCandidate = (rawResult as any).proposedAction || (rawResult as any).action;
          if (
            actionCandidate &&
            typeof actionCandidate === 'object' &&
            typeof actionCandidate.type === 'string' &&
            typeof actionCandidate.title === 'string'
          ) {
            options?.onActionProposed?.(actionCandidate as ProposedAction);
          }
        }

        if (options?.traceCollector) {
          options.traceCollector({
            toolName: agentTool.name,
            input,
            output: rawResult,
            durationMs,
          });
        }

        return typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
      } catch (err: unknown) {
        const durationMs = Date.now() - startTime;

        // Propagate fencing, abort, budget, and cancellation errors immediately
        const isFencingOrAbort =
          err instanceof Error &&
          (err.name === 'AbortError' ||
            (err as any).code === 'ABORT_ERR' ||
            /fencing|workspace lock|cancelled|budget exceeded|FENCING_TOKEN/i.test(err.message));

        if (isFencingOrAbort) {
          throw err;
        }

        // Return a static generic error message to prevent secret or credential leakage
        const staticErrorMessage = 'Tool execution failed';

        if (options?.traceCollector) {
          options.traceCollector({
            toolName: agentTool.name,
            input,
            error: staticErrorMessage,
            durationMs,
          });
        }

        return JSON.stringify({
          toolError: true,
          message: staticErrorMessage,
        });
      }
    },
  });
}

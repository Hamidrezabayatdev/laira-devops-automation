import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  executeTaskCommand,
  executeStatusCommand,
  executeConnectLiaraCommand,
  executeApproveCommand,
} from './commands.js';
import { executeImportEnvironmentCommand } from './import-environment.js';
import { executeMonitorCommand, type MonitorCommandArgs } from './monitor.js';
import { AppError } from '@laira/security';
import type {
  CliExecutionResult,
  OperatorCliDependencies,
} from './types.js';

export function parseCliArgs(argv: string[]): {
  command: string;
  options: Record<string, string>;
} {
  const options: Record<string, string> = {};
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const full = arg.slice(2);
      const eqIdx = full.indexOf('=');
      let key = full;
      let val: string | undefined = undefined;
      if (eqIdx !== -1) {
        key = full.slice(0, eqIdx);
        val = full.slice(eqIdx + 1);
      }
      if (val !== undefined) {
        options[key] = val;
      } else {
        const nextArg = argv[i + 1];
        if (nextArg && !nextArg.startsWith('-')) {
          options[key] = nextArg;
          i++;
        } else {
          options[key] = 'true';
        }
      }
    } else if (arg.startsWith('-')) {
      const full = arg.slice(1);
      const eqIdx = full.indexOf('=');
      let key = full;
      let val: string | undefined = undefined;
      if (eqIdx !== -1) {
        key = full.slice(0, eqIdx);
        val = full.slice(eqIdx + 1);
      }
      if (val !== undefined) {
        options[key] = val;
      } else {
        const nextArg = argv[i + 1];
        if (nextArg && !nextArg.startsWith('-')) {
          options[key] = nextArg;
          i++;
        } else {
          options[key] = 'true';
        }
      }
    } else if (!command) {
      command = arg;
    }
  }

  if (!command && (options.help || options.h)) {
    command = 'help';
  }

  return {
    command: command.toLowerCase(),
    options,
  };
}

const USAGE_HELP = `
Laira Product Operator CLI

Usage:
  operator task --repository <url> --task <description> [--connection <id>] [--environment-connection <id>] [--environment-version <version>]
  operator status --run <runId>
  operator connect-liara [--team-id <teamId>] [--name <name>]
  operator import-environment --name <name> --file <path> --keys <key1,key2>
  operator monitor [--action <register|check|status|pause|resume>] [--connection <id>] [--app <slug>] [--path <path>] [--interval <sec>] [--monitor <id>]
  operator approve --run <runId> --hash <proposalHash>
  operator --help

Commands:
  task            Queue an agent analysis task for a public GitHub repository.
                  Options:
                    -r, --repository            Public GitHub repository URL (https://github.com/owner/repo)
                    -t, --task                  Task instructions for the DevOps agent
                    -c, --connection            Optional Liara connection ID
                    --environment-connection    Optional environment connection ID
                    --environment-version       Optional environment credential version (positive integer)

  status          Query safe status and events for an agent task run.
                  Options:
                    -r, --run                   The run ID to query

  connect-liara   Securely store Liara API token from LIARA_API_TOKEN environment variable.
                  Options:
                    -t, --team-id               Optional Liara team ID
                    -n, --name                  Optional connection name

  import-environment  Securely import allowlisted environment secrets into the workspace.
                  Options:
                    -n, --name                  Connection name for the imported environment
                    -f, --file                  Local path to .env file (<= 64 KiB, no symlinks)
                    -k, --keys                  Comma-separated allowlist of environment variable keys

  monitor         Manage persistent application health monitoring.
                  Options:
                    -a, --action                Action: register, check, status, pause, resume (default: status)
                    -c, --connection            Connection ID
                    --app                       Application slug or ID
                    -p, --path                  Health check path (e.g. /api/health)
                    -i, --interval              Health check interval in seconds
                    -m, --monitor               Monitor ID

  approve         Explicitly approve a proposed deployment, create_app, or restart action.
                  Options:
                    -r, --run                   The source agent_task run ID
                    -h, --hash                  The exact 64-character SHA-256 proposal hash

  help, --help    Show this help message.
`.trim();

/**
 * Formats CLI execution errors safely.
 * Allows structured AppError and known static CLI validation messages,
 * but falls back to generic 'Operator command failed' for unknown errors
 * to strictly prevent leaking database connection strings, SQL details, or internal traces.
 */
export function formatCliError(err: unknown): string {
  if (err instanceof AppError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) {
    const safeErrorPrefixes = [
      'GitHub authentication failed',
      'GitHub API',
      'Operator verification failed',
      'Identity mismatch',
      'DATABASE_URL environment variable is required',
      'Invalid DATABASE_URL',
      'Operator local mode requires',
      'Task description is required',
      'Task description exceeds',
      'Repository URL is required',
      'Invalid repository URL',
      'Both --environment-connection and --environment-version must be provided together',
      'Environment credential version must be a positive integer',
      'Environment connection not found in workspace',
      'Environment connection provider must be "deployment_env"',
      'Environment connection is not eligible',
      'Environment credential version does not match active connection version',
      'Environment credential version record not found',
      'Run ID is required',
      'Proposal hash is required',
      'Invalid proposal hash format',
      'LIARA_API_TOKEN environment variable is required',
      'ENCRYPTION_MASTER_KEY environment variable is required',
      'Existing Liara connection already configured',
      'Existing connection already exists with name',
      'Connection not found in workspace',
      'Connection provider must be "liara"',
      'Connection is not eligible',
      'Connection credential version record not found',
      'Connection active version must be a positive integer',
      'Connection ID cannot be empty',
      'Connection name cannot be empty',
      'Connection name exceeds maximum length',
      'Connection name contains invalid characters',
      'Invalid monitor action',
      'Action is required',
      'Unknown command',
      'Connection name is required',
      'Environment file path is required',
      'Environment keys allowlist is required',
      'Failed to read environment file',
      'Failed to parse environment file',
      'Missing allowlisted environment variable',
      'No environment variable keys specified in allowlist',
      'Invalid connection name',
      'Invalid variable key',
      'Reserved variable key',
      'Runtime environment contains',
    ];

    const isSafe = safeErrorPrefixes.some((prefix) => err.message.startsWith(prefix));
    if (isSafe) {
      return err.message;
    }
  }
  return 'Operator command failed';
}

/**
 * Main dispatcher function for the Operator CLI.
 * Accepts argv (excluding node and script paths) and optional dependency injection.
 */
export async function runOperatorCli(
  argv: string[],
  deps?: OperatorCliDependencies
): Promise<CliExecutionResult> {
  const { command, options } = parseCliArgs(argv);

  if (!command || command === 'help' || command === '--help' || options.help) {
    const msg = USAGE_HELP;
    if (deps?.stdout) {
      deps.stdout(msg);
    } else {
      console.log(msg);
    }
    return {
      command: 'help',
      message: msg,
    };
  }

  switch (command) {
    case 'task': {
      const repository = options.repository ?? options.r ?? '';
      const task = options.task ?? options.t ?? '';
      const connectionId =
        options.connection ?? options['connection-id'] ?? options.connectionId ?? options.c ?? undefined;
      const envConnection =
        options['environment-connection'] ?? options.environmentConnection ?? undefined;
      const envVersionRaw =
        options['environment-version'] ?? options.environmentVersion ?? undefined;

      let environmentCredentialVersion: number | undefined = undefined;
      if (envVersionRaw !== undefined) {
        if (!/^[1-9]\d*$/.test(envVersionRaw.trim())) {
          throw new Error('Environment credential version must be a positive integer');
        }
        environmentCredentialVersion = parseInt(envVersionRaw.trim(), 10);
      }

      const data = await executeTaskCommand(
        {
          repository,
          task,
          connectionId: connectionId !== undefined ? connectionId.trim() : undefined,
          environmentConnectionId: envConnection !== undefined ? envConnection.trim() : undefined,
          environmentCredentialVersion,
        },
        deps
      );
      return {
        command: 'task',
        data,
        message: data.runId,
      };
    }

    case 'status': {
      const run = options.run ?? options.r ?? '';
      const data = await executeStatusCommand({ run }, deps);
      return {
        command: 'status',
        data,
        message: data.status,
      };
    }

    case 'connect-liara': {
      const teamId = options['team-id'] ?? options.teamId ?? options.t ?? undefined;
      const name = options.name ?? options.n ?? undefined;
      const data = await executeConnectLiaraCommand(
        {
          teamId: teamId !== undefined ? teamId.trim() : undefined,
          name: name !== undefined ? name.trim() : undefined,
        },
        deps
      );
      return {
        command: 'connect-liara',
        data,
        message: data.connectionId,
      };
    }

    case 'import-environment': {
      const name = options.name || options.n || '';
      const file = options.file || options.f || '';
      const keys = options.keys || options.k || '';
      const data = await executeImportEnvironmentCommand({ name, file, keys }, deps);
      return {
        command: 'import-environment',
        data,
        message: data.connectionId,
      };
    }

    case 'monitor': {
      const rawAction = options.action ?? options.a;
      let action: MonitorCommandArgs['action'];
      if (rawAction === undefined) {
        action = 'status';
      } else {
        const trimmed = rawAction.trim();
        if (
          trimmed === 'register' ||
          trimmed === 'check' ||
          trimmed === 'status' ||
          trimmed === 'pause' ||
          trimmed === 'resume'
        ) {
          action = trimmed;
        } else {
          throw new Error('Invalid monitor action. Must be one of: register, check, status, pause, resume');
        }
      }

      const connectionId =
        options.connection ?? options['connection-id'] ?? options.connectionId ?? options.c ?? undefined;
      const app =
        options.app ?? options['app-id'] ?? options.appId ?? options['app-slug'] ?? options.appSlug ?? undefined;
      const path =
        options.path ?? options.p ?? undefined;
      const interval =
        options.interval ?? options.i ?? undefined;
      const monitorId =
        options.monitor ?? options['monitor-id'] ?? options.monitorId ?? options.m ?? undefined;

      const data = await executeMonitorCommand(
        {
          action,
          connectionId: connectionId !== undefined ? connectionId.trim() : undefined,
          appId: app !== undefined ? app.trim() : undefined,
          appSlug: app !== undefined ? app.trim() : undefined,
          path: path !== undefined ? path.trim() : undefined,
          interval: interval !== undefined ? interval.trim() : undefined,
          monitorId: monitorId !== undefined ? monitorId.trim() : undefined,
        },
        deps
      );
      return {
        command: 'monitor',
        data,
        message: data.monitor?.id || data.action,
      };
    }

    case 'approve': {
      const run = options.run || options.r || '';
      const hash = options.hash || options.h || '';
      const data = await executeApproveCommand({ run, hash }, deps);
      return {
        command: 'approve',
        data,
        message: data.executionRunId,
      };
    }

    default: {
      throw new Error(
        `Unknown command "${command}". Run "operator --help" for available commands.`
      );
    }
  }
}

// Entrypoint execution when invoked directly from command line
const isDirectEntrypoint =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('/operator.js') ||
    process.argv[1].endsWith('\\operator.js'));

if (isDirectEntrypoint) {
  runOperatorCli(process.argv.slice(2))
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Error: ${formatCliError(err)}`);
      process.exit(1);
    });
}

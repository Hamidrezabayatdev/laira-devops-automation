import type pg from 'pg';
import {
  registerAppMonitor,
  getAppMonitor,
  getAppMonitorByTarget,
  listAppMonitors,
  pauseAppMonitor,
  resumeAppMonitor,
  getOpenIncidentForMonitor,
  listMonitorIncidents,
  toSafeMonitorDto,
  type AppMonitor,
  type SafeAppMonitor,
  type AppMonitorIncident,
  type WorkspaceScope,
} from '@laira/db';
import { AppError } from '@laira/security';
import type { LiaraOperationalAdapter } from '@laira/providers/liara/operational';
import { authenticateOperator } from './auth.js';
import { resolveDatabasePool, resolveOperatorWorkspace } from './db.js';
import type { OperatorCliDependencies } from './types.js';
import {
  executeDeterministicMonitorCheck,
  type DeterministicCheckResult,
  type MonitorExecutionDependencies,
} from '../app-monitor.js';

export interface MonitorCommandArgs {
  action: 'register' | 'check' | 'status' | 'pause' | 'resume';
  connectionId?: string;
  appId?: string;
  appSlug?: string;
  path?: string;
  monitorId?: string;
  interval?: number | string;
}

export interface MonitorCommandDependencies extends OperatorCliDependencies, MonitorExecutionDependencies {
  createLiaraAdapter?: (config: { apiKey: string; teamId?: string }) => LiaraOperationalAdapter;
}

export interface SafeMonitorStatusOutput {
  monitor: SafeAppMonitor;
  openIncident: AppMonitorIncident | null;
  recentIncidents?: AppMonitorIncident[];
}

export interface MonitorCliResult {
  action: string;
  monitor?: SafeAppMonitor;
  monitors?: SafeMonitorStatusOutput[];
  openIncident?: AppMonitorIncident | null;
  checkResult?: {
    probeOk: boolean;
    httpStatus: number | null;
    incidentAction: string;
    incident: AppMonitorIncident | null;
  };
}

async function resolveTargetMonitor(
  pool: pg.Pool,
  scope: WorkspaceScope,
  args: MonitorCommandArgs
): Promise<AppMonitor> {
  if (args.monitorId?.trim()) {
    const monitor = await getAppMonitor(pool, scope, args.monitorId.trim());
    if (!monitor) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: `Monitor ${args.monitorId.trim()} not found in workspace`,
        statusCode: 404,
      });
    }
    return monitor;
  }

  const connectionId = args.connectionId?.trim();
  const slug = (args.appSlug || args.appId)?.trim();

  if (connectionId && slug) {
    const monitor = await getAppMonitorByTarget(pool, scope, connectionId, slug);
    if (!monitor) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: `Monitor for connection ${connectionId} and app ${slug} not found in workspace`,
        statusCode: 404,
      });
    }
    return monitor;
  }

  throw new AppError({
    code: 'BAD_REQUEST',
    message: 'Either monitorId or both connectionId and appId must be provided',
    statusCode: 400,
  });
}

/**
 * CLI command handler for persistent deterministic application monitoring.
 *
 * Supported actions:
 * - 'register': registers or updates monitor (idempotent, validated Liara connection and health path).
 * - 'check': manually triggers ONE deterministic check scoped to the monitor.
 * - 'status': outputs safe evidence, counters, and open/recent incidents.
 * - 'pause': pauses future checks; persists across worker restarts.
 * - 'resume': resumes monitoring; resets check schedule.
 */
export async function executeMonitorCommand(
  args: MonitorCommandArgs,
  deps?: MonitorCommandDependencies
): Promise<MonitorCliResult> {
  if (!args || !args.action) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'Action is required ("register", "check", "status", "pause", "resume")',
      statusCode: 400,
    });
  }

  // 1. Authenticate and verify operator identity
  const user = await authenticateOperator(deps);

  // 2. Resolve database pool and workspace
  const managedPool = resolveDatabasePool(deps);

  try {
    const { workspace } = await resolveOperatorWorkspace(managedPool.pool, user);
    const scope: WorkspaceScope = { workspaceId: workspace.id };

    let result: MonitorCliResult;

    switch (args.action) {
      case 'register': {
        const connectionId = args.connectionId?.trim();
        if (!connectionId) {
          throw new AppError({
            code: 'BAD_REQUEST',
            message: 'connectionId is required for registration',
            statusCode: 400,
          });
        }

        const appSlug = (args.appSlug || args.appId)?.trim();
        if (!appSlug) {
          throw new AppError({
            code: 'BAD_REQUEST',
            message: 'appId or appSlug is required for registration',
            statusCode: 400,
          });
        }

        const rawInterval = args.interval !== undefined ? Number(args.interval) : undefined;
        const monitor = await registerAppMonitor(managedPool.pool, scope, {
          connectionId,
          appSlug,
          healthPath: args.path,
          intervalSeconds: rawInterval,
        });

        result = {
          action: 'register',
          monitor: toSafeMonitorDto(monitor),
        };
        break;
      }

      case 'check': {
        const monitor = await resolveTargetMonitor(managedPool.pool, scope, args);

        const checkOutcome: DeterministicCheckResult = await executeDeterministicMonitorCheck(
          managedPool.pool,
          monitor,
          deps
        );

        result = {
          action: 'check',
          monitor: toSafeMonitorDto(checkOutcome.monitor),
          openIncident: checkOutcome.incident,
          checkResult: {
            probeOk: checkOutcome.probeResult.ok,
            httpStatus: checkOutcome.probeResult.httpStatus,
            incidentAction: checkOutcome.incidentAction,
            incident: checkOutcome.incident,
          },
        };
        break;
      }

      case 'status': {
        const hasSpecificTarget = Boolean(args.monitorId?.trim() || (args.connectionId?.trim() && (args.appSlug || args.appId)?.trim()));

        if (hasSpecificTarget) {
          const monitor = await resolveTargetMonitor(managedPool.pool, scope, args);
          const openInc = await getOpenIncidentForMonitor(managedPool.pool, monitor.id);
          const incidents = await listMonitorIncidents(managedPool.pool, scope, monitor.id);
          const safeMon = toSafeMonitorDto(monitor);

          result = {
            action: 'status',
            monitor: safeMon,
            openIncident: openInc,
            monitors: [
              {
                monitor: safeMon,
                openIncident: openInc,
                recentIncidents: incidents,
              },
            ],
          };
        } else {
          const allMonitors = await listAppMonitors(managedPool.pool, scope);
          const listWithIncidents: SafeMonitorStatusOutput[] = [];

          for (const mon of allMonitors) {
            const openInc = await getOpenIncidentForMonitor(managedPool.pool, mon.id);
            listWithIncidents.push({
              monitor: toSafeMonitorDto(mon),
              openIncident: openInc,
            });
          }

          result = {
            action: 'status',
            monitors: listWithIncidents,
          };
        }
        break;
      }

      case 'pause': {
        const monitor = await resolveTargetMonitor(managedPool.pool, scope, args);
        const updated = await pauseAppMonitor(managedPool.pool, scope, monitor.id);
        result = {
          action: 'pause',
          monitor: toSafeMonitorDto(updated || monitor),
        };
        break;
      }

      case 'resume': {
        const monitor = await resolveTargetMonitor(managedPool.pool, scope, args);
        const updated = await resumeAppMonitor(managedPool.pool, scope, monitor.id);
        result = {
          action: 'resume',
          monitor: toSafeMonitorDto(updated || monitor),
        };
        break;
      }

      default: {
        throw new AppError({
          code: 'BAD_REQUEST',
          message: `Unknown action: ${(args as any).action}`,
          statusCode: 400,
        });
      }
    }

    const outputJson = JSON.stringify(result, null, 2);
    if (deps?.stdout) {
      deps.stdout(outputJson);
    } else {
      console.log(outputJson);
    }

    return result;
  } finally {
    if (managedPool.shouldClose) {
      await managedPool.pool.end();
    }
  }
}

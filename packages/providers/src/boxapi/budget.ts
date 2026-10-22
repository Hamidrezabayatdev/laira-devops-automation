import {
  RUN_LIMITS,
  type BoxApiConfig,
  type IRunBudgetController,
  type IWorkspaceConcurrencyController,
  type IAiStopController,
} from './types.js';
import {
  RunBudgetExceededError,
  WorkspaceConcurrencyLimitExceededError,
  AiStoppedError,
  DemoOperatorKeyDeniedError,
} from './errors.js';

/**
 * In-Memory Run Budget Controller.
 *
 * NOTE ON DISTRIBUTED ENFORCEMENT:
 * This implementation is strictly in-memory and enforces limits within the current
 * Node.js worker process. It is NOT distributed across multiple worker processes.
 * In production with multiple worker processes, a shared distributed checkpointer
 * (e.g. backed by PostgreSQL or Redis) implementing IRunBudgetController must be injected.
 */
export class RunBudgetController implements IRunBudgetController {
  private readonly runCounts = new Map<string, number>();
  readonly maxCalls: number;

  constructor(maxCalls: number = RUN_LIMITS.maxCallsPerRun) {
    this.maxCalls = maxCalls;
  }

  /**
   * Counts every dispatch including retries against the run allowance.
   * Throws RunBudgetExceededError if limit is reached.
   */
  checkAndRecordDispatch(runId: string): number {
    const current = this.runCounts.get(runId) || 0;
    if (current >= this.maxCalls) {
      throw new RunBudgetExceededError(runId, current, this.maxCalls);
    }
    const next = current + 1;
    this.runCounts.set(runId, next);
    return next;
  }

  getRunCallCount(runId: string): number {
    return this.runCounts.get(runId) || 0;
  }

  resetRun(runId: string): void {
    this.runCounts.delete(runId);
  }
}

/**
 * In-Memory Workspace Concurrency Controller.
 *
 * NOTE ON DISTRIBUTED ENFORCEMENT:
 * This implementation manages in-flight locks within the current process instance.
 * For horizontally scaled environments, an injected shared lock manager
 * implementing IWorkspaceConcurrencyController is required.
 */
export class WorkspaceConcurrencyController implements IWorkspaceConcurrencyController {
  private readonly activeWorkspaces = new Set<string>();

  /**
   * Enforces 1 concurrent model call per workspace.
   * Throws WorkspaceConcurrencyLimitExceededError if workspace is already executing.
   * Returns a release function to unlock upon completion.
   */
  acquire(workspaceId: string): () => void {
    if (this.activeWorkspaces.has(workspaceId)) {
      throw new WorkspaceConcurrencyLimitExceededError(workspaceId);
    }
    this.activeWorkspaces.add(workspaceId);

    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeWorkspaces.delete(workspaceId);
      }
    };
  }

  isBusy(workspaceId: string): boolean {
    return this.activeWorkspaces.has(workspaceId);
  }
}

/**
 * In-Memory AI Stop Controller.
 */
export class AiStopController implements IAiStopController {
  private readonly stoppedWorkspaces = new Set<string>();

  setStopped(workspaceId: string, stopped: boolean): void {
    if (stopped) {
      this.stoppedWorkspaces.add(workspaceId);
    } else {
      this.stoppedWorkspaces.delete(workspaceId);
    }
  }

  isStopped(workspaceId: string): boolean {
    return this.stoppedWorkspaces.has(workspaceId);
  }

  assertNotStopped(workspaceId: string): void {
    if (this.isStopped(workspaceId)) {
      throw new AiStoppedError(workspaceId);
    }
  }
}

export class OwnerIdentityGate {
  /**
   * Verifies identity gate before model dispatch:
   * 1. If keyMode is 'demo_operator', ownerId MUST match explicitly configured demoOwnerId.
   * 2. Failed BYOK cannot fall back to operator demo key.
   */
  static verifyGate(config: BoxApiConfig): void {
    if (config.keyMode === 'demo_operator') {
      if (!config.demoOwnerId || config.ownerId !== config.demoOwnerId) {
        throw new DemoOperatorKeyDeniedError(config.ownerId);
      }
    }
  }
}

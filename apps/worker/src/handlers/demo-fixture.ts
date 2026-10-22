import pg from 'pg';
import {
  resolveRunForExecution,
  claimRunForExecution,
  appendRunEvent,
  completeRun,
  updateRunHeartbeat,
  getRunEvents,
  Run,
  RunEvent,
} from '@laira/db';

export interface FixtureExecutionResult {
  run: Run;
  eventsEmitted: number;
  recovered: boolean;
}

/**
 * Executes the bounded Phase 0 demo fixture task.
 * Enforces:
 * 1. Worker resolves workspace identity from stored DB run row, NEVER from job payload.
 * 2. Idempotent claim and redelivery tolerance.
 * 3. Never mutates live provider infrastructure in Phase 0.
 * 4. Persists monotonic sequence events with safe minimal typed payloads.
 * 5. Does not mark run succeeded unless fixture handler actually persisted events.
 */
export async function executeDemoFixtureRun(
  pool: pg.Pool,
  workerId: string,
  runId: string,
  leaseTimeoutSeconds = 30,
  stepDelayMs = 0
): Promise<FixtureExecutionResult> {
  // 1. Resolve workspace from stored run row, NOT payload
  const resolved = await resolveRunForExecution(pool, runId);
  if (!resolved) {
    throw new Error(`Run ${runId} cannot be resolved from database`);
  }

  const { run, workspaceId } = resolved;

  // 2. Check for terminal status
  if (run.status === 'cancelled') {
    return { run, eventsEmitted: 0, recovered: false };
  }
  if (run.status === 'succeeded' || run.status === 'failed') {
    return { run, eventsEmitted: 0, recovered: false };
  }

  // 3. Claim run atomically
  const claimedRun = await claimRunForExecution(pool, workerId, runId, leaseTimeoutSeconds);
  if (!claimedRun) {
    // Check if terminal in the meantime
    const current = await resolveRunForExecution(pool, runId);
    if (current && ['succeeded', 'failed', 'cancelled'].includes(current.run.status)) {
      return { run: current.run, eventsEmitted: 0, recovered: false };
    }
    const conflictError = new Error(
      `Worker ${workerId} could not claim run ${runId}: active lease held by another worker`
    );
    conflictError.name = 'FencingError';
    throw conflictError;
  }

  // 4. Inspect existing events for crash recovery / idempotency
  const existingEvents = await getRunEvents(pool, { workspaceId }, runId);
  const existingTypes = new Set(existingEvents.map((e: RunEvent) => e.type));

  let eventsEmitted = 0;
  const isRecovered = run.status === 'running' && existingEvents.length > 1;

  // Step 1: Progress event
  if (!existingTypes.has('step_progress')) {
    await appendRunEvent(pool, workerId, runId, {
      type: 'step_progress',
      payload: {
        step: 'discovery',
        progress: 30,
        message: 'Inspecting mock PaaS resources and configuration',
      },
    });
    eventsEmitted++;
    await updateRunHeartbeat(pool, workerId, runId);

    // Optional controlled test-only delay between steps for mid-run recovery testing
    if (stepDelayMs > 0) {
      await new Promise((r) => setTimeout(r, stepDelayMs));
    }
  }

  // Step 2: Read-only fixture inspection event
  if (!existingTypes.has('fixture_inspection')) {
    await appendRunEvent(pool, workerId, runId, {
      type: 'fixture_inspection',
      payload: {
        resourceCount: 3,
        verified: true,
        summary: 'Read-only fixture inspection finished safely with no provider mutations',
      },
    });
    eventsEmitted++;
    await updateRunHeartbeat(pool, workerId, runId);
  }

  // Step 3: Step completed event
  if (!existingTypes.has('step_completed')) {
    await appendRunEvent(pool, workerId, runId, {
      type: 'step_completed',
      payload: {
        step: 'discovery',
        outcome: 'ok',
        summary: 'PaaS discovery completed: 3 mock resources verified',
      },
    });
    eventsEmitted++;
  }

  // Step 4: Run succeeded event
  if (!existingTypes.has('run_succeeded')) {
    await appendRunEvent(pool, workerId, runId, {
      type: 'run_succeeded',
      payload: {
        resultSummary: 'Bounded demo fixture completed successfully in read-only mode',
        completedAt: new Date().toISOString(),
      },
    });
    eventsEmitted++;
  }

  // 5. Complete run with output
  const finalOutput = {
    mode: 'read_only_fixture',
    status: 'verified',
    resourcesInspected: 3,
    providerMutations: 0,
    timestamp: new Date().toISOString(),
  };

  const completed = await completeRun(pool, workerId, runId, finalOutput);

  return {
    run: completed,
    eventsEmitted,
    recovered: isRecovered,
  };
}

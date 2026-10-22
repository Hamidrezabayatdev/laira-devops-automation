import pg from 'pg';
import { PgBoss, type Job } from 'pg-boss';
import {
  getDatabasePool,
  resolveRunForExecution,
  claimRunForExecution,
  failRun,
} from '@laira/db';
import { WorkerConfig, loadWorkerConfig } from './config.js';
import { WorkerHeartbeatManager } from './heartbeat.js';
import { OutboxPoller, safeErrorMessage, BossDispatcher } from './outbox-poller.js';
import { executeDemoFixtureRun } from './handlers/demo-fixture.js';
import { executeAgentTaskRun } from './handlers/agent-task.js';
import { executeApprovedAgentActionRun } from './handlers/approved-action.js';

export class AppWorker {
  private pool: pg.Pool;
  private config: WorkerConfig;
  private heartbeat: WorkerHeartbeatManager;
  private outboxPoller: OutboxPoller | null = null;
  private boss: PgBoss | null = null;
  private isRunning = false;
  private isStarting = false;
  private isStopping = false;
  private startPromise: Promise<void> | null = null;

  constructor(config?: Partial<WorkerConfig>, pool?: pg.Pool) {
    this.config = { ...loadWorkerConfig(), ...config };
    this.pool = pool || getDatabasePool({ connectionString: this.config.databaseUrl });
    this.heartbeat = new WorkerHeartbeatManager(this.pool, this.config);
  }

  public async start(): Promise<void> {
    if (this.isRunning || this.isStarting || this.isStopping) return;
    this.isStarting = true;

    const doStart = async () => {
      console.log(
        `[Worker ${this.config.workerId}] Starting on host ${this.config.hostname} (PID ${this.config.pid})...`
      );

      // 1. Start pg-boss in isolated pgboss schema
      this.boss = new PgBoss({
        connectionString: this.config.databaseUrl,
        schema: this.config.pgbossSchema,
        ...(this.config.pgbossSuperviseIntervalSeconds !== undefined
          ? {
              superviseIntervalSeconds: this.config.pgbossSuperviseIntervalSeconds,
              monitorIntervalSeconds: this.config.pgbossSuperviseIntervalSeconds,
            }
          : {}),
      });

      this.boss.on('error', (err: unknown) => {
        console.error(
          `[Worker ${this.config.workerId}] pg-boss error: ${safeErrorMessage(err)}`
        );
      });

      await this.boss.start();
      console.log(
        `[Worker ${this.config.workerId}] pg-boss started with schema "${this.config.pgbossSchema}"`
      );

      // 2. Ensure queue is created or updated with retry & expiration options
      const queueOptions = {
        retryLimit: 3,
        retryDelay: 1,
        retryBackoff: false,
        expireInSeconds: this.config.pgbossExpireSeconds,
      };

      const existingQueue = await this.boss.getQueue('run.execute');
      if (!existingQueue) {
        await this.boss.createQueue('run.execute', queueOptions);
      } else {
        await this.boss.updateQueue('run.execute', queueOptions);
      }

      // 3. Register queue handler
      await this.boss.work<{ runId: string }>(
        'run.execute',
        { batchSize: 5 },
        async (jobs: Job<{ runId: string }>[]) => {
          for (const job of jobs) {
            const runId = job.data.runId;
            try {
              const resolved = await resolveRunForExecution(this.pool, runId);
              if (!resolved) {
                console.error(
                  `[Worker ${this.config.workerId}] Run ${runId} cannot be resolved from database`
                );
                continue;
              }

              const { run } = resolved;
              switch (run.type) {
                case 'demo_fixture':
                  await executeDemoFixtureRun(
                    this.pool,
                    this.config.workerId,
                    runId,
                    this.config.runLeaseTimeoutSeconds,
                    this.config.fixtureStepDelayMs
                  );
                  break;
                case 'agent_task':
                  await executeAgentTaskRun(
                    this.pool,
                    this.config.workerId,
                    runId,
                    this.config.runLeaseTimeoutSeconds
                  );
                  break;
                case 'agent_action':
                  await executeApprovedAgentActionRun(
                    this.pool,
                    this.config.workerId,
                    runId,
                    this.config.runLeaseTimeoutSeconds
                  );
                  break;
                default: {
                  console.error(
                    `[Worker ${this.config.workerId}] Unknown run type for run ${runId}`
                  );
                  await claimRunForExecution(
                    this.pool,
                    this.config.workerId,
                    runId,
                    this.config.runLeaseTimeoutSeconds
                  );
                  await failRun(this.pool, this.config.workerId, runId, {
                    code: 'UNKNOWN_RUN_TYPE',
                    message: 'Unsupported run type',
                  }).catch(() => {});
                  break;
                }
              }
            } catch (err) {
              console.error(
                `[Worker ${this.config.workerId}] Error executing run ${runId}: ${safeErrorMessage(err)}`
              );
              throw err;
            }
          }
        }
      );

      // 4. Start approx 1-sec outbox poller
      this.outboxPoller = new OutboxPoller(this.pool, this.config, this.boss as BossDispatcher);
      this.outboxPoller.start();

      // 5. Start worker heartbeat pulse ONLY when queues, handler and poller are fully ready
      await this.heartbeat.start();

      this.isRunning = true;
      console.log(
        `[Worker ${this.config.workerId}] Worker fully operational. Heartbeat and queue active.`
      );
    };

    this.startPromise = doStart();
    try {
      await this.startPromise;
    } finally {
      this.isStarting = false;
    }
  }

  public async stop(): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;

    // Handle startup/shutdown race: if start is in flight, await it to settle before stopping
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Startup error will be handled by caller
      }
    }

    console.log(`[Worker ${this.config.workerId}] Graceful shutdown initiated...`);
    this.isRunning = false;

    // 1. Stop outbox poller
    if (this.outboxPoller) {
      await this.outboxPoller.stop();
      this.outboxPoller = null;
    }

    // 2. Stop pg-boss (finishing in-flight jobs)
    if (this.boss) {
      try {
        await this.boss.stop({ graceful: true, timeout: 10000 });
      } catch (err) {
        console.error(
          `[Worker ${this.config.workerId}] Error stopping pg-boss: ${safeErrorMessage(err)}`
        );
      }
      this.boss = null;
    }

    // 3. Stop heartbeat and mark worker stopped
    await this.heartbeat.stop();

    console.log(`[Worker ${this.config.workerId}] Graceful shutdown complete.`);
  }

  public getWorkerId(): string {
    return this.config.workerId;
  }
}

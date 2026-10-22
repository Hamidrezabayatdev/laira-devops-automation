import pg from 'pg';
import {
  claimOutboxBatch,
  markOutboxDispatched,
  markOutboxFailed,
  OutboxItem,
} from '@laira/db';
import type { WorkerConfig } from './config.js';

/**
 * Returns a strictly safe, classified static error string.
 * Never leaks err.message, err.cause, err.stack, SQL queries, canary tokens, or credentials into logs.
 */
export function safeErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error occurred';
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const errorName = (err as { name?: unknown }).name;
    if (errorName === 'FencingError') {
      return 'Operation rejected: worker claim lease conflict (fenced out)';
    }
    if (errorName === 'ZodError') {
      return 'Validation failure: payload does not match schema';
    }
  }
  return 'Database operation failed with internal error';
}

export interface BossSendOptions {
  singletonKey?: string;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
}

export interface BossDispatcher {
  send(name: string, data: object, options?: BossSendOptions): Promise<string | null>;
}

export class OutboxPoller {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;
  private activePollPromise: Promise<number> | null = null;

  constructor(
    private pool: pg.Pool,
    private config: WorkerConfig,
    private boss: BossDispatcher
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run poll loop approximately every 1 second
    this.scheduleNext(100);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error(
          `[Worker ${this.config.workerId}] Outbox poll error: ${safeErrorMessage(err)}`
        );
      } finally {
        if (this.isRunning) {
          this.scheduleNext(this.config.outboxIntervalMs);
        }
      }
    }, delayMs);
  }

  public async pollOnce(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    const executePoll = async (): Promise<number> => {
      let client: pg.PoolClient | null = null;
      try {
        try {
          client = await this.pool.connect();
        } catch (connectErr) {
          console.error(
            `[Worker ${this.config.workerId}] Error connecting to database for outbox poll: ${safeErrorMessage(connectErr)}`
          );
          return 0;
        }

        let claimed: OutboxItem[] = [];
        try {
          await client.query('BEGIN');
          claimed = await claimOutboxBatch(client, this.config.workerId, 20);
          await client.query('COMMIT');
        } catch (claimErr) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Ignore rollback failure on disconnected client
          }
          console.error(
            `[Worker ${this.config.workerId}] Error claiming outbox batch: ${safeErrorMessage(claimErr)}`
          );
          return 0;
        } finally {
          try {
            client.release();
          } catch {
            // Ignore release failure
          }
          client = null;
        }

        if (claimed.length === 0) {
          return 0;
        }

        for (const item of claimed) {
          if (!item.claimedAt) {
            console.error(
              `[Worker ${this.config.workerId}] Claimed outbox item ${item.id} missing claim token (claimedAt)`
            );
            continue;
          }

          const claimedAt = item.claimedAt;
          const workerId = this.config.workerId;

          try {
            if (item.topic === 'run.dispatched') {
              const runId = item.payload.runId as string;
              if (!runId) {
                throw new Error('Outbox item missing runId in payload');
              }

              // Safe dispatch to pg-boss queue with stable outbox-based singletonKey.
              // In the event of a worker crash after send but before markOutboxDispatched,
              // the redelivery / replay will deduplicate against the active singleton job.
              await this.boss.send(
                'run.execute',
                { runId, outboxId: item.id },
                {
                  singletonKey: `outbox_${item.id}`,
                  retryLimit: 3,
                  retryDelay: 1,
                  retryBackoff: false,
                  expireInSeconds: this.config.pgbossExpireSeconds,
                }
              );
              await markOutboxDispatched(this.pool, item.id, workerId, claimedAt);
            } else {
              // Unknown topic - mark dispatched
              await markOutboxDispatched(this.pool, item.id, workerId, claimedAt);
            }
          } catch (dispatchErr) {
            const errorMsg = safeErrorMessage(dispatchErr);
            console.error(
              `[Worker ${this.config.workerId}] Failed to dispatch outbox item ${item.id}: ${errorMsg}`
            );
            try {
              await markOutboxFailed(this.pool, item.id, errorMsg, workerId, claimedAt);
            } catch (markErr) {
              console.error(
                `[Worker ${this.config.workerId}] Failed to mark outbox item as failed: ${safeErrorMessage(markErr)}`
              );
            }
          }
        }

        return claimed.length;
      } finally {
        if (client) {
          try {
            client.release();
          } catch {
            // Ignore release failure
          }
          client = null;
        }
        this.isProcessing = false;
      }
    };

    const pollPromise = executePoll();
    this.activePollPromise = pollPromise;
    try {
      return await pollPromise;
    } finally {
      if (this.activePollPromise === pollPromise) {
        this.activePollPromise = null;
      }
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activePollPromise) {
      try {
        await this.activePollPromise;
      } catch {
        // Ignore active poll error during shutdown
      }
    }
  }
}

import pg from 'pg';
import { upsertWorkerHeartbeat, setWorkerStatus } from '@laira/db';
import type { WorkerConfig } from './config.js';
import { safeErrorMessage } from './outbox-poller.js';

export class WorkerHeartbeatManager {
  private timer: NodeJS.Timeout | null = null;
  private isStopping = false;

  constructor(
    private pool: pg.Pool,
    private config: WorkerConfig
  ) {}

  public async start(): Promise<void> {
    // Initial heartbeat
    await this.pulse('alive');

    this.timer = setInterval(async () => {
      if (this.isStopping) return;
      try {
        await this.pulse('alive');
      } catch (err) {
        console.error(`[Worker ${this.config.workerId}] Heartbeat pulse failed: ${safeErrorMessage(err)}`);
      }
    }, this.config.heartbeatIntervalMs);
  }

  public async pulse(status: 'alive' | 'stopping' | 'stopped' = 'alive'): Promise<void> {
    await upsertWorkerHeartbeat(this.pool, {
      workerId: this.config.workerId,
      hostname: this.config.hostname,
      pid: this.config.pid,
      status,
      metadata: {
        nodeVersion: process.version,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().rss,
      },
    });
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await setWorkerStatus(this.pool, this.config.workerId, 'stopped');
    } catch {
      // Ignore errors on final stop update
    }
  }
}

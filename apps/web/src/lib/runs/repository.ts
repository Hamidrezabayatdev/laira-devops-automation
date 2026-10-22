import { randomUUID } from 'crypto';

export type RunState =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'waiting_external'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

export interface Run {
  id: string;
  runId: string;
  workspaceId: string;
  projectId?: string | null;
  title: string;
  type: string;
  state: RunState;
  status: RunState;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  summary?: string;
  planId?: string;
  metadata?: Record<string, unknown>;
}

export interface RunEvent {
  id: string;
  eventId: string;
  runId: string;
  workspaceId: string;
  seq: number;
  sequenceNumber: number;
  type: string;
  payload: Record<string, unknown>;
  safePayload: Record<string, unknown>;
  createdAt: string;
  timestamp: string;
}

export interface CreateRunInput {
  title?: string;
  type?: string;
  metadata?: Record<string, unknown>;
}

export function normalizeRun(raw: any): Run {
  const id = raw.id || raw.runId || `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const status = (raw.status || raw.state || 'queued') as RunState;
  const createdAt =
    raw.createdAt instanceof Date
      ? raw.createdAt.toISOString()
      : String(raw.createdAt || new Date().toISOString());
  const updatedAt =
    raw.updatedAt instanceof Date
      ? raw.updatedAt.toISOString()
      : String(raw.updatedAt || new Date().toISOString());
  const finishedAt =
    raw.finishedAt instanceof Date
      ? raw.finishedAt.toISOString()
      : raw.finishedAt
      ? String(raw.finishedAt)
      : null;
  const input = raw.input || {};
  const title =
    raw.title ||
    (input && typeof input.title === 'string' ? input.title : undefined) ||
    'اجرای ارزیابی زیرساخت';

  return {
    id,
    runId: id,
    workspaceId: raw.workspaceId || raw.workspace_id,
    projectId: raw.projectId || raw.project_id || null,
    title,
    type: raw.type || 'diagnostic',
    state: status,
    status,
    input,
    output: raw.output ?? null,
    error: raw.error ?? null,
    createdAt,
    updatedAt,
    finishedAt,
    metadata: raw.metadata || (input && input.metadata) || {},
    summary: raw.summary || (raw.output && raw.output.summary) || undefined,
  };
}

export function normalizeRunEvent(raw: any): RunEvent {
  const id = raw.id || raw.eventId || `evt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const seq =
    typeof raw.seq === 'number'
      ? raw.seq
      : typeof raw.sequenceNumber === 'number'
      ? raw.sequenceNumber
      : 1;
  const payload = raw.payload || raw.safePayload || {};
  const createdAt =
    raw.createdAt instanceof Date
      ? raw.createdAt.toISOString()
      : String(raw.createdAt || raw.timestamp || new Date().toISOString());

  return {
    id,
    eventId: id,
    runId: raw.runId || raw.run_id,
    workspaceId: raw.workspaceId || raw.workspace_id,
    seq,
    sequenceNumber: seq,
    type: raw.type,
    payload,
    safePayload: payload,
    createdAt,
    timestamp: createdAt,
  };
}

/**
 * Static demo fixture runs for read-only /demo view.
 */
export const DEMO_FIXTURE_RUNS: Run[] = [
  normalizeRun({
    id: 'run-fixture-initial-001',
    workspaceId: 'ws_demo_simulation',
    title: 'بررسی پیکربندی برنامه و سلامت دیتابیس پستگرس',
    type: 'diagnostic',
    status: 'succeeded',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date(Date.now() - 3500000).toISOString(),
    summary: 'پیکربندی با موفقیت تأیید شد و هیچ خطایی یافت نشد.',
    metadata: { appName: 'digishop-web', region: 'iran' },
  }),
  normalizeRun({
    id: 'run-fixture-initial-002',
    workspaceId: 'ws_demo_simulation',
    title: 'ارزیابی خودکار منابع و مقیاس‌پذیری عمودی',
    type: 'scaling',
    status: 'queued',
    createdAt: new Date(Date.now() - 1800000).toISOString(),
    updatedAt: new Date(Date.now() - 1800000).toISOString(),
    metadata: { appName: 'digishop-api', targetCpu: '2-core' },
  }),
];

/**
 * Runs repository managing durable runs and monotonic event sequences.
 * Strictly scopes every operation to the verified workspace ID.
 */
class RunsRepository {
  private runs = new Map<string, Run>();
  private events = new Map<string, RunEvent[]>();
  private listeners = new Map<string, Set<(event: RunEvent) => void>>();

  constructor() {
    this.seedDefaultRuns();
  }

  private seedDefaultRuns() {
    for (const run of DEMO_FIXTURE_RUNS) {
      this.runs.set(run.runId, run);
      this.events.set(run.runId, [
        normalizeRunEvent({
          id: `evt-demo-${run.runId}-1`,
          runId: run.runId,
          workspaceId: run.workspaceId,
          seq: 1,
          type: 'run.queued',
          payload: { message: 'اجرا در صف وظایف پایدار قرار گرفت' },
          createdAt: run.createdAt,
        }),
      ]);
    }
  }

  async createRun(workspaceId: string, input: CreateRunInput = {}): Promise<Run> {
    const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    const run = normalizeRun({
      id: runId,
      workspaceId,
      title: input.title || 'اجرای ارزیابی زیرساخت و سلامت سرویس',
      type: input.type || 'fixture_operation',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata || {},
    });

    this.runs.set(runId, run);
    this.events.set(runId, []);

    // Initial monotonic event (sequence 1)
    await this.addEvent(workspaceId, runId, 'run.queued', {
      title: run.title,
      type: run.type,
      message: 'اجرا ثبت شد و در وضعیت در صف قرار گرفت',
    });

    return run;
  }

  async getRun(workspaceId: string, runId: string): Promise<Run | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.workspaceId !== workspaceId) return null;
    return run;
  }

  async listRuns(workspaceId: string): Promise<Run[]> {
    return Array.from(this.runs.values())
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async cancelRun(
    workspaceId: string,
    runId: string,
    reason = 'Cancelled by owner request',
  ): Promise<{ success: boolean; run: Run | null }> {
    const run = await this.getRun(workspaceId, runId);
    if (!run) return { success: false, run: null };

    if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(run.state)) {
      return { success: false, run };
    }

    run.state = 'cancelled';
    run.status = 'cancelled';
    run.updatedAt = new Date().toISOString();
    this.runs.set(runId, run);

    await this.addEvent(workspaceId, runId, 'run.cancelled', {
      reason,
      cancelledAt: run.updatedAt,
    });

    return { success: true, run };
  }

  async addEvent(
    workspaceId: string,
    runId: string,
    type: string,
    safePayload: Record<string, unknown>,
  ): Promise<RunEvent> {
    const run = this.runs.get(runId);
    if (!run || run.workspaceId !== workspaceId) {
      throw new Error(`Unauthorized or missing run ${runId} for workspace ${workspaceId}`);
    }

    let runEvents = this.events.get(runId);
    if (!runEvents) {
      runEvents = [];
      this.events.set(runId, runEvents);
    }

    const sequenceNumber = runEvents.length + 1;
    const event = normalizeRunEvent({
      id: `evt_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      runId,
      workspaceId,
      seq: sequenceNumber,
      type,
      payload: safePayload,
      createdAt: new Date().toISOString(),
    });

    runEvents.push(event);
    this.notifySubscribers(runId, event);

    return event;
  }

  async getEvents(
    workspaceId: string,
    runId: string,
    afterSequence = 0,
  ): Promise<RunEvent[]> {
    const run = await this.getRun(workspaceId, runId);
    if (!run) return [];

    const allEvents = this.events.get(runId) || [];
    return allEvents.filter((e) => e.sequenceNumber > afterSequence);
  }

  notifyCreated(run: Run) {
    this.runs.set(run.runId, run);
  }

  notifyCancelled(workspaceId: string, runId: string, reason: string) {
    const run = this.runs.get(runId);
    if (run) {
      run.state = 'cancelled';
      run.status = 'cancelled';
      run.updatedAt = new Date().toISOString();
    }
    const event = normalizeRunEvent({
      runId,
      workspaceId,
      seq: (this.events.get(runId)?.length || 0) + 1,
      type: 'run.cancelled',
      payload: { reason },
    });
    this.notifySubscribers(runId, event);
  }

  notifySubscribers(runId: string, event: RunEvent) {
    const subs = this.listeners.get(runId);
    if (subs) {
      for (const listener of subs) {
        try {
          listener(event);
        } catch {
          // ignore
        }
      }
    }
  }

  subscribeEvents(
    workspaceId: string,
    runId: string,
    callback: (event: RunEvent) => void,
  ): () => void {
    const run = this.runs.get(runId);
    if (!run || run.workspaceId !== workspaceId) {
      return () => {};
    }
    let subs = this.listeners.get(runId);
    if (!subs) {
      subs = new Set();
      this.listeners.set(runId, subs);
    }

    subs.add(callback);

    return () => {
      subs?.delete(callback);
      if (subs && subs.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  simulateFixtureRunProgress(workspaceId: string, runId: string) {
    setTimeout(async () => {
      try {
        const run = await this.getRun(workspaceId, runId);
        if (!run || run.state === 'cancelled') return;

        run.state = 'running';
        run.status = 'running';
        await this.addEvent(workspaceId, runId, 'run.running', {
          step: 2,
          message: 'بررسی شاخص‌های زیرساخت و اتصالات شبکه در جریان است',
        });

        setTimeout(async () => {
          try {
            const current = await this.getRun(workspaceId, runId);
            if (!current || current.state === 'cancelled') return;

            current.state = 'succeeded';
            current.status = 'succeeded';
            await this.addEvent(workspaceId, runId, 'run.completed', {
              step: 3,
              message: 'عملیات با موفقیت تأیید و پایان یافت',
              exitCode: 0,
            });
          } catch {
            // ignore
          }
        }, 150);
      } catch {
        // ignore
      }
    }, 100);
  }
}

export const runsRepository = new RunsRepository();

import pg from 'pg';
import crypto from 'node:crypto';
import {
  getDatabasePool,
  createRun as dbCreateRun,
  getRun as dbGetRun,
  cancelRun as dbCancelRun,
  getRunEvents as dbGetRunEvents,
  lookupWorkspaceBySessionToken as dbLookupWorkspaceBySessionToken,
  getOrCreateOwnerWorkspace as dbGetOrCreateOwnerWorkspace,
  type SessionWorkspaceLookupResult,
} from '@laira/db';
import {
  type Run,
  type RunEvent,
  type CreateRunInput,
  normalizeRun,
  normalizeRunEvent,
} from '../runs/repository';

export class DatabaseUnavailableError extends Error {
  constructor(message = 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)') {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

// Bounded Phase 0 worker only supports the deterministic demo fixture task
export const ALLOWED_RUN_TYPES = ['demo_fixture'] as const;
export type AllowedRunType = typeof ALLOWED_RUN_TYPES[number];

export function isAllowedRunType(type: string): type is AllowedRunType {
  return (ALLOWED_RUN_TYPES as readonly string[]).includes(type);
}

export interface DbAdapterInterface {
  createRun(workspaceId: string, input: CreateRunInput): Promise<Run>;
  getRun(workspaceId: string, runId: string): Promise<Run | null>;
  listRuns(workspaceId: string): Promise<Run[]>;
  cancelRun(
    workspaceId: string,
    runId: string,
    reason?: string,
  ): Promise<{ success: boolean; run: Run | null }>;
  getEvents(
    workspaceId: string,
    runId: string,
    afterSequence?: number,
  ): Promise<RunEvent[]>;
  lookupWorkspaceBySessionToken(
    sessionToken: string,
  ): Promise<SessionWorkspaceLookupResult | null>;
  createSession(data: {
    sessionToken: string;
    userId?: string;
    expires: Date;
    githubNumericId: string;
    userName?: string;
    workspaceName?: string;
  }): Promise<{ sessionToken: string; workspaceId: string }>;
  checkHealth(): Promise<boolean>;
  getPool(): pg.Pool;
}

class DbAdapterBridge implements DbAdapterInterface {
  getPool(): pg.Pool {
    const connStr = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
    if (!connStr) {
      throw new DatabaseUnavailableError('DATABASE_URL or TEST_DATABASE_URL not configured');
    }
    try {
      return getDatabasePool();
    } catch {
      // Safe static error: never leak raw DB connection string or internal exception details
      throw new DatabaseUnavailableError('Database connection failed');
    }
  }

  async createRun(workspaceId: string, input: CreateRunInput = {}): Promise<Run> {
    const pool = this.getPool();
    const runType = input.type || 'demo_fixture';
    if (!isAllowedRunType(runType)) {
      throw new Error(
        `نوع اجرای نامعتبر است: '${runType}'. در فاز جاری تنها وظیفه '${ALLOWED_RUN_TYPES.join(', ')}' پشتیبانی می‌شود.`,
      );
    }

    const title = input.title || 'اجرای سناریوی آزمایشی (Demo Fixture)';
    try {
      const dbRun = await dbCreateRun(
        pool,
        { workspaceId },
        {
          type: runType,
          input: {
            title,
            metadata: input.metadata || {},
          },
          initialMessage: `آغاز فرایند شبیه‌سازی: ${title}`,
        },
      );

      return normalizeRun(dbRun);
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during run creation');
    }
  }

  async getRun(workspaceId: string, runId: string): Promise<Run | null> {
    const pool = this.getPool();
    try {
      const dbRun = await dbGetRun(pool, { workspaceId }, runId);
      return dbRun ? normalizeRun(dbRun) : null;
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during run retrieval');
    }
  }

  async listRuns(workspaceId: string): Promise<Run[]> {
    const pool = this.getPool();
    try {
      const res = await pool.query(
        `SELECT * FROM app.runs
         WHERE workspace_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [workspaceId],
      );
      return res.rows.map((row: any) =>
        normalizeRun({
          id: row.id,
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          type: row.type,
          status: row.status,
          input: row.input,
          output: row.output,
          error: row.error,
          claimedBy: row.claimed_by,
          claimedAt: row.claimed_at,
          heartbeatAt: row.heartbeat_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          finishedAt: row.finished_at,
        }),
      );
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during run listing');
    }
  }

  async cancelRun(
    workspaceId: string,
    runId: string,
    reason = 'Cancelled by owner request',
  ): Promise<{ success: boolean; run: Run | null }> {
    const pool = this.getPool();
    try {
      const existing = await dbGetRun(pool, { workspaceId }, runId);
      if (!existing) {
        return { success: false, run: null };
      }
      if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(existing.status)) {
        return { success: false, run: normalizeRun(existing) };
      }

      const updated = await dbCancelRun(pool, { workspaceId }, runId, reason);
      return {
        success: true,
        run: updated ? normalizeRun(updated) : null,
      };
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during run cancellation');
    }
  }

  async getEvents(
    workspaceId: string,
    runId: string,
    afterSequence = 0,
  ): Promise<RunEvent[]> {
    const pool = this.getPool();
    try {
      const events = await dbGetRunEvents(pool, { workspaceId }, runId, {
        afterSeq: afterSequence,
      });
      return events.map((e) => normalizeRunEvent(e));
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during event retrieval');
    }
  }

  async lookupWorkspaceBySessionToken(
    sessionToken: string,
  ): Promise<SessionWorkspaceLookupResult | null> {
    const pool = this.getPool();
    try {
      return await dbLookupWorkspaceBySessionToken(pool, sessionToken);
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during session lookup');
    }
  }

  async createSession(data: {
    sessionToken: string;
    userId?: string;
    expires: Date;
    githubNumericId: string;
    userName?: string;
    workspaceName?: string;
  }): Promise<{ sessionToken: string; workspaceId: string }> {
    const pool = this.getPool();
    try {
      const existingWs = await pool.query(
        `SELECT owner_user_id, id FROM app.workspaces WHERE github_user_id = $1 LIMIT 1`,
        [data.githubNumericId],
      );

      let userId = existingWs.rows[0]?.owner_user_id;
      let workspaceId = existingWs.rows[0]?.id;

      if (!existingWs.rows[0]) {
        userId = data.userId || `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const { user, workspace } = await dbGetOrCreateOwnerWorkspace(pool, {
          user: {
            id: userId,
            name: data.userName || `توسعه‌دهنده ${data.githubNumericId}`,
          },
          githubUserId: data.githubNumericId,
          workspaceName: data.workspaceName,
        });
        userId = user.id;
        workspaceId = workspace.id;
      }

      await pool.query(
        `INSERT INTO app.sessions (session_token, user_id, expires, created_at, updated_at)\n` +
        `VALUES ($1, $2, $3, NOW(), NOW())\n` +
        `ON CONFLICT (session_token) DO UPDATE SET expires = EXCLUDED.expires, updated_at = NOW()`,
        [data.sessionToken, userId, data.expires],
      );

      return { sessionToken: data.sessionToken, workspaceId };
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during test session creation');
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const pool = this.getPool();
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

export const dbAdapter = new DbAdapterBridge();

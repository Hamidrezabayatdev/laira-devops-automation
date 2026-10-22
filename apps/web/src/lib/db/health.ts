import { dbAdapter } from './adapter-bridge';

/**
 * Health check helpers for liveness and readiness probes.
 * Adheres strictly to security rule: NEVER expose connection strings, credentials, or internal errors.
 */

export interface LiveHealthStatus {
  status: 'ok';
  timestamp: string;
  uptimeSeconds: number;
}

export interface ReadyHealthStatus {
  status: 'ready' | 'not_ready';
  timestamp: string;
  database: {
    status: 'connected' | 'connecting' | 'disconnected';
    safeMessage: string;
  };
  worker: {
    heartbeat: 'active' | 'pending';
    lastHeartbeat?: string;
  };
}

const processStartTime = Date.now();

export function getLivenessStatus(): LiveHealthStatus {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - processStartTime) / 1000),
  };
}

export async function getReadinessStatus(): Promise<ReadyHealthStatus> {
  const now = new Date().toISOString();

  let dbStatus: 'connected' | 'connecting' | 'disconnected' = 'connected';
  let safeMessage = 'مخزن داده آماده خدمت‌رسانی است';

  try {
    const isHealthy = await dbAdapter.checkHealth();
    if (!isHealthy) {
      dbStatus = 'disconnected';
      safeMessage = 'عدم پاسخگویی سرویس پایگاه‌داده (Database ping failed)';
    }
  } catch {
    dbStatus = 'disconnected';
    safeMessage = 'خطا در برقراری اتصال با پایگاه‌داده (خطای حساس حذف شد)';
  }

  const isDbConfigured = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

  return {
    status: dbStatus === 'connected' ? 'ready' : 'not_ready',
    timestamp: now,
    database: {
      status: dbStatus,
      safeMessage: isDbConfigured
        ? safeMessage
        : 'در حال استفاده از مخزن داده محلی (DATABASE_URL تنظیم نشده است)',
    },
    worker: {
      heartbeat: 'active',
      lastHeartbeat: now,
    },
  };
}

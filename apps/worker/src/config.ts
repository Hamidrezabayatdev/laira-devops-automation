import os from 'node:os';

export function parseBoundedPositiveInt(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  const min = options?.min ?? 1;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export function parseBoundedNonNegativeInt(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  const min = options?.min ?? 0;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  hostname: string;
  pid: number;
  heartbeatIntervalMs: number;
  outboxIntervalMs: number;
  pgbossSchema: string;
  runLeaseTimeoutSeconds: number;
  pgbossExpireSeconds: number;
  pgbossSuperviseIntervalSeconds?: number;
  fixtureStepDelayMs: number;
}

export function loadWorkerConfig(): WorkerConfig {
  const databaseUrl =
    process.env.DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    '';

  const hostname = os.hostname();
  const pid = process.pid;
  const workerId = process.env.WORKER_ID || `worker_${hostname}_${pid}`;

  const heartbeatIntervalMs = parseBoundedPositiveInt(
    process.env.HEARTBEAT_INTERVAL_MS,
    10000,
    { min: 100, max: 3600000 }
  );

  const outboxIntervalMs = parseBoundedPositiveInt(
    process.env.OUTBOX_INTERVAL_MS,
    1000,
    { min: 50, max: 3600000 }
  );

  const runLeaseTimeoutSeconds = parseBoundedPositiveInt(
    process.env.RUN_LEASE_TIMEOUT_SECONDS,
    30,
    { min: 1, max: 86400 }
  );

  const pgbossExpireSeconds = parseBoundedPositiveInt(
    process.env.PGBOSS_EXPIRE_SECONDS,
    300,
    { min: 1, max: 604800 }
  );

  const rawSupervise = process.env.PGBOSS_SUPERVISE_INTERVAL_SECONDS;
  let pgbossSuperviseIntervalSeconds: number | undefined = undefined;
  if (rawSupervise !== undefined && rawSupervise.trim() !== '') {
    const parsed = parseBoundedPositiveInt(rawSupervise, -1, { min: 1, max: 3600 });
    if (parsed > 0) {
      pgbossSuperviseIntervalSeconds = parsed;
    }
  }

  const fixtureStepDelayMs = parseBoundedNonNegativeInt(
    process.env.TEST_FIXTURE_STEP_DELAY_MS,
    0,
    { min: 0, max: 60000 }
  );

  return {
    databaseUrl,
    workerId,
    hostname,
    pid,
    heartbeatIntervalMs,
    outboxIntervalMs,
    pgbossSchema: process.env.PGBOSS_SCHEMA || 'pgboss',
    runLeaseTimeoutSeconds,
    pgbossExpireSeconds,
    ...(pgbossSuperviseIntervalSeconds !== undefined
      ? { pgbossSuperviseIntervalSeconds }
      : {}),
    fixtureStepDelayMs,
  };
}

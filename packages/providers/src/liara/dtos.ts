import type { SafeLiaraApp, SafeLiaraAppDetail, SafeLiaraRelease } from './types.js';

const MAX_ID_LENGTH = 128;
const MAX_SLUG_LENGTH = 64;
const MAX_STRING_LENGTH = 64;
const MAX_ENV_KEYS = 1000;
const SLUG_REGEX = /^[a-z0-9-_]+$/i;

/**
 * Strips secret fields with allowlisted safe DTO immediately.
 * Enforces strict typechecks, bounds, and string length caps.
 */
export function toSafeLiaraApp(raw: unknown): SafeLiaraApp {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid app data: expected a JSON object');
  }

  const data = raw as Record<string, unknown>;

  const rawId = data._id ?? data.id;
  const rawProjectId = data.project_id ?? data.projectId ?? data.project ?? data.name;

  if (typeof rawProjectId !== 'string' || !rawProjectId.trim()) {
    throw new Error('Invalid app data: missing or non-string project_id slug');
  }

  const projectId = rawProjectId.trim().slice(0, MAX_SLUG_LENGTH);
  if (!SLUG_REGEX.test(projectId)) {
    throw new Error(`Invalid app data: project_id "${projectId}" contains invalid characters`);
  }

  const internalId = typeof rawId === 'string' ? rawId.slice(0, MAX_ID_LENGTH) : '';

  const rawStatus = typeof data.status === 'string' ? data.status.slice(0, MAX_STRING_LENGTH) : 'unknown';
  const rawType = typeof data.type === 'string'
    ? data.type.slice(0, MAX_STRING_LENGTH)
    : typeof data.platform === 'string'
      ? data.platform.slice(0, MAX_STRING_LENGTH)
      : 'unknown';
  const rawPlanCandidate = data.planID ?? data.plan;
  const rawPlan = typeof rawPlanCandidate === 'string' && rawPlanCandidate.trim()
    ? rawPlanCandidate.trim().slice(0, MAX_STRING_LENGTH)
    : 'unknown';

  let scale = 1;
  if (typeof data.scale === 'number' && Number.isFinite(data.scale) && data.scale >= 0) {
    scale = Math.min(Math.floor(data.scale), 1000);
  } else if (typeof data.scale === 'string') {
    const parsedScale = Number.parseInt(data.scale, 10);
    if (!Number.isNaN(parsedScale) && parsedScale >= 0) {
      scale = Math.min(parsedScale, 1000);
    }
  }

  const rawCreatedAt = typeof data.created_at === 'string'
    ? data.created_at.slice(0, MAX_STRING_LENGTH)
    : typeof data.createdAt === 'string'
      ? data.createdAt.slice(0, MAX_STRING_LENGTH)
      : new Date().toISOString();

  return {
    internalId,
    projectId,
    status: rawStatus,
    type: rawType,
    plan: rawPlan,
    scale,
    createdAt: rawCreatedAt,
  };
}

export function toSafeLiaraAppDetail(raw: unknown): SafeLiaraAppDetail {
  const base = toSafeLiaraApp(raw);
  const data = raw as Record<string, unknown>;

  // Extract env keys ONLY; completely strip and discard env values
  const envKeys: string[] = [];
  let hasEnvs = false;

  if (Array.isArray(data.envs)) {
    hasEnvs = data.envs.length > 0;
    for (const item of data.envs) {
      if (item && typeof item === 'object' && 'key' in item && typeof (item as any).key === 'string') {
        const key = String((item as any).key).trim().slice(0, MAX_ID_LENGTH);
        if (key && envKeys.length < MAX_ENV_KEYS) {
          envKeys.push(key);
        }
      }
    }
  } else if (typeof data.envs === 'object' && data.envs !== null) {
    const keys = Object.keys(data.envs);
    hasEnvs = keys.length > 0;
    for (const k of keys) {
      if (envKeys.length < MAX_ENV_KEYS) {
        envKeys.push(k.trim().slice(0, MAX_ID_LENGTH));
      }
    }
  }

  let port: number | undefined;
  if (typeof data.port === 'number' && Number.isInteger(data.port) && data.port > 0 && data.port <= 65535) {
    port = data.port;
  }

  let nodeVersion: string | undefined;
  if (typeof data.nodeVersion === 'string') {
    nodeVersion = data.nodeVersion.slice(0, 32);
  }

  let planID: string | undefined;
  if (typeof data.planID === 'string' && data.planID.trim()) {
    planID = data.planID.trim().slice(0, MAX_ID_LENGTH);
  } else if (base.plan !== 'unknown') {
    planID = base.plan;
  }

  const rawBundleCandidate = data.bundlePlanID ?? data.bundlePlanId ?? data.bundle_plan_id;
  let bundlePlanID: string | undefined;
  if (typeof rawBundleCandidate === 'string' && rawBundleCandidate.trim()) {
    bundlePlanID = rawBundleCandidate.trim().slice(0, MAX_ID_LENGTH);
  }

  return {
    ...base,
    port,
    nodeVersion,
    isDeploying: Boolean(data.isDeploying),
    planID,
    planId: planID,
    bundlePlanID,
    bundlePlanId: bundlePlanID,
    envKeys,
    hasEnvs,
  };
}

export function toSafeLiaraRelease(raw: unknown): SafeLiaraRelease {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid release data: expected a JSON object');
  }

  const data = raw as Record<string, unknown>;
  const rawId = data._id ?? data.id;
  const rawProjectId = data.project_id ?? data.projectId ?? data.project;

  const id = typeof rawId === 'string' ? rawId.slice(0, MAX_ID_LENGTH) : '';
  const projectId = typeof rawProjectId === 'string' ? rawProjectId.slice(0, MAX_SLUG_LENGTH) : '';

  if (!id && !projectId) {
    throw new Error('Invalid release data: missing release id or project_id');
  }

  const state = typeof data.state === 'string'
    ? data.state.slice(0, MAX_STRING_LENGTH)
    : typeof data.status === 'string'
      ? data.status.slice(0, MAX_STRING_LENGTH)
      : 'unknown';

  const tag = typeof data.tag === 'string' ? data.tag.slice(0, MAX_STRING_LENGTH) : undefined;
  const createdAt = typeof data.created_at === 'string'
    ? data.created_at.slice(0, MAX_STRING_LENGTH)
    : typeof data.createdAt === 'string'
      ? data.createdAt.slice(0, MAX_STRING_LENGTH)
      : new Date().toISOString();

  return {
    id,
    projectId,
    state,
    tag,
    createdAt,
  };
}

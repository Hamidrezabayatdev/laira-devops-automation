import {
  DeploymentProposalSchema,
  DeployProposalSchema,
  RestartProposalSchema,
  DeploymentRepositorySchema,
  LiaraPlatformSchema,
  LIARA_PLATFORMS,
  hashDeploymentProposal,
  type DeploymentProposal,
  type DeployProposal,
  type RestartProposal,
  type DeploymentRepository,
  type LiaraPlatform,
} from '@laira/domain';
import {
  createRun as dbCreateRun,
  getRun as dbGetRun,
  getRunEvents as dbGetRunEvents,
  getDatabasePool,
  type Run,
  type RunEvent,
} from '@laira/db';
import { DatabaseUnavailableError } from '@/lib/db/adapter-bridge';

// Re-export strict domain schemas and helpers from @laira/domain
export {
  DeploymentProposalSchema,
  DeployProposalSchema,
  RestartProposalSchema,
  DeploymentRepositorySchema,
  LiaraPlatformSchema,
  LIARA_PLATFORMS,
  hashDeploymentProposal,
  type DeploymentProposal,
  type DeployProposal,
  type RestartProposal,
  type DeploymentRepository,
  type LiaraPlatform,
};

export const ALLOWED_ASSISTANT_RUN_TYPES = ['agent_task', 'agent_action'] as const;
export type AllowedAssistantRunType = (typeof ALLOWED_ASSISTANT_RUN_TYPES)[number];

export const ALLOWED_PROVIDER_STATES = [
  'READY',
  'FAILED',
  'BUILDING',
  'PENDING',
  'CREATED',
  'UNKNOWN',
  'healthy',
  'running',
  'stopped',
] as const;
export type AllowedProviderState = (typeof ALLOWED_PROVIDER_STATES)[number];
const ALLOWED_PROVIDER_STATE_SET = new Set<string>(ALLOWED_PROVIDER_STATES);

export interface AgentTaskRepository {
  owner: string;
  repo: string;
  ref?: string;
}

export interface AgentTaskInput {
  task: string;
  repository?: AgentTaskRepository;
}

export interface AgentTaskVerification {
  releaseId?: string;
  providerState?: string;
  httpStatus?: number;
  providerAccepted?: boolean;
}

export interface AgentTaskOutput {
  message?: string;
  proposedAction?: DeploymentProposal;
  proposalHash?: string;
  verificationPhase?: string;
  phase?: string;
  verified?: boolean;
  outcomeUnknown?: boolean;
  releaseId?: string;
  providerState?: string;
  httpStatus?: number;
  verification?: AgentTaskVerification;
  [key: string]: unknown;
}

export interface AgentProgressEvent {
  seq: number;
  type: string;
  message: string;
  step?: string;
  createdAt?: string;
}

export interface AssistantRunDetail {
  runId: string;
  status: string;
  type: string;
  task: string;
  repository?: AgentTaskRepository;
  output?: {
    message?: string;
    proposedAction?: DeploymentProposal;
    proposalHash?: string;
    verificationPhase?: string;
    phase?: string;
    verified?: boolean;
    outcomeUnknown?: boolean;
    releaseId?: string;
    providerState?: string;
    httpStatus?: number;
    verification?: AgentTaskVerification;
  };
  verificationPhase?: string;
  progress: AgentProgressEvent[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const GITHUB_REPO_REGEX =
  /^https:\/\/github\.com\/([a-zA-Z0-9_.-]{1,39})\/([a-zA-Z0-9_.-]{1,100}?)(?:\.git)?(?:\/(?:tree|blob)\/([a-zA-Z0-9_.\-\/]+))?(?:#(.*))?$/i;

/**
 * Validates a Git reference string: length <= 200, no control characters.
 */
function isValidGitRef(ref: string): boolean {
  if (ref.length > 200) return false;
  // Reject control characters (0x00-0x1F, 0x7F)
  if (/[\x00-\x1f\x7f]/.test(ref)) return false;
  return true;
}

/**
 * Strictly parses a repository string or object to only allow https://github.com/owner/repo.
 * Non-https, non-github.com, dot/dot-dot path traversal, or arbitrary hosts are rejected.
 */
export function parseGitHubRepoUrl(raw: unknown): {
  valid: boolean;
  repository?: AgentTaskRepository;
  error?: string;
} {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, repository: undefined };
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) {
      return { valid: true, repository: undefined };
    }

    if (!trimmed.toLowerCase().startsWith('https://github.com/')) {
      return {
        valid: false,
        error: 'آدرس مخزن باید یک نشانی معتبر گیت‌هاب با پروتکل امن https://github.com/owner/repo باشد',
      };
    }

    const match = trimmed.match(GITHUB_REPO_REGEX);
    if (!match) {
      return {
        valid: false,
        error: 'ساختار نشانی مخزن نامعتبر است. فرمت مورد انتظار: https://github.com/owner/repo',
      };
    }

    const owner = match[1];
    const repo = match[2];
    const rawRef = match[3] || match[4] || undefined;

    if (!owner || !repo) {
      return {
        valid: false,
        error: 'نام مالک یا نام مخزن در آدرس گیت‌هاب مشخص نیست',
      };
    }

    // Reject '.' and '..'
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      return {
        valid: false,
        error: 'نام مالک یا نام مخزن نمی‌تواند . یا .. باشد',
      };
    }

    if (rawRef && !isValidGitRef(rawRef)) {
      return {
        valid: false,
        error: 'شاخه یا رفرنس گیت‌هاب نامعتبر است (حداکثر ۲۰۰ کاراکتر بدون کاراکترهای کنترلی)',
      };
    }

    return {
      valid: true,
      repository: {
        owner,
        repo,
        ...(rawRef ? { ref: rawRef } : {}),
      },
    };
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const allowedKeys = new Set(['owner', 'repo', 'ref']);
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) {
        return { valid: false, error: `فیلد غیرمجاز در مشخصات مخزن: ${key}` };
      }
    }

    if (typeof obj.owner !== 'string' || !obj.owner.trim()) {
      return { valid: false, error: 'نام مالک مخزن (owner) نامعتبر است' };
    }
    if (typeof obj.repo !== 'string' || !obj.repo.trim()) {
      return { valid: false, error: 'نام مخزن (repo) نامعتبر است' };
    }

    const owner = obj.owner.trim();
    const repo = obj.repo.trim().replace(/\.git$/i, '');
    const ref = typeof obj.ref === 'string' && obj.ref.trim() ? obj.ref.trim() : undefined;

    // Reject '.' and '..'
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      return { valid: false, error: 'نام مالک یا نام مخزن نمی‌تواند . یا .. باشد' };
    }

    if (!/^[a-zA-Z0-9_.-]{1,39}$/.test(owner)) {
      return { valid: false, error: 'نام مالک مخزن حاوی کاراکترهای نامعتبر است' };
    }
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(repo)) {
      return { valid: false, error: 'نام مخزن حاوی کاراکترهای نامعتبر است' };
    }

    if (ref && !isValidGitRef(ref)) {
      return {
        valid: false,
        error: 'شاخه یا رفرنس گیت‌هاب نامعتبر است (حداکثر ۲۰۰ کاراکتر بدون کاراکترهای کنترلی)',
      };
    }

    return {
      valid: true,
      repository: {
        owner,
        repo,
        ...(ref ? { ref } : {}),
      },
    };
  }

  return {
    valid: false,
    error: 'فرمت مشخصات مخزن نامعتبر است',
  };
}

const PROHIBITED_AUTHORITY_KEYS = [
  'workspaceId',
  'workspace_id',
  'ownerId',
  'owner_id',
  'userId',
  'user_id',
  'role',
  'sessionToken',
  'session_token',
];

/**
 * Validates the incoming JSON body for POST /api/assistant.
 * Enforces task max 4000 characters and bounded/optional repository.
 * Rejects caller-supplied authority keys (workspaceId, role, etc.).
 */
export function validateAgentTaskInput(body: unknown):
  | { valid: true; input: AgentTaskInput }
  | { valid: false; error: string; code: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      error: 'بدنه درخواست باید یک شیء JSON معتبر باشد',
      code: 'INVALID_PAYLOAD',
    };
  }

  const raw = body as Record<string, unknown>;

  // Reject authority keys explicitly
  for (const key of PROHIBITED_AUTHORITY_KEYS) {
    if (key in raw) {
      return {
        valid: false,
        error: `ارسال فیلد مدیریتی '${key}' در بدنه درخواست مجاز نیست`,
        code: 'UNAUTHORIZED_FIELD',
      };
    }
  }

  if (raw.task === undefined || typeof raw.task !== 'string') {
    return {
      valid: false,
      error: 'متن درخواست (task) الزامی است و باید رشته متنی باشد',
      code: 'INVALID_TASK',
    };
  }

  const trimmedTask = raw.task.trim();
  if (!trimmedTask) {
    return {
      valid: false,
      error: 'متن درخواست نباید خالی باشد',
      code: 'INVALID_TASK',
    };
  }

  if (trimmedTask.length > 4000) {
    return {
      valid: false,
      error: 'طول متن درخواست نباید بیشتر از ۴۰۰۰ کاراکتر باشد',
      code: 'TASK_TOO_LONG',
    };
  }

  const rawRepo = raw.repository ?? raw.repositoryUrl;
  const repoResult = parseGitHubRepoUrl(rawRepo);
  if (!repoResult.valid) {
    return {
      valid: false,
      error: repoResult.error || 'آدرس مخزن نامعتبر است',
      code: 'INVALID_REPOSITORY',
    };
  }

  return {
    valid: true,
    input: {
      task: trimmedTask,
      ...(repoResult.repository ? { repository: repoResult.repository } : {}),
    },
  };
}

/**
 * Sanitizes run output to an allowlist of fields (message, verified proposal, verification phase).
 * Validates proposal schema via strict @laira/domain DeploymentProposalSchema and verifies hash.
 * Excludes arbitrary internal keys or secret leakage.
 */
export function sanitizeAgentOutput(
  rawOutput: unknown,
  runStatus?: string,
): AgentTaskOutput | undefined {
  if (!rawOutput || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) {
    if (runStatus === 'outcome_unknown') {
      return { outcomeUnknown: true };
    }
    return undefined;
  }

  const raw = rawOutput as Record<string, unknown>;
  const result: AgentTaskOutput = {};

  if (typeof raw.message === 'string') {
    result.message = raw.message.slice(0, 50000);
  }

  if (raw.proposedAction) {
    const parseResult = DeploymentProposalSchema.safeParse(raw.proposedAction);
    if (parseResult.success) {
      const computedHash = hashDeploymentProposal(parseResult.data);
      // Strictly require proposalHash consistency with domain canonical hash
      if (typeof raw.proposalHash === 'string' && raw.proposalHash === computedHash) {
        result.proposedAction = parseResult.data;
        result.proposalHash = computedHash;
      }
    }
  }

  // Support nested verification object (worker-shaped) alongside legacy top-level fields
  // Precedence: explicit nested verification object fields, falling back to top-level fields
  const rawVerification =
    raw.verification && typeof raw.verification === 'object' && !Array.isArray(raw.verification)
      ? (raw.verification as Record<string, unknown>)
      : undefined;

  // Verification phase for execution runs (agent_action)
  const rawPhase =
    raw.verificationPhase ||
    raw.phase ||
    raw.step ||
    (typeof rawVerification?.phase === 'string' ? rawVerification.phase : undefined);
  if (typeof rawPhase === 'string' && rawPhase.length <= 100) {
    result.verificationPhase = rawPhase;
    result.phase = rawPhase;
  }

  // releaseId: identifier (string, letters, numbers, hyphens, underscores, up to 128 chars)
  const candidateReleaseId =
    typeof rawVerification?.releaseId === 'string'
      ? rawVerification.releaseId
      : typeof raw.releaseId === 'string'
        ? raw.releaseId
        : undefined;

  let validReleaseId: string | undefined;
  if (candidateReleaseId && /^[a-zA-Z0-9_-]{1,128}$/.test(candidateReleaseId)) {
    result.releaseId = candidateReleaseId;
    validReleaseId = candidateReleaseId;
  }

  // providerState: allowlist of known uppercase and safe operational states
  const candidateProviderState =
    typeof rawVerification?.providerState === 'string'
      ? rawVerification.providerState
      : typeof raw.providerState === 'string'
        ? raw.providerState
        : undefined;

  let validProviderState: string | undefined;
  if (candidateProviderState && ALLOWED_PROVIDER_STATE_SET.has(candidateProviderState)) {
    result.providerState = candidateProviderState;
    validProviderState = candidateProviderState;
  }

  // httpStatus: integer between 100 and 599
  const candidateHttpStatus =
    typeof rawVerification?.httpStatus === 'number'
      ? rawVerification.httpStatus
      : typeof raw.httpStatus === 'number'
        ? raw.httpStatus
        : undefined;

  let validHttpStatus: number | undefined;
  if (
    typeof candidateHttpStatus === 'number' &&
    Number.isInteger(candidateHttpStatus) &&
    candidateHttpStatus >= 100 &&
    candidateHttpStatus <= 599
  ) {
    result.httpStatus = candidateHttpStatus;
    validHttpStatus = candidateHttpStatus;
  }

  let validProviderAccepted: boolean | undefined;
  if (typeof rawVerification?.providerAccepted === 'boolean') {
    validProviderAccepted = rawVerification.providerAccepted;
  }

  if (
    validReleaseId ||
    validProviderState ||
    validHttpStatus !== undefined ||
    validProviderAccepted !== undefined
  ) {
    result.verification = {
      ...(validReleaseId ? { releaseId: validReleaseId } : {}),
      ...(validProviderState ? { providerState: validProviderState } : {}),
      ...(validHttpStatus !== undefined ? { httpStatus: validHttpStatus } : {}),
      ...(validProviderAccepted !== undefined ? { providerAccepted: validProviderAccepted } : {}),
    };
  }

  if (typeof raw.verified === 'boolean') {
    result.verified = raw.verified;
  }

  if (runStatus === 'outcome_unknown' || raw.outcomeUnknown === true) {
    result.outcomeUnknown = true;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Sanitizes progress events so only known safe fields are included.
 */
export function sanitizeProgressEvents(rawEvents: unknown[]): AgentProgressEvent[] {
  if (!Array.isArray(rawEvents)) return [];

  return rawEvents.map((evt: any) => {
    const payload = evt?.payload && typeof evt.payload === 'object' ? evt.payload : {};
    let message = '';
    if (typeof payload.message === 'string') {
      message = payload.message.slice(0, 1000);
    } else if (typeof payload.text === 'string') {
      message = payload.text.slice(0, 1000);
    }

    const step =
      typeof payload.step === 'string' && payload.step.length <= 100
        ? payload.step
        : undefined;

    let createdAt: string | undefined;
    if (typeof evt.createdAt === 'string') {
      createdAt = evt.createdAt;
    } else if (evt.createdAt instanceof Date) {
      createdAt = evt.createdAt.toISOString();
    }

    return {
      seq: typeof evt.seq === 'number' ? evt.seq : 0,
      type: typeof evt.type === 'string' ? evt.type.slice(0, 50) : 'unknown',
      message,
      ...(step ? { step } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  });
}

export interface AssistantDbAdapter {
  createAgentRun(
    workspaceId: string,
    input: AgentTaskInput,
  ): Promise<{ id: string; status: string; createdAt: Date | string }>;
  getAgentRun(
    workspaceId: string,
    runId: string,
  ): Promise<Run | null>;
  getAgentRunEvents(
    workspaceId: string,
    runId: string,
  ): Promise<RunEvent[]>;
}

export const defaultAssistantDbAdapter: AssistantDbAdapter = {
  async createAgentRun(workspaceId, input) {
    let pool;
    try {
      pool = getDatabasePool();
    } catch {
      throw new DatabaseUnavailableError('Database connection pool unavailable');
    }
    try {
      const run = await dbCreateRun(
        pool,
        { workspaceId },
        {
          type: 'agent_task',
          input: {
            task: input.task,
            ...(input.repository ? { repository: input.repository } : {}),
          },
          initialMessage: `وظیفه دستیار هوشمند ثبت گردید: ${input.task.slice(0, 80)}`,
        },
      );
      return run;
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during assistant run creation');
    }
  },

  async getAgentRun(workspaceId, runId) {
    let pool;
    try {
      pool = getDatabasePool();
    } catch {
      throw new DatabaseUnavailableError('Database connection pool unavailable');
    }
    try {
      return await dbGetRun(pool, { workspaceId }, runId);
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during assistant run retrieval');
    }
  },

  async getAgentRunEvents(workspaceId, runId) {
    let pool;
    try {
      pool = getDatabasePool();
    } catch {
      throw new DatabaseUnavailableError('Database connection pool unavailable');
    }
    try {
      return await dbGetRunEvents(pool, { workspaceId }, runId);
    } catch (err: unknown) {
      if (err instanceof DatabaseUnavailableError) throw err;
      throw new DatabaseUnavailableError('Database operation failed during assistant run events retrieval');
    }
  },
};

let activeAssistantDbAdapter: AssistantDbAdapter = defaultAssistantDbAdapter;

export function getAssistantDbAdapter(): AssistantDbAdapter {
  return activeAssistantDbAdapter;
}

export function setAssistantDbAdapter(adapter: AssistantDbAdapter | null) {
  activeAssistantDbAdapter = adapter || defaultAssistantDbAdapter;
}

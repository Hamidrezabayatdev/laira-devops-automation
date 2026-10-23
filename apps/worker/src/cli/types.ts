import type pg from 'pg';
import type { ImportRuntimeEnvironmentResult } from '../runtime-environment.js';
import type { MonitorCliResult } from './monitor.js';

export interface GitHubUser {
  id: string; // numeric string e.g. "152868728"
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface OperatorCliDependencies {
  env?: Record<string, string | undefined>;
  pool?: pg.Pool;
  fetchFn?: typeof fetch;
  execFn?: (cmd: string) => string;
  now?: () => Date;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  requireLocalhost?: boolean;
  requestTimeoutMs?: number;
}

export interface TaskArgs {
  repository: string;
  task: string;
  connectionId?: string;
  environmentConnectionId?: string;
  environmentCredentialVersion?: number;
}

export interface TaskResult {
  runId: string;
  status: string;
  workspaceId: string;
}

export interface StatusArgs {
  run: string;
}

export interface SafeEventSummary {
  seq: number;
  type: string;
  step?: string;
  message?: string;
  createdAt: string;
}

export interface SafeProposalBase {
  connectionId: string;
  credentialVersion: number;
  appId: string;
  proposalHash: string;
}

export interface SafeDeployProposal extends SafeProposalBase {
  kind: 'deploy';
  platform: string;
  previousPlatform?: string;
  port: number;
  repository: {
    owner: string;
    repo: string;
    commitSha: string;
  };
  bundleDigest: string;
  runtimeEnvironment?: {
    connectionId: string;
    credentialVersion: number;
  };
  buildLocation?: 'iran' | 'germany';
  platformConfig?: {
    mirror?: boolean;
  };
}

export interface SafeRestartProposal extends SafeProposalBase {
  kind: 'restart';
}

export interface SafeCreateAppProposal extends SafeProposalBase {
  kind: 'create_app';
  platform: string;
  planId: string;
  bundlePlanId: string;
  networkId: string;
  cost: {
    currency: 'IRR';
    hourly: number;
    monthly: number;
    sourceUrl: string;
    checkedAt: string;
  };
}

export type SafeProposal =
  | SafeDeployProposal
  | SafeRestartProposal
  | SafeCreateAppProposal;

export interface StatusResult {
  runId: string;
  status: string;
  type: string;
  phase?: string;
  message?: string;
  proposal?: SafeProposal;
  events: SafeEventSummary[];
  error?: {
    code?: string;
    message: string;
  };
}

export interface ConnectLiaraArgs {
  teamId?: string;
  name?: string;
}

export interface ConnectLiaraResult {
  connectionId: string;
  status: 'configured_unverified';
  workspaceId: string;
  hasTeamId: boolean;
}

export interface ApproveArgs {
  run: string;
  hash: string;
}

export interface ApproveResult {
  executionRunId: string;
  status: string;
  sourceRunId: string;
  proposalHash: string;
}

export interface CliExecutionResult {
  command: 'task' | 'status' | 'connect-liara' | 'approve' | 'import-environment' | 'monitor' | 'help';
  data?: TaskResult | StatusResult | ConnectLiaraResult | ApproveResult | ImportRuntimeEnvironmentResult | MonitorCliResult;
  message: string;
}

/**
 * Liara Provider Types and Safe DTO Interfaces
 */

export const LIARA_API_ORIGIN = 'https://api.liara.ir';

export interface LiaraConnectionConfig {
  apiKey: string;
  teamId?: string;
  timeoutMs?: number; // bounded timeout (default 15000 ms)
  maxResponseSizeBytes?: number; // bounded response size (default 1 MiB)
  fetchFn?: typeof fetch;
}

export interface SafeLiaraApp {
  /** Internal provider ID, e.g. "651a..." */
  internalId: string;
  /** Project slug identifier, e.g. "my-app" */
  projectId: string;
  status: string;
  type: string;
  plan: string;
  scale: number;
  createdAt: string;
}

export interface SafeLiaraAppDetail extends SafeLiaraApp {
  port?: number;
  nodeVersion?: string;
  isDeploying?: boolean;
  planID?: string;
  planId?: string;
  bundlePlanID?: string;
  bundlePlanId?: string;
  /**
   * Safe allowlisted env keys ONLY.
   * Values are stripped immediately to prevent credential/secret leakage.
   */
  envKeys: string[];
  hasEnvs: boolean;
}

export interface SafeLiaraRelease {
  id: string;
  projectId: string;
  state: string;
  tag?: string;
  createdAt: string;
}

export type LiaraCapabilityStatus = 'supported' | 'unsupported' | 'unverified';

export interface SafeLiaraCapability {
  capability: string;
  status: LiaraCapabilityStatus;
  readOnly: boolean;
  notes: string;
}

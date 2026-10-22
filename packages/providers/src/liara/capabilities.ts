import type { SafeLiaraCapability } from './types.js';

export function getLiaraCapabilities(): SafeLiaraCapability[] {
  return [
    {
      capability: 'apps.list',
      status: 'supported',
      readOnly: true,
      notes: 'Documented and planning account-tested (empty list verified). Reads real metadata and project_id slug while preserving internal id.',
    },
    {
      capability: 'apps.detail',
      status: 'supported',
      readOnly: true,
      notes: 'Documented. Reads metadata with all environment values and secret fields stripped immediately.',
    },
    {
      capability: 'releases.list',
      status: 'unverified',
      readOnly: true,
      notes: 'Documented baseline only. Raw fixtures do not prove releases live on real disposable resources in Phase 0.',
    },
    {
      capability: 'apps.deploy',
      status: 'unsupported',
      readOnly: false,
      notes: 'Mutation operation. Blocked in Phase 0 read-only adapter; requires Phase 1 immutable ActionPlan approval.',
    },
    {
      capability: 'apps.restart',
      status: 'unsupported',
      readOnly: false,
      notes: 'Mutation operation. Blocked in Phase 0 read-only adapter.',
    },
    {
      capability: 'apps.power',
      status: 'unsupported',
      readOnly: false,
      notes: 'Mutation operation. Blocked in Phase 0 read-only adapter.',
    },
    {
      capability: 'apps.resize',
      status: 'unsupported',
      readOnly: false,
      notes: 'Mutation operation. Blocked in Phase 0 read-only adapter.',
    },
    {
      capability: 'databases.manage',
      status: 'unverified',
      readOnly: false,
      notes: 'Unverified capability in Phase 0. Requires dedicated account testing or human handoff.',
    },
    {
      capability: 'domains.tls',
      status: 'unverified',
      readOnly: false,
      notes: 'Unverified capability in Phase 0. Requires dedicated account testing or human handoff.',
    },
    {
      capability: 'disks.storage',
      status: 'unverified',
      readOnly: false,
      notes: 'Unverified capability in Phase 0. Requires dedicated account testing or human handoff.',
    },
  ];
}

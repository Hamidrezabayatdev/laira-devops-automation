/**
 * Liara Provider Fixtures
 * Includes deliberate canary secrets in raw responses and error payloads
 * to verify that safe DTOs and safe errors strip them 100% of the time.
 */

export const CANARY_SECRETS = {
  apiToken: 'LIARA_API_TOKEN_CANARY_XYZ_987654321',
  dbPassword: 'CANARY_DATABASE_PASSWORD_SUPER_SECRET_12345',
  jwtSecret: 'CANARY_JWT_SECRET_DO_NOT_EXPOSE_ABCDEF',
  envValue: 'CANARY_DATABASE_URL_postgres://user:secretpass@db.liara.ir:5432/main',
};

export const RAW_LIARA_PROJECTS_RESPONSE = [
  {
    _id: 'liara-app-internal-id-001',
    project_id: 'my-frontend-app',
    status: 'running',
    type: 'nodejs',
    plan: 'standard',
    scale: 2,
    created_at: '2026-10-01T12:00:00.000Z',
    // sensitive raw field that must be stripped
    secret_deploy_token: CANARY_SECRETS.apiToken,
  },
  {
    _id: 'liara-app-internal-id-002',
    project_id: 'my-backend-api',
    status: 'stopped',
    type: 'docker',
    plan: 'pro',
    scale: 1,
    created_at: '2026-10-05T08:30:00.000Z',
  },
];

export const RAW_LIARA_PROJECT_DETAIL_RESPONSE = {
  project: {
    _id: 'liara-app-internal-id-001',
    project_id: 'my-frontend-app',
    status: 'running',
    type: 'nodejs',
    plan: 'standard',
    scale: 2,
    port: 3000,
    nodeVersion: '24',
    isDeploying: false,
    created_at: '2026-10-01T12:00:00.000Z',
    // Environment variables containing canary secrets!
    // Safe DTO MUST only preserve key names ('DATABASE_URL', 'JWT_SECRET')
    // and MUST completely discard the values.
    envs: [
      { key: 'DATABASE_URL', value: CANARY_SECRETS.envValue },
      { key: 'JWT_SECRET', value: CANARY_SECRETS.jwtSecret },
      { key: 'NODE_ENV', value: 'production' },
    ],
    // Additional sensitive provider metadata that must never be exposed
    internal_cluster_ip: '10.0.0.12',
    provider_master_key: CANARY_SECRETS.apiToken,
    raw_credentials: {
      password: CANARY_SECRETS.dbPassword,
    },
  },
};

export const RAW_LIARA_RELEASES_RESPONSE = {
  releases: [
    {
      _id: 'release-internal-id-101',
      project_id: 'my-frontend-app',
      state: 'ready',
      tag: 'v1.2.0',
      created_at: '2026-10-15T10:00:00.000Z',
      // Internal build token
      build_token: CANARY_SECRETS.apiToken,
    },
    {
      _id: 'release-internal-id-100',
      project_id: 'my-frontend-app',
      state: 'ready',
      tag: 'v1.1.0',
      created_at: '2026-10-10T10:00:00.000Z',
    },
  ],
};

export const RAW_LIARA_401_BODY = JSON.stringify({
  code: 'UNAUTHORIZED',
  message: `Authentication failed for token ${CANARY_SECRETS.apiToken}`,
  debug: {
    provided_secret: CANARY_SECRETS.apiToken,
  },
});

export const RAW_LIARA_500_BODY = JSON.stringify({
  code: 'INTERNAL_SERVER_ERROR',
  message: 'Internal server error occurred',
  stack: `ConnectionError: failed connecting with ${CANARY_SECRETS.dbPassword}`,
});

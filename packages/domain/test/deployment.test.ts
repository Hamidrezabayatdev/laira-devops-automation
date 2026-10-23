import { describe, it, expect } from 'vitest';
import {
  DeploymentProposalSchema,
  DeployProposalSchema,
  RestartProposalSchema,
  CreateAppProposalSchema,
  AppCostSchema,
  ApprovedAppPlanSchema,
  LiaraPlatformSchema,
  BuildLocationSchema,
  PlatformConfigSchema,
  parseInspectedLiaraConfig,
  hashDeploymentProposal,
  type DeployProposal,
  type RestartProposal,
  type CreateAppProposal,
} from '../src/index.js';

describe('DeploymentProposal Domain Model', () => {
  const validDeployProposal: DeployProposal = {
    kind: 'deploy',
    connectionId: 'conn_liara_12345',
    credentialVersion: 1,
    appId: 'payment-svc',
    platform: 'node',
    port: 3000,
    repository: {
      owner: 'acme-corp',
      repo: 'payment-service',
      commitSha: 'a1b2c3d4e5f678901234567890abcdef12345678',
    },
    bundleDigest: 'sha256:' + 'e'.repeat(64),
  };

  const validRestartProposal: RestartProposal = {
    kind: 'restart',
    connectionId: 'conn_liara_12345',
    credentialVersion: 2,
    appId: 'payment-svc',
  };

  const validCreateAppProposal: CreateAppProposal = {
    kind: 'create_app',
    connectionId: 'conn_liara_12345',
    credentialVersion: 1,
    appId: 'my-new-app',
    platform: 'node',
    planId: 'standard-base-g2',
    bundlePlanId: 'basic',
    networkId: '6ad9be2707e024287d1bc47a',
    cost: {
      currency: 'IRR',
      hourly: 31944.4,
      monthly: 22999968,
      sourceUrl: 'https://api.liara.ir/v1/me',
      checkedAt: '2026-10-23T00:00:00.000Z',
    },
  };

  describe('DeployProposalSchema', () => {
    it('validates a well-formed deploy proposal', () => {
      const parsed = DeployProposalSchema.parse(validDeployProposal);
      expect(parsed).toEqual(validDeployProposal);
    });

    it('accepts all documented Liara platforms', () => {
      const platforms = [
        'node',
        'next',
        'python',
        'django',
        'flask',
        'php',
        'laravel',
        'docker',
        'go',
        'dotnet',
      ] as const;

      for (const platform of platforms) {
        const proposal = { ...validDeployProposal, platform };
        expect(DeployProposalSchema.parse(proposal).platform).toBe(platform);
        expect(LiaraPlatformSchema.parse(platform)).toBe(platform);
      }
    });

    it('accepts valid previousPlatform and rejects invalid previousPlatform', () => {
      const withPrev = DeployProposalSchema.parse({ ...validDeployProposal, previousPlatform: 'next' });
      expect(withPrev.previousPlatform).toBe('next');
      expect(() =>
        DeployProposalSchema.parse({ ...validDeployProposal, previousPlatform: 'invalid_plat' })
      ).toThrow();
    });

    it('rejects unsupported platforms', () => {
      expect(() =>
        DeployProposalSchema.parse({ ...validDeployProposal, platform: 'ruby' })
      ).toThrow();
      expect(() =>
        DeployProposalSchema.parse({ ...validDeployProposal, platform: 'java' })
      ).toThrow();
      expect(() =>
        DeployProposalSchema.parse({ ...validDeployProposal, platform: 'rust' })
      ).toThrow();
    });

    it('enforces port bounds (1..65535)', () => {
      expect(DeployProposalSchema.parse({ ...validDeployProposal, port: 1 }).port).toBe(1);
      expect(DeployProposalSchema.parse({ ...validDeployProposal, port: 65535 }).port).toBe(65535);

      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, port: 0 })).toThrow();
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, port: 65536 })).toThrow();
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, port: -80 })).toThrow();
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, port: 80.5 })).toThrow();
    });

    it('enforces appId slug constraints (3..63 lowercase alphanumeric with hyphens)', () => {
      expect(DeployProposalSchema.parse({ ...validDeployProposal, appId: 'abc' }).appId).toBe('abc');
      expect(DeployProposalSchema.parse({ ...validDeployProposal, appId: 'a'.repeat(63) }).appId).toBe('a'.repeat(63));

      // Under 3 chars
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, appId: 'ab' })).toThrow();
      // Over 63 chars
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, appId: 'a'.repeat(64) })).toThrow();
      // Uppercase characters
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, appId: 'App-Id' })).toThrow();
      // Special characters
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, appId: 'app_id' })).toThrow();
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, appId: 'app.id' })).toThrow();
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, appId: 'app id' })).toThrow();
    });

    it('enforces credentialVersion positive integer constraint', () => {
      expect(DeployProposalSchema.parse({ ...validDeployProposal, credentialVersion: 1 }).credentialVersion).toBe(1);
      expect(DeployProposalSchema.parse({ ...validDeployProposal, credentialVersion: 42 }).credentialVersion).toBe(42);

      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, credentialVersion: 0 })).toThrow();
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, credentialVersion: -1 })).toThrow();
      expect(() => DeployProposalSchema.parse({ ...validDeployProposal, credentialVersion: 1.5 })).toThrow();
    });

    it('enforces repository security constraints (owner/repo github-safe and commitSha 40 lower hex)', () => {
      // Valid commitSha
      expect(
        DeployProposalSchema.parse({
          ...validDeployProposal,
          repository: {
            ...validDeployProposal.repository,
            commitSha: '0123456789abcdef0123456789abcdef01234567',
          },
        }).repository.commitSha
      ).toBe('0123456789abcdef0123456789abcdef01234567');

      // Invalid commitSha lengths
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          repository: { ...validDeployProposal.repository, commitSha: 'a'.repeat(39) },
        })
      ).toThrow();
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          repository: { ...validDeployProposal.repository, commitSha: 'a'.repeat(41) },
        })
      ).toThrow();

      // Uppercase hex in commitSha
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          repository: { ...validDeployProposal.repository, commitSha: 'A'.repeat(40) },
        })
      ).toThrow();

      // Non-hex in commitSha
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          repository: { ...validDeployProposal.repository, commitSha: 'g'.repeat(40) },
        })
      ).toThrow();

      // Invalid repo / owner
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          repository: { ...validDeployProposal.repository, owner: 'bad/owner' },
        })
      ).toThrow();
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          repository: { ...validDeployProposal.repository, repo: 'bad space' },
        })
      ).toThrow();
    });

    it('enforces bundleDigest format (sha256: + 64 lower hex)', () => {
      expect(
        DeployProposalSchema.parse({
          ...validDeployProposal,
          bundleDigest: 'sha256:' + '0123456789abcdef'.repeat(4),
        }).bundleDigest
      ).toBe('sha256:' + '0123456789abcdef'.repeat(4));

      // Missing sha256: prefix
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          bundleDigest: 'a'.repeat(64),
        })
      ).toThrow();

      // Uppercase hex
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          bundleDigest: 'sha256:' + 'A'.repeat(64),
        })
      ).toThrow();

      // Wrong length
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          bundleDigest: 'sha256:' + 'a'.repeat(63),
        })
      ).toThrow();
    });

    it('rejects unknown properties strictly', () => {
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          extraField: 'malicious',
        })
      ).toThrow();
    });

    it('validates optional runtimeEnvironment reference with strict bounds', () => {
      const withEnv = {
        ...validDeployProposal,
        runtimeEnvironment: {
          connectionId: 'conn_env_99',
          credentialVersion: 3,
        },
      };

      const parsed = DeployProposalSchema.parse(withEnv);
      expect(parsed.runtimeEnvironment).toEqual({
        connectionId: 'conn_env_99',
        credentialVersion: 3,
      });

      // Strict bounds: credentialVersion must be positive integer
      expect(() =>
        DeployProposalSchema.parse({
          ...withEnv,
          runtimeEnvironment: { connectionId: 'conn_env_99', credentialVersion: 0 },
        })
      ).toThrow();

      expect(() =>
        DeployProposalSchema.parse({
          ...withEnv,
          runtimeEnvironment: { connectionId: 'conn_env_99', credentialVersion: -1 },
        })
      ).toThrow();

      expect(() =>
        DeployProposalSchema.parse({
          ...withEnv,
          runtimeEnvironment: { connectionId: 'conn_env_99', credentialVersion: 1.5 },
        })
      ).toThrow();

      // connectionId bounds
      expect(() =>
        DeployProposalSchema.parse({
          ...withEnv,
          runtimeEnvironment: { connectionId: '', credentialVersion: 1 },
        })
      ).toThrow();

      expect(() =>
        DeployProposalSchema.parse({
          ...withEnv,
          runtimeEnvironment: { connectionId: 'c'.repeat(129), credentialVersion: 1 },
        })
      ).toThrow();

      // No extra fields in runtimeEnvironment
      expect(() =>
        DeployProposalSchema.parse({
          ...withEnv,
          runtimeEnvironment: { connectionId: 'conn_env_99', credentialVersion: 1, extra: 'bad' },
        })
      ).toThrow();
    });

    it('validates optional buildLocation enum (iran/germany) and rejects invalid locations', () => {
      const withIran = { ...validDeployProposal, buildLocation: 'iran' as const };
      expect(DeployProposalSchema.parse(withIran).buildLocation).toBe('iran');

      const withGermany = { ...validDeployProposal, buildLocation: 'germany' as const };
      expect(DeployProposalSchema.parse(withGermany).buildLocation).toBe('germany');

      expect(() =>
        DeployProposalSchema.parse({ ...validDeployProposal, buildLocation: 'us' })
      ).toThrow();

      expect(() =>
        DeployProposalSchema.parse({ ...validDeployProposal, buildLocation: '' })
      ).toThrow();
    });

    it('validates optional platformConfig with strict allowlist {mirror?: boolean} and rejects arbitrary keys', () => {
      const withMirrorFalse = {
        ...validDeployProposal,
        platformConfig: { mirror: false },
      };
      expect(DeployProposalSchema.parse(withMirrorFalse).platformConfig).toEqual({ mirror: false });

      const withMirrorTrue = {
        ...validDeployProposal,
        platformConfig: { mirror: true },
      };
      expect(DeployProposalSchema.parse(withMirrorTrue).platformConfig).toEqual({ mirror: true });

      const withEmptyConfig = {
        ...validDeployProposal,
        platformConfig: {},
      };
      expect(DeployProposalSchema.parse(withEmptyConfig).platformConfig).toEqual({});

      // Rejects non-boolean mirror
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          platformConfig: { mirror: 'false' as any },
        })
      ).toThrow();

      // Rejects arbitrary commands/args/secrets
      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          platformConfig: { mirror: false, command: 'rm -rf /' } as any,
        })
      ).toThrow();

      expect(() =>
        DeployProposalSchema.parse({
          ...validDeployProposal,
          platformConfig: { mirror: false, args: ['--insecure'] } as any,
        })
      ).toThrow();
    });
  });

  describe('parseInspectedLiaraConfig', () => {
    it('safely extracts build.location and next.mirror from target liara.json', () => {
      const jsonContent = JSON.stringify({
        next: { mirror: false },
        build: { location: 'germany' },
        port: 3000,
      });
      const files = [
        { path: 'liara.json', bytes: new TextEncoder().encode(jsonContent) },
      ];

      const config = parseInspectedLiaraConfig(files);
      expect(config).toEqual({
        buildLocation: 'germany',
        platformConfigs: {
          next: { mirror: false },
        },
      });
    });

    it('safely extracts node.mirror and iran build location', () => {
      const jsonContent = JSON.stringify({
        node: { mirror: true },
        build: { location: 'iran' },
      });
      const files = [
        { path: './liara.json', bytes: new TextEncoder().encode(jsonContent) },
      ];

      const config = parseInspectedLiaraConfig(files);
      expect(config).toEqual({
        buildLocation: 'iran',
        platformConfigs: {
          node: { mirror: true },
        },
      });
    });

    it('ignores unknown platforms and arbitrary commands or secrets', () => {
      const jsonContent = JSON.stringify({
        build: { location: 'germany', arbitraryCommand: 'curl evil.com' },
        python: { mirror: false },
        arbitrarySecret: 'secret_token_123',
      });
      const files = [
        { path: 'liara.json', bytes: new TextEncoder().encode(jsonContent) },
      ];

      const config = parseInspectedLiaraConfig(files);
      expect(config).toEqual({
        buildLocation: 'germany',
      });
      expect((config as any).arbitrarySecret).toBeUndefined();
    });

    it('returns null when liara.json is missing, malformed, or exceeds 64 KiB', () => {
      expect(parseInspectedLiaraConfig([])).toBeNull();

      expect(
        parseInspectedLiaraConfig([
          { path: 'liara.json', bytes: new TextEncoder().encode('not valid json {') },
        ])
      ).toBeNull();

      const oversized = new Uint8Array(65537);
      expect(
        parseInspectedLiaraConfig([
          { path: 'liara.json', bytes: oversized },
        ])
      ).toBeNull();
    });
  });

  describe('RestartProposalSchema', () => {
    it('validates a well-formed restart proposal', () => {
      const parsed = RestartProposalSchema.parse(validRestartProposal);
      expect(parsed).toEqual(validRestartProposal);
    });

    it('rejects restart proposal missing required fields', () => {
      expect(() =>
        RestartProposalSchema.parse({
          kind: 'restart',
          connectionId: 'conn_1',
          // missing credentialVersion and appId
        })
      ).toThrow();
    });

    it('rejects extra unknown properties on restart proposal', () => {
      expect(() =>
        RestartProposalSchema.parse({
          ...validRestartProposal,
          unexpected: true,
        })
      ).toThrow();
    });
  });

  describe('CreateAppProposalSchema & AppCostSchema', () => {
    it('validates a well-formed create_app proposal', () => {
      const parsed = CreateAppProposalSchema.parse(validCreateAppProposal);
      expect(parsed).toEqual(validCreateAppProposal);
    });

    it('accepts alternative valid sourceUrl https://liara.ir/pricing/', () => {
      const parsed = CreateAppProposalSchema.parse({
        ...validCreateAppProposal,
        cost: {
          ...validCreateAppProposal.cost,
          sourceUrl: 'https://liara.ir/pricing/',
        },
      });
      expect(parsed.cost.sourceUrl).toBe('https://liara.ir/pricing/');
    });

    it('rejects unverified or invalid sourceUrl', () => {
      expect(() =>
        CreateAppProposalSchema.parse({
          ...validCreateAppProposal,
          cost: {
            ...validCreateAppProposal.cost,
            // @ts-expect-error invalid source
            sourceUrl: 'https://unverified-site.com',
          },
        })
      ).toThrow();
    });

    it('rejects currency other than IRR', () => {
      expect(() =>
        CreateAppProposalSchema.parse({
          ...validCreateAppProposal,
          cost: {
            ...validCreateAppProposal.cost,
            // @ts-expect-error invalid currency
            currency: 'USD',
          },
        })
      ).toThrow();
    });

    it('rejects negative or zero costs', () => {
      expect(() =>
        CreateAppProposalSchema.parse({
          ...validCreateAppProposal,
          cost: { ...validCreateAppProposal.cost, hourly: -10 },
        })
      ).toThrow();

      expect(() =>
        CreateAppProposalSchema.parse({
          ...validCreateAppProposal,
          cost: { ...validCreateAppProposal.cost, monthly: 0 },
        })
      ).toThrow();
    });

    it('rejects invalid checkedAt datetime', () => {
      expect(() =>
        CreateAppProposalSchema.parse({
          ...validCreateAppProposal,
          cost: { ...validCreateAppProposal.cost, checkedAt: 'not-a-datetime' },
        })
      ).toThrow();
    });

    it('rejects unknown properties on proposal or cost (.strict())', () => {
      expect(() =>
        CreateAppProposalSchema.parse({
          ...validCreateAppProposal,
          extraField: 'not-allowed',
        })
      ).toThrow();

      expect(() =>
        CreateAppProposalSchema.parse({
          ...validCreateAppProposal,
          cost: {
            ...validCreateAppProposal.cost,
            extraCostField: 123,
          },
        })
      ).toThrow();
    });

    it('validates ApprovedAppPlanSchema', () => {
      const samplePlan = {
        planId: 'standard-base-g2',
        bundlePlanId: 'basic',
        networkId: '6ad9be2707e024287d1bc47a',
        cost: validCreateAppProposal.cost,
      };
      expect(() => ApprovedAppPlanSchema.parse(samplePlan)).not.toThrow();
    });

    it('rejects ApprovedAppPlan missing or invalid networkId', () => {
      const samplePlan = {
        planId: 'standard-base-g2',
        bundlePlanId: 'basic',
        cost: validCreateAppProposal.cost,
      };
      expect(() => ApprovedAppPlanSchema.parse(samplePlan)).toThrow();
      expect(() => ApprovedAppPlanSchema.parse({ ...samplePlan, networkId: 'not-hex' })).toThrow();
    });

    it('rejects create_app proposal missing bundlePlanId', () => {
      const { bundlePlanId, ...missingBundle } = validCreateAppProposal;
      expect(() => CreateAppProposalSchema.parse(missingBundle)).toThrow();
    });

    it('rejects create_app proposal missing or invalid networkId', () => {
      const { networkId, ...missingNetwork } = validCreateAppProposal;
      expect(() => CreateAppProposalSchema.parse(missingNetwork)).toThrow();
      expect(() => CreateAppProposalSchema.parse({ ...validCreateAppProposal, networkId: '6AD9BE2707E024287D1BC47A' })).toThrow();
      expect(() => CreateAppProposalSchema.parse({ ...validCreateAppProposal, networkId: 'short' })).toThrow();
      expect(() => CreateAppProposalSchema.parse({ ...validCreateAppProposal, networkId: '6ad9be2707e024287d1bc47' })).toThrow();
      expect(() => CreateAppProposalSchema.parse({ ...validCreateAppProposal, networkId: '6ad9be2707e024287d1bc47a99' })).toThrow();
    });

    it('rejects legacy/old proposals lacking networkId preventing replays', () => {
      const legacyProposal = {
        kind: 'create_app',
        connectionId: 'conn_liara_12345',
        credentialVersion: 1,
        appId: 'my-new-app',
        platform: 'node',
        planId: 'standard-base-g2',
        bundlePlanId: 'basic',
        cost: validCreateAppProposal.cost,
      };
      expect(() => CreateAppProposalSchema.parse(legacyProposal)).toThrow();
      expect(() => DeploymentProposalSchema.parse(legacyProposal)).toThrow();
    });
  });

  describe('DeploymentProposalSchema union', () => {
    it('discriminates deploy, restart, and create_app correctly', () => {
      const deployParsed = DeploymentProposalSchema.parse(validDeployProposal);
      expect(deployParsed.kind).toBe('deploy');

      const restartParsed = DeploymentProposalSchema.parse(validRestartProposal);
      expect(restartParsed.kind).toBe('restart');

      const createParsed = DeploymentProposalSchema.parse(validCreateAppProposal);
      expect(createParsed.kind).toBe('create_app');
    });

    it('rejects unknown kind', () => {
      expect(() =>
        DeploymentProposalSchema.parse({
          kind: 'destroy',
          connectionId: 'conn_1',
          credentialVersion: 1,
          appId: 'test-app',
        })
      ).toThrow();
    });
  });

  describe('hashDeploymentProposal', () => {
    it('computes a 64-hex SHA-256 hash', () => {
      const hash = hashDeploymentProposal(validDeployProposal);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is strictly deterministic regardless of property key insertion order', () => {
      const shuffledA = {
        kind: 'deploy' as const,
        bundleDigest: validDeployProposal.bundleDigest,
        platform: validDeployProposal.platform,
        appId: validDeployProposal.appId,
        port: validDeployProposal.port,
        connectionId: validDeployProposal.connectionId,
        credentialVersion: validDeployProposal.credentialVersion,
        repository: {
          commitSha: validDeployProposal.repository.commitSha,
          repo: validDeployProposal.repository.repo,
          owner: validDeployProposal.repository.owner,
        },
      };

      const shuffledB = {
        connectionId: validDeployProposal.connectionId,
        repository: {
          owner: validDeployProposal.repository.owner,
          commitSha: validDeployProposal.repository.commitSha,
          repo: validDeployProposal.repository.repo,
        },
        port: validDeployProposal.port,
        kind: 'deploy' as const,
        credentialVersion: validDeployProposal.credentialVersion,
        appId: validDeployProposal.appId,
        bundleDigest: validDeployProposal.bundleDigest,
        platform: validDeployProposal.platform,
      };

      const hashA = hashDeploymentProposal(shuffledA);
      const hashB = hashDeploymentProposal(shuffledB);
      const hashOrig = hashDeploymentProposal(validDeployProposal);

      expect(hashA).toBe(hashOrig);
      expect(hashB).toBe(hashOrig);
    });

    it('produces distinct hashes when any proposal field changes', () => {
      const baseHash = hashDeploymentProposal(validDeployProposal);

      // credentialVersion change
      const hashCred = hashDeploymentProposal({ ...validDeployProposal, credentialVersion: 2 });
      expect(hashCred).not.toBe(baseHash);

      // appId change
      const hashApp = hashDeploymentProposal({ ...validDeployProposal, appId: 'auth-svc' });
      expect(hashApp).not.toBe(baseHash);

      // platform change
      const hashPlatform = hashDeploymentProposal({ ...validDeployProposal, platform: 'docker' });
      expect(hashPlatform).not.toBe(baseHash);

      // previousPlatform change
      const hashWithPrev = hashDeploymentProposal({ ...validDeployProposal, previousPlatform: 'next' });
      expect(hashWithPrev).not.toBe(baseHash);
      const hashWithOtherPrev = hashDeploymentProposal({ ...validDeployProposal, previousPlatform: 'node' });
      expect(hashWithOtherPrev).not.toBe(hashWithPrev);

      // port change
      const hashPort = hashDeploymentProposal({ ...validDeployProposal, port: 8080 });
      expect(hashPort).not.toBe(baseHash);

      // commitSha change
      const hashSha = hashDeploymentProposal({
        ...validDeployProposal,
        repository: { ...validDeployProposal.repository, commitSha: 'b'.repeat(40) },
      });
      expect(hashSha).not.toBe(baseHash);

      // bundleDigest change
      const hashBundle = hashDeploymentProposal({
        ...validDeployProposal,
        bundleDigest: 'sha256:' + 'f'.repeat(64),
      });
      expect(hashBundle).not.toBe(baseHash);
    });

    it('works deterministically on restart proposals', () => {
      const hash1 = hashDeploymentProposal(validRestartProposal);
      const hash2 = hashDeploymentProposal({
        appId: validRestartProposal.appId,
        connectionId: validRestartProposal.connectionId,
        credentialVersion: validRestartProposal.credentialVersion,
        kind: 'restart',
      });
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('works deterministically on create_app proposals and changes when any cost or plan field changes', () => {
      const hash1 = hashDeploymentProposal(validCreateAppProposal);
      const hash2 = hashDeploymentProposal({
        cost: {
          checkedAt: validCreateAppProposal.cost.checkedAt,
          sourceUrl: validCreateAppProposal.cost.sourceUrl,
          monthly: validCreateAppProposal.cost.monthly,
          hourly: validCreateAppProposal.cost.hourly,
          currency: validCreateAppProposal.cost.currency,
        },
        bundlePlanId: validCreateAppProposal.bundlePlanId,
        planId: validCreateAppProposal.planId,
        platform: validCreateAppProposal.platform,
        appId: validCreateAppProposal.appId,
        credentialVersion: validCreateAppProposal.credentialVersion,
        connectionId: validCreateAppProposal.connectionId,
        networkId: validCreateAppProposal.networkId,
        kind: 'create_app',
      });
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);

      // Network change alters hash
      const hashNetwork = hashDeploymentProposal({
        ...validCreateAppProposal,
        networkId: '111111111111111111111111',
      });
      expect(hashNetwork).not.toBe(hash1);

      // Hourly change alters hash
      const hashHourly = hashDeploymentProposal({
        ...validCreateAppProposal,
        cost: { ...validCreateAppProposal.cost, hourly: 30000 },
      });
      expect(hashHourly).not.toBe(hash1);

      // Monthly change alters hash
      const hashMonthly = hashDeploymentProposal({
        ...validCreateAppProposal,
        cost: { ...validCreateAppProposal.cost, monthly: 20000000 },
      });
      expect(hashMonthly).not.toBe(hash1);

      // Plan change alters hash
      const hashPlan = hashDeploymentProposal({
        ...validCreateAppProposal,
        planId: 'medium-g2',
      });
      expect(hashPlan).not.toBe(hash1);

      // Bundle plan change alters hash
      const hashBundle = hashDeploymentProposal({
        ...validCreateAppProposal,
        bundlePlanId: 'standard',
      });
      expect(hashBundle).not.toBe(hash1);

      // Platform change alters hash
      const hashPlatform = hashDeploymentProposal({
        ...validCreateAppProposal,
        platform: 'django',
      });
      expect(hashPlatform).not.toBe(hash1);
    });

    it('binds runtimeEnvironment into hash and changes when reference is added or modified', () => {
      const baseHash = hashDeploymentProposal(validDeployProposal);

      const withEnvProposal = {
        ...validDeployProposal,
        runtimeEnvironment: {
          connectionId: 'conn_env_1',
          credentialVersion: 1,
        },
      };

      const envHash = hashDeploymentProposal(withEnvProposal);
      expect(envHash).toMatch(/^[0-9a-f]{64}$/);
      expect(envHash).not.toBe(baseHash);

      // Deterministic regardless of key order
      const envHashShuffled = hashDeploymentProposal({
        runtimeEnvironment: {
          credentialVersion: 1,
          connectionId: 'conn_env_1',
        },
        kind: 'deploy',
        bundleDigest: validDeployProposal.bundleDigest,
        repository: validDeployProposal.repository,
        port: validDeployProposal.port,
        platform: validDeployProposal.platform,
        appId: validDeployProposal.appId,
        credentialVersion: validDeployProposal.credentialVersion,
        connectionId: validDeployProposal.connectionId,
      });
      expect(envHashShuffled).toBe(envHash);

      // Hash changes when connectionId changes
      const envHashConnDiff = hashDeploymentProposal({
        ...withEnvProposal,
        runtimeEnvironment: { connectionId: 'conn_env_2', credentialVersion: 1 },
      });
      expect(envHashConnDiff).not.toBe(envHash);

      // Hash changes when credentialVersion changes
      const envHashVerDiff = hashDeploymentProposal({
        ...withEnvProposal,
        runtimeEnvironment: { connectionId: 'conn_env_1', credentialVersion: 2 },
      });
      expect(envHashVerDiff).not.toBe(envHash);
    });

    it('binds buildLocation into proposal hash deterministically', () => {
      const baseHash = hashDeploymentProposal(validDeployProposal);

      const withGermany = {
        ...validDeployProposal,
        buildLocation: 'germany' as const,
      };
      const germanyHash = hashDeploymentProposal(withGermany);
      expect(germanyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(germanyHash).not.toBe(baseHash);

      const withIran = {
        ...validDeployProposal,
        buildLocation: 'iran' as const,
      };
      const iranHash = hashDeploymentProposal(withIran);
      expect(iranHash).not.toBe(baseHash);
      expect(iranHash).not.toBe(germanyHash);
    });

    it('binds platformConfig mirror into proposal hash deterministically', () => {
      const baseHash = hashDeploymentProposal(validDeployProposal);

      const withMirrorFalse = {
        ...validDeployProposal,
        platformConfig: { mirror: false },
      };
      const falseHash = hashDeploymentProposal(withMirrorFalse);
      expect(falseHash).toMatch(/^[0-9a-f]{64}$/);
      expect(falseHash).not.toBe(baseHash);

      const withMirrorTrue = {
        ...validDeployProposal,
        platformConfig: { mirror: true },
      };
      const trueHash = hashDeploymentProposal(withMirrorTrue);
      expect(trueHash).not.toBe(baseHash);
      expect(trueHash).not.toBe(falseHash);

      // Combined buildLocation and platformConfig
      const withBoth = {
        ...validDeployProposal,
        buildLocation: 'germany' as const,
        platformConfig: { mirror: false },
      };
      const bothHash = hashDeploymentProposal(withBoth);
      expect(bothHash).not.toBe(falseHash);
      expect(bothHash).not.toBe(baseHash);
    });

    it('strictly rejects undefined values or accessors', () => {
      expect(() =>
        hashDeploymentProposal({
          ...validDeployProposal,
          // @ts-expect-error - testing invalid undefined
          extra: undefined,
        })
      ).toThrow();

      const accessorObj = {
        ...validDeployProposal,
        get malicious() {
          return 'hacked';
        },
      };

      expect(() => hashDeploymentProposal(accessorObj)).toThrow();
    });
  });
});

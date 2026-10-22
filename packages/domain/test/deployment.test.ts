import { describe, it, expect } from 'vitest';
import {
  DeploymentProposalSchema,
  DeployProposalSchema,
  RestartProposalSchema,
  LiaraPlatformSchema,
  hashDeploymentProposal,
  type DeployProposal,
  type RestartProposal,
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

  describe('DeploymentProposalSchema union', () => {
    it('discriminates deploy and restart correctly', () => {
      const deployParsed = DeploymentProposalSchema.parse(validDeployProposal);
      expect(deployParsed.kind).toBe('deploy');

      const restartParsed = DeploymentProposalSchema.parse(validRestartProposal);
      expect(restartParsed.kind).toBe('restart');
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

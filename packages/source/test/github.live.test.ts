import { describe, expect, it } from 'vitest';
import { fetchPublicGithubSource } from '../src/github.js';

describe('Live internet fetch test (opt-in public readonly verification)', () => {
  it.skipIf(process.env.LAIRA_LIVE_GITHUB_TEST !== '1')(
    'reads canonical public repo octocat/Hello-World over actual internet without credentials',
    async () => {
      // Opt-in live test: must fail honestly on network error or rate limit (no swallowing)
      const result = await fetchPublicGithubSource('https://github.com/octocat/Hello-World');

      // Canonical commit on octocat/Hello-World is 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(result.commit).toBe('7fd1a60b01f91b314f59955a4e4d4e80d8edf11d');

      // GitHub wrapper folder stripped once: README sits at root
      expect(result.inventory.files.map((f) => f.path)).toEqual(['README']);
      expect(result.bundle.paths).toEqual(['README']);

      // Bundle digest is valid sha256 and sourceDigest matches pristine downloaded ZIP
      expect(result.bundle.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.bundle.sourceDigest).toBe(result.inventory.archiveDigest);
    },
    30_000
  );
});

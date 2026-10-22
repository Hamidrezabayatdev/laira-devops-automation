import { describe, expect, it } from 'vitest';
import { isExcludedSourcePath, validateSourcePath } from '../src/policy.js';
import { SourceImportError } from '../src/types.js';

describe('source path policy', () => {
  it.each(['../x', '/tmp/x', 'a/../x', './x', 'a//x', 'C:/x', 'C:x', 'a\\x', 'a\0x', 'a\nx', 'https:x', ''])('rejects ambiguous or dangerous path %j', path => {
    expect(() => validateSourcePath(path)).toThrow(SourceImportError);
  });
  it('allows paths without interpretation and directory trailing slash only', () => {
    expect(validateSourcePath('app/src/main.ts')).toBe('app/src/main.ts');
    expect(validateSourcePath('app/', true)).toBe('app');
    expect(() => validateSourcePath('app/')).toThrow(SourceImportError);
  });
  it.each(['.env', 'app/.env.local', 'app/.ENV.production', '.git/config', 'node_modules/x/index.js', 'app/dist/main.js', 'id_rsa', 'cert.pem', 'private.key', '.npmrc', '.netrc', 'credentials.json', 'credentials.yml', 'secrets.yml', '.aws/config', '.docker/config.json', '.kube/config', 'app/nested.tar.gz'])('excludes sensitive/generated/nested-archive path %s', path => {
    expect(isExcludedSourcePath(path)).toBe(true);
  });
  it.each(['app/package.json', 'src/index.ts', 'Dockerfile', 'requirements.txt', 'README.md'])('retains candidate source path %s without claiming content is safe', path => {
    expect(isExcludedSourcePath(path)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { analyzeSourceFiles, isValidComposerPackageName } from '../src/analyze.js';
import { SourceImportError, type SourceFile } from '../src/types.js';

function makeFile(path: string, content: string | Uint8Array): SourceFile {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { path, bytes };
}

describe('analyzeSourceFiles', () => {
  it('analyzes standard package.json and extracts dependency names and package manager', () => {
    const pkg = JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      packageManager: 'pnpm@9.0.0',
      engines: { node: '>=20' },
      scripts: {
        start: 'node index.js',
        postinstall: 'echo DO_NOT_EXECUTE',
      },
      dependencies: {
        express: '^4.18.2',
        lodash: 'canary_secret_version_123',
        gitignore: '^0.7.0',
        'github-slugger': '^2.0.0',
        'http://evil.com/exploit.tgz': '1.0.0',
      },
      devDependencies: {
        typescript: '^5.0.0',
      },
      peerDependencies: {
        react: '>=18.0.0',
      },
    });

    const result = analyzeSourceFiles([makeFile('package.json', pkg)]);

    expect(result.provenance).toBe('static_inference');
    expect(result.runtimes).toContain('node');
    expect(result.packageManagers).toContain('pnpm');
    expect(result.manifests).toEqual([{ path: 'package.json', kind: 'npm', valid: true }]);

    // Dependency names extracted, valid git-prefixed packages preserved, URLs filtered out
    expect(result.dependencyNames).toContain('express');
    expect(result.dependencyNames).toContain('lodash');
    expect(result.dependencyNames).toContain('gitignore');
    expect(result.dependencyNames).toContain('github-slugger');
    expect(result.dependencyNames).toContain('typescript');
    expect(result.dependencyNames).toContain('react');
    expect(result.dependencyNames).not.toContain('http://evil.com/exploit.tgz');

    // Values, scripts, canary strings NEVER leaked into analysis
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('DO_NOT_EXECUTE');
    expect(serialized).not.toContain('canary_secret_version_123');
    expect(serialized).not.toContain('>=20');
    expect(serialized).not.toContain('^4.18.2');
  });

  it('handles malformed JSON manifests safely with valid: false', () => {
    const malformedPkg = makeFile('package.json', '{ "name": "bad", broken json');
    const malformedLiara = makeFile('liara.json', '{ "port": [not valid json');
    const malformedComposer = makeFile('composer.json', '{ invalid');

    const result = analyzeSourceFiles([malformedPkg, malformedLiara, malformedComposer]);

    expect(result.manifests).toEqual([
      { path: 'package.json', kind: 'npm', valid: false },
      { path: 'liara.json', kind: 'liara', valid: false },
      { path: 'composer.json', kind: 'composer', valid: false },
    ]);
    expect(result.runtimes).toEqual([]);
    expect(result.ports).toEqual([]);
  });

  it('marks non-JSON manifests as valid: null (recognized by name, not validated)', () => {
    const files = [
      makeFile('requirements.txt', 'flask==2.3.2\n'),
      makeFile('pyproject.toml', '[tool.poetry]\n'),
      makeFile('yarn.lock', '# yarn lockfile v1\n'),
      makeFile('Dockerfile', 'FROM node:20\n'),
      makeFile('bun.lockb', new Uint8Array([0x00, 0x01, 0x02])),
    ];

    const result = analyzeSourceFiles(files);

    expect(result.manifests).toEqual([
      { path: 'requirements.txt', kind: 'pip', valid: null },
      { path: 'pyproject.toml', kind: 'pyproject', valid: null },
      { path: 'yarn.lock', kind: 'yarn-lock', valid: null },
      { path: 'Dockerfile', kind: 'dockerfile', valid: null },
      { path: 'bun.lockb', kind: 'bun-lock', valid: null },
    ]);
  });

  it('never outputs canary secrets embedded in code values or scripts', () => {
    const code = `
      const CANARY_VAL = "CANARY_SECRET_SUPER_SENSITIVE_KEY";
      const token = 'ghp_CANARY_TOKEN_VAL';
      // DO_NOT_RUN: rm -rf /
      process.env.APP_ENV = "prod";
      const db = process.env.DATABASE_URL;
      const port = process.env["PORT"];
    `;
    const files = [
      makeFile('src/index.js', code),
      makeFile('package.json', JSON.stringify({
        name: 'test',
        scripts: { build: 'echo CANARY_IN_SCRIPT' },
      })),
    ];

    const result = analyzeSourceFiles(files);
    const serialized = JSON.stringify(result);

    expect(result.environmentVariableNames).toContain('APP_ENV');
    expect(result.environmentVariableNames).toContain('DATABASE_URL');
    expect(result.environmentVariableNames).toContain('PORT');

    expect(serialized).not.toContain('CANARY_SECRET_SUPER_SENSITIVE_KEY');
    expect(serialized).not.toContain('ghp_CANARY_TOKEN_VAL');
    expect(serialized).not.toContain('CANARY_IN_SCRIPT');
    expect(serialized).not.toContain('rm -rf');
  });

  it('excludes sensitive and artifact paths', () => {
    const files = [
      makeFile('.env', 'CANARY_ENV_SECRET=12345'),
      makeFile('.env.production', 'CANARY_PROD_SECRET=67890'),
      makeFile('node_modules/pkg/package.json', '{"name":"leaked"}'),
      makeFile('.git/config', '[core] canary = true'),
      makeFile('secrets.json', '{"key": "CANARY_JSON_SECRET"}'),
      makeFile('id_rsa', '-----BEGIN RSA PRIVATE KEY-----'),
      makeFile('app.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
      makeFile('Dockerfile', 'EXPOSE 8080\nENV SERVICE_NAME web'),
    ];

    const result = analyzeSourceFiles(files);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('CANARY_ENV_SECRET');
    expect(serialized).not.toContain('CANARY_PROD_SECRET');
    expect(serialized).not.toContain('CANARY_JSON_SECRET');
    expect(serialized).not.toContain('RSA PRIVATE KEY');
    expect(serialized).not.toContain('leaked');

    expect(result.ports).toEqual([8080]);
    expect(result.environmentVariableNames).toEqual(['SERVICE_NAME']);
    expect(result.manifests).toEqual([{ path: 'Dockerfile', kind: 'dockerfile', valid: null }]);
  });

  it('rejects duplicate paths via case-insensitive and NFC normalization', () => {
    // Exact duplicate
    expect(() => analyzeSourceFiles([
      makeFile('foo.js', 'console.log(1)'),
      makeFile('foo.js', 'console.log(2)'),
    ])).toThrow(SourceImportError);

    // Case-insensitive collision
    expect(() => analyzeSourceFiles([
      makeFile('Foo.js', 'console.log(1)'),
      makeFile('foo.js', 'console.log(2)'),
    ])).toThrow(SourceImportError);

    // NFC vs NFD Unicode normalization collision
    const nfc = 'caf\u00e9.js';
    const nfd = 'cafe\u0301.js';
    expect(() => analyzeSourceFiles([
      makeFile(nfc, 'console.log(1)'),
      makeFile(nfd, 'console.log(2)'),
    ])).toThrow(SourceImportError);
  });

  it('rejects parent file / child directory collisions in both orders', () => {
    // Parent file first, then child
    expect(() => analyzeSourceFiles([
      makeFile('a', 'content'),
      makeFile('a/b.js', 'content'),
    ])).toThrow(SourceImportError);

    // Child first, then parent file
    expect(() => analyzeSourceFiles([
      makeFile('a/b.js', 'content'),
      makeFile('a', 'content'),
    ])).toThrow(SourceImportError);

    // Deeper hierarchy collision
    expect(() => analyzeSourceFiles([
      makeFile('src/components', 'file not dir'),
      makeFile('src/components/button.tsx', 'export const Button = 1;'),
    ])).toThrow(SourceImportError);
  });

  it('rejects path traversals and invalid paths', () => {
    expect(() => analyzeSourceFiles([
      makeFile('../etc/passwd', 'root:x:0:0'),
    ])).toThrow(SourceImportError);

    expect(() => analyzeSourceFiles([
      makeFile('/absolute/path.js', 'x'),
    ])).toThrow(SourceImportError);

    expect(() => analyzeSourceFiles([
      makeFile('foo\\bar.js', 'x'),
    ])).toThrow(SourceImportError);
  });

  it('enforces file size and entry limits', () => {
    // Single file exceeding 1 MiB
    const oversizedFile = {
      path: 'large.bin',
      bytes: new Uint8Array(1024 * 1024 + 1),
    };
    expect(() => analyzeSourceFiles([oversizedFile])).toThrow(SourceImportError);

    // Total size exceeding 16 MiB
    const chunk = new Uint8Array(1024 * 1024);
    const manyFiles: SourceFile[] = [];
    for (let i = 0; i < 17; i++) {
      manyFiles.push({ path: `file${i}.bin`, bytes: chunk });
    }
    expect(() => analyzeSourceFiles(manyFiles)).toThrow(SourceImportError);
  });

  it('handles binary files and non-UTF-8 safely with TextDecoder fatal check', () => {
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x00, 0x12, 0x80]);
    const file = { path: 'data.dat', bytes: invalidUtf8 };

    const result = analyzeSourceFiles([file]);
    expect(result.manifests).toEqual([]);
    expect(result.environmentVariableNames).toEqual([]);
  });

  it('safely parses requirements.txt in linear time and rejects URLs or editable specs', () => {
    const hostileKey = 'a'.repeat(60) + '!';
    const content = `
      # Comments
      flask==2.3.2
      requests[security]>=2.28.0; python_version > '3.8'
      https://secret-domain.com/secret-pkg.tar.gz
      -e git+https://github.com/org/repo.git#egg=secret
      git+ssh://git@github.com/org/repo.git
      pytest~=7.4.0
      ${hostileKey}==1.0.0
    `;
    const start = performance.now();
    const result = analyzeSourceFiles([makeFile('requirements.txt', content)]);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50);
    expect(result.dependencyNames).toContain('flask');
    expect(result.dependencyNames).toContain('requests');
    expect(result.dependencyNames).toContain('pytest');
    expect(result.dependencyNames).not.toContain('https');
    expect(result.dependencyNames).not.toContain('git');
    expect(result.dependencyNames).not.toContain(hostileKey);
    expect(JSON.stringify(result)).not.toContain('secret-domain');
  });

  it('validates Composer package names in linear time and resists ReDoS attacks', () => {
    // Exact catastrophic backtracking input key that caused >5s ReDoS
    const redosKey = 'a'.repeat(40) + '!';
    const longVendorInvalidSuffix = 'a'.repeat(100) + '!/package';
    const longPackageInvalidSuffix = 'vendor/' + 'b'.repeat(100) + '!';
    const overlongName = `vendor/${'a'.repeat(220)}`;

    const composerJson = JSON.stringify({
      require: {
        'laravel/framework': '^10.0',
        'monolog/monolog': '^2.0',
        'vendor-name/package.name_v1': '^1.0',
        [redosKey]: '^1.0',
        [longVendorInvalidSuffix]: '^1.0',
        [longPackageInvalidSuffix]: '^1.0',
        [overlongName]: '^1.0',
        'no-slash-package': '^1.0',
        'vendor/package--adjacent': '^1.0',
        'vendor/package..dots': '^1.0',
        '/missing-vendor': '^1.0',
        'missing-package/': '^1.0',
      },
    });

    const start = performance.now();
    const result = analyzeSourceFiles([makeFile('composer.json', composerJson)]);
    const duration = performance.now() - start;

    // Linear validator must complete in milliseconds, never seconds
    expect(duration).toBeLessThan(50);

    expect(result.dependencyNames).toContain('laravel/framework');
    expect(result.dependencyNames).toContain('monolog/monolog');
    expect(result.dependencyNames).toContain('vendor-name/package.name_v1');

    // All invalid/hostile keys rejected
    expect(result.dependencyNames).not.toContain(redosKey);
    expect(result.dependencyNames).not.toContain(longVendorInvalidSuffix);
    expect(result.dependencyNames).not.toContain(longPackageInvalidSuffix);
    expect(result.dependencyNames).not.toContain(overlongName);
    expect(result.dependencyNames).not.toContain('no-slash-package');
    expect(result.dependencyNames).not.toContain('vendor/package--adjacent');
    expect(result.manifests).toEqual([{ path: 'composer.json', kind: 'composer', valid: true }]);

    // Direct unit checks on isValidComposerPackageName
    expect(isValidComposerPackageName(redosKey)).toBe(false);
    expect(isValidComposerPackageName(longVendorInvalidSuffix)).toBe(false);
    expect(isValidComposerPackageName(longPackageInvalidSuffix)).toBe(false);
    expect(isValidComposerPackageName('a'.repeat(100) + '/' + 'b'.repeat(100))).toBe(true);
  });

  it('parses Dockerfile EXPOSE with multiple ports and protocol, rejecting junk without prefix truncation', () => {
    const dockerfile = `
      FROM alpine
      EXPOSE 80 443/tcp 8080/udp
      EXPOSE 123junk 5000
      ENV VALID_PORT_VAR 5000
    `;
    const result = analyzeSourceFiles([makeFile('Dockerfile', dockerfile)]);

    expect(result.ports).toEqual([80, 443, 5000, 8080]);
    expect(result.ports).not.toContain(123);
  });

  it('does not infer partial overlong environment variables', () => {
    const overlongName = 'A'.repeat(65);
    const code = `
      const x = process.env.${overlongName};
      const y = process.env["${overlongName}"];
      const z = os.getenv("${overlongName}");
      const normal = process.env.SAFE_ENV_VAR;
    `;
    const result = analyzeSourceFiles([makeFile('app.js', code)]);

    expect(result.environmentVariableNames).toContain('SAFE_ENV_VAR');
    for (const env of result.environmentVariableNames) {
      expect(env.length).toBeLessThanOrEqual(64);
      expect(overlongName.startsWith(env) && env !== 'SAFE_ENV_VAR').toBe(false);
    }
  });

  it('notes truncation in limitations when bounds are exceeded', () => {
    const envVars = Array.from({ length: 205 }, (_, i) => `process.env.VAR_${i} = 1;`).join('\n');
    const result = analyzeSourceFiles([makeFile('config.js', envVars)]);

    expect(result.environmentVariableNames.length).toBe(200);
    expect(result.limitations).toContain('static_inference: environment variable names list truncated at cap');
  });

  it('verifies explicit limitations and provenance', () => {
    const result = analyzeSourceFiles([]);
    expect(result.provenance).toBe('static_inference');
    expect(result.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no build executed'),
        expect.stringContaining('no runtime environment observed'),
        expect.stringContaining('no secret audit performed; metadata untrusted and not guaranteed secret-free'),
      ]),
    );
  });
});

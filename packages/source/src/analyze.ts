import {
  DEFAULT_SOURCE_LIMITS,
  type SourceFile,
  SourceImportError,
  type StaticAnalysis,
} from './types.js';
import { isExcludedSourcePath, validateSourcePath } from './policy.js';

const MAX_MANIFESTS = 100;
const MAX_DEPENDENCIES = 1000;
const MAX_ENV_VARS = 200;
const MAX_PORTS = 50;

const NPM_PACKAGE_NAME_REGEX =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_IDENTIFIER_REGEX = /^[A-Z_][A-Z0-9_]*$/;

const KNOWN_PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);

function isAlnum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) // a-z
  );
}

/**
 * Validates a Composer package part (vendor or package) in strictly linear O(N) time.
 * First and last characters must be alphanumeric. Allowed separators: '.', '-', '_'.
 * Consecutive separators are disallowed.
 */
function isValidComposerPart(part: string): boolean {
  if (part.length === 0) return false;
  const first = part.charCodeAt(0);
  const last = part.charCodeAt(part.length - 1);
  if (!isAlnum(first) || !isAlnum(last)) return false;

  for (let i = 1; i < part.length - 1; i++) {
    const code = part.charCodeAt(i);
    if (isAlnum(code)) {
      continue;
    }
    // Separators: '.', '-', '_'
    if (code === 46 /* . */ || code === 45 /* - */ || code === 95 /* _ */) {
      const prev = part.charCodeAt(i - 1);
      if (prev === 46 || prev === 45 || prev === 95) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Validates Composer vendor/package name in strictly linear O(N) time.
 * Prevents ReDoS from hostile input keys.
 */
export function isValidComposerPackageName(name: string): boolean {
  if (!name || name.length > 214) return false;
  const slashIdx = name.indexOf('/');
  if (slashIdx === -1 || slashIdx !== name.lastIndexOf('/')) {
    return false;
  }
  const vendor = name.slice(0, slashIdx);
  const pkg = name.slice(slashIdx + 1);
  return isValidComposerPart(vendor) && isValidComposerPart(pkg);
}

/**
 * Parses Python requirements dependency name in strictly linear O(N) time.
 * Rejects URLs, editable flags, and non-conforming tokens without regex backtracking.
 */
function parsePipDependencyName(line: string): string | null {
  const commentIdx = line.indexOf('#');
  const cleanLine = (commentIdx !== -1 ? line.slice(0, commentIdx) : line).trim();
  if (
    !cleanLine ||
    cleanLine.startsWith('-') ||
    cleanLine.includes('://') ||
    cleanLine.startsWith('git+')
  ) {
    return null;
  }

  // Strip environment markers
  const markerIdx = cleanLine.indexOf(';');
  const specPart = (markerIdx !== -1 ? cleanLine.slice(0, markerIdx) : cleanLine).trim();
  if (!specPart) return null;

  // Find index of version operators or extras or space
  let nameEnd = specPart.length;
  for (let i = 0; i < specPart.length; i++) {
    const ch = specPart[i];
    if (
      ch === ' ' ||
      ch === '\t' ||
      ch === '[' ||
      ch === '=' ||
      ch === '<' ||
      ch === '>' ||
      ch === '!' ||
      ch === '~' ||
      ch === '@'
    ) {
      nameEnd = i;
      break;
    }
  }

  const name = specPart.slice(0, nameEnd).trim();
  if (!name || name.length > 128) return null;

  const first = name.charCodeAt(0);
  const last = name.charCodeAt(name.length - 1);
  if (!isAlnum(first) || !isAlnum(last)) return null;

  for (let i = 1; i < name.length - 1; i++) {
    const code = name.charCodeAt(i);
    if (!isAlnum(code) && code !== 46 /* . */ && code !== 45 /* - */ && code !== 95 /* _ */) {
      return null;
    }
  }

  const lower = name.toLowerCase();
  if (lower === 'http' || lower === 'https') return null;

  return name;
}

/**
 * Pure static analysis of source files.
 * Never executes, imports, or evals source files.
 * Rejects oversized or unsafe inputs defensively.
 */
export function analyzeSourceFiles(files: readonly SourceFile[]): StaticAnalysis {
  if (!Array.isArray(files)) {
    throw new SourceImportError('INVALID_ARCHIVE');
  }

  if (files.length > DEFAULT_SOURCE_LIMITS.maxEntries) {
    throw new SourceImportError('LIMIT_EXCEEDED');
  }

  let totalRetainedBytes = 0;
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  const sanitizedFiles: Array<{ path: string; text: string | null }> = [];

  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !(file.bytes instanceof Uint8Array)) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }

    if (file.bytes.byteLength > DEFAULT_SOURCE_LIMITS.maxFileBytes) {
      throw new SourceImportError('LIMIT_EXCEEDED');
    }

    totalRetainedBytes += file.bytes.byteLength;
    if (totalRetainedBytes > DEFAULT_SOURCE_LIMITS.maxRetainedBytes) {
      throw new SourceImportError('LIMIT_EXCEEDED');
    }

    const validPath = validateSourcePath(file.path);
    const normalizedKey = validPath.normalize('NFC').toLowerCase();

    // Reject duplicates (NFC normalized + case-insensitive)
    if (seenFiles.has(normalizedKey)) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }

    // Reject collision where file path matches an existing directory
    if (seenDirectories.has(normalizedKey)) {
      throw new SourceImportError('UNSAFE_ENTRY');
    }

    // Reject collision where an ancestor directory is already a file (e.g. parent file collision)
    const segments = normalizedKey.split('/');
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('/');
      if (seenFiles.has(ancestor)) {
        throw new SourceImportError('UNSAFE_ENTRY');
      }
    }

    seenFiles.add(normalizedKey);
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('/');
      seenDirectories.add(ancestor);
    }

    if (isExcludedSourcePath(validPath)) {
      continue;
    }

    // Try decoding text with fatal: true so binary files or invalid UTF-8 are skipped safely
    let text: string | null = null;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      text = decoder.decode(file.bytes);
      // Skip if containing null bytes
      if (text.includes('\u0000')) {
        text = null;
      }
    } catch {
      text = null;
    }

    sanitizedFiles.push({ path: validPath, text });
  }

  const manifests: Array<{ path: string; kind: string; valid: boolean | null }> = [];
  const runtimes = new Set<string>();
  const packageManagers = new Set<string>();
  const dependencyNames = new Set<string>();
  const environmentVariableNames = new Set<string>();
  const ports = new Set<number>();

  let manifestsTruncated = false;
  let dependenciesTruncated = false;
  let envVarsTruncated = false;
  let portsTruncated = false;

  function addManifest(item: { path: string; kind: string; valid: boolean | null }): void {
    if (manifests.length < MAX_MANIFESTS) {
      manifests.push(item);
    } else {
      manifestsTruncated = true;
    }
  }

  function addDependency(name: string): void {
    if (dependencyNames.size < MAX_DEPENDENCIES) {
      dependencyNames.add(name);
    } else {
      dependenciesTruncated = true;
    }
  }

  function addEnvVar(name: string): void {
    if (environmentVariableNames.size < MAX_ENV_VARS) {
      environmentVariableNames.add(name);
    } else {
      envVarsTruncated = true;
    }
  }

  function addPort(port: number): void {
    if (ports.size < MAX_PORTS) {
      ports.add(port);
    } else {
      portsTruncated = true;
    }
  }

  for (const { path, text } of sanitizedFiles) {
    const parts = path.split('/');
    const basename = parts[parts.length - 1] ?? '';
    const lowerBasename = basename.toLowerCase();

    // 1. package.json
    if (lowerBasename === 'package.json') {
      let valid = false;
      if (text !== null) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            valid = true;
            runtimes.add('node');

            // Dependencies: names ONLY, validate npm package identifier schema
            const depFields = [
              'dependencies',
              'devDependencies',
              'peerDependencies',
              'optionalDependencies',
            ];
            for (const field of depFields) {
              const deps = parsed[field];
              if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
                for (const depName of Object.keys(deps)) {
                  if (
                    depName.length <= 214 &&
                    NPM_PACKAGE_NAME_REGEX.test(depName) &&
                    !depName.includes('://')
                  ) {
                    addDependency(depName);
                  }
                }
              }
            }

            // Engines
            if (parsed.engines && typeof parsed.engines === 'object' && parsed.engines.node) {
              runtimes.add('node');
            }

            // packageManager
            if (typeof parsed.packageManager === 'string') {
              const pmMatch = parsed.packageManager.split(/[@~^]/)[0]?.trim().toLowerCase();
              if (pmMatch && KNOWN_PACKAGE_MANAGERS.has(pmMatch)) {
                packageManagers.add(pmMatch);
              }
            }
          }
        } catch {
          valid = false;
        }
      }
      addManifest({ path, kind: 'npm', valid });
    }

    // 2. Lockfiles (recognized by name only => valid is null)
    else if (lowerBasename === 'package-lock.json' || lowerBasename === 'npm-shrinkwrap.json') {
      addManifest({ path, kind: 'npm-lock', valid: null });
      packageManagers.add('npm');
      runtimes.add('node');
    } else if (lowerBasename === 'yarn.lock') {
      addManifest({ path, kind: 'yarn-lock', valid: null });
      packageManagers.add('yarn');
      runtimes.add('node');
    } else if (lowerBasename === 'pnpm-lock.yaml') {
      addManifest({ path, kind: 'pnpm-lock', valid: null });
      packageManagers.add('pnpm');
      runtimes.add('node');
    } else if (lowerBasename === 'bun.lockb' || lowerBasename === 'bun.lock') {
      addManifest({ path, kind: 'bun-lock', valid: null });
      packageManagers.add('bun');
      runtimes.add('bun');
    }

    // 3. Python (unvalidated non-JSON => valid is null)
    else if (lowerBasename === 'requirements.txt') {
      addManifest({ path, kind: 'pip', valid: null });
      runtimes.add('python');
      if (text !== null) {
        for (const line of text.split('\n')) {
          const name = parsePipDependencyName(line);
          if (name) {
            addDependency(name);
          }
        }
      }
    } else if (lowerBasename === 'pyproject.toml') {
      addManifest({ path, kind: 'pyproject', valid: null });
      runtimes.add('python');
    } else if (lowerBasename === 'pipfile') {
      addManifest({ path, kind: 'pipfile', valid: null });
      runtimes.add('python');
    }

    // 4. Go
    else if (lowerBasename === 'go.mod') {
      addManifest({ path, kind: 'go-mod', valid: null });
      runtimes.add('go');
    }

    // 5. Rust
    else if (lowerBasename === 'cargo.toml') {
      addManifest({ path, kind: 'cargo', valid: null });
      runtimes.add('rust');
    } else if (lowerBasename === 'cargo.lock') {
      addManifest({ path, kind: 'cargo-lock', valid: null });
      runtimes.add('rust');
    }

    // 6. PHP / Composer (JSON parsed => valid is boolean, linear validation)
    else if (lowerBasename === 'composer.json') {
      let valid = false;
      if (text !== null) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            valid = true;
            runtimes.add('php');
            for (const field of ['require', 'require-dev']) {
              const reqs = parsed[field];
              if (reqs && typeof reqs === 'object' && !Array.isArray(reqs)) {
                for (const pkg of Object.keys(reqs)) {
                  if (isValidComposerPackageName(pkg)) {
                    addDependency(pkg);
                  }
                }
              }
            }
          }
        } catch {
          valid = false;
        }
      }
      addManifest({ path, kind: 'composer', valid });
    }

    // 7. Ruby
    else if (lowerBasename === 'gemfile') {
      addManifest({ path, kind: 'gemfile', valid: null });
      runtimes.add('ruby');
    }

    // 8. Dockerfile
    else if (
      lowerBasename === 'dockerfile' ||
      lowerBasename.endsWith('.dockerfile') ||
      lowerBasename.startsWith('dockerfile.')
    ) {
      addManifest({ path, kind: 'dockerfile', valid: null });
      if (text !== null) {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          const exposeLineMatch = trimmed.match(/^EXPOSE\s+(.+)$/i);
          if (exposeLineMatch?.[1]) {
            const tokens = exposeLineMatch[1].trim().split(/\s+/);
            for (const token of tokens) {
              const tokenMatch = token.match(/^([0-9]{1,5})(?:\/(?:tcp|udp))?$/i);
              const portStr = tokenMatch?.[1];
              if (portStr) {
                const portNum = Number.parseInt(portStr, 10);
                if (portNum >= 1 && portNum <= 65535) {
                  addPort(portNum);
                }
              }
            }
          }
          const envMatch = trimmed.match(/^ENV\s+([A-Za-z_][A-Za-z0-9_]*)/i);
          const envName = envMatch?.[1];
          if (envName && envName.length <= 64) {
            addEnvVar(envName);
          }
        }
      }
    }

    // 9. Procfile
    else if (lowerBasename === 'procfile') {
      addManifest({ path, kind: 'procfile', valid: null });
    }

    // 10. liara.json (JSON parsed => valid is boolean)
    else if (lowerBasename === 'liara.json') {
      let valid = false;
      if (text !== null) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            valid = true;
            if (typeof parsed.port === 'number' && Number.isInteger(parsed.port)) {
              if (parsed.port >= 1 && parsed.port <= 65535) {
                addPort(parsed.port);
              }
            } else if (typeof parsed.port === 'string' && /^[0-9]+$/.test(parsed.port)) {
              const p = Number.parseInt(parsed.port, 10);
              if (p >= 1 && p <= 65535) {
                addPort(p);
              }
            }
            if (typeof parsed.platform === 'string' && parsed.platform.length <= 32) {
              const plat = parsed.platform.toLowerCase();
              if (
                [
                  'node',
                  'python',
                  'php',
                  'go',
                  'ruby',
                  'dotnet',
                  'django',
                  'flask',
                  'laravel',
                  'react',
                  'vue',
                  'angular',
                  'static',
                ].includes(plat)
              ) {
                runtimes.add(plat);
              }
            }
          }
        } catch {
          valid = false;
        }
      }
      addManifest({ path, kind: 'liara', valid });
    }

    // Environment variables extraction across text files (only bounded regex on safe text, no partial prefixes)
    if (text !== null) {
      // process.env.NAME or process.env['NAME']
      const procEnvDotMatches = text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g);
      for (const m of procEnvDotMatches) {
        const name = m[1];
        if (name && name.length <= 64 && IDENTIFIER_REGEX.test(name)) {
          addEnvVar(name);
        }
      }
      const procEnvBracketMatches = text.matchAll(/process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g);
      for (const m of procEnvBracketMatches) {
        const name = m[1];
        if (name && name.length <= 64 && IDENTIFIER_REGEX.test(name)) {
          addEnvVar(name);
        }
      }

      // os.getenv("NAME") or os.environ.get("NAME") or os.environ["NAME"]
      const osEnvMatches = text.matchAll(
        /os\.(?:getenv|environ\.get|environ\[)\s*\(?\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
      );
      for (const m of osEnvMatches) {
        const name = m[1];
        if (name && name.length <= 64 && IDENTIFIER_REGEX.test(name)) {
          addEnvVar(name);
        }
      }

      // ${NAME} in shell / templates / dockerfiles
      const templateEnvMatches = text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g);
      for (const m of templateEnvMatches) {
        const name = m[1];
        if (name && name.length <= 64 && ENV_IDENTIFIER_REGEX.test(name)) {
          addEnvVar(name);
        }
      }
    }
  }

  const limitations = [
    'static_inference: no build executed or verified',
    'static_inference: no runtime environment observed',
    'static_inference: no secret audit performed; metadata untrusted and not guaranteed secret-free',
  ];
  if (manifestsTruncated) {
    limitations.push('static_inference: manifests list truncated at cap');
  }
  if (dependenciesTruncated) {
    limitations.push('static_inference: dependencies list truncated at cap');
  }
  if (envVarsTruncated) {
    limitations.push('static_inference: environment variable names list truncated at cap');
  }
  if (portsTruncated) {
    limitations.push('static_inference: ports list truncated at cap');
  }

  return {
    provenance: 'static_inference',
    manifests,
    runtimes: Array.from(runtimes).sort(),
    packageManagers: Array.from(packageManagers).sort(),
    dependencyNames: Array.from(dependencyNames).sort(),
    environmentVariableNames: Array.from(environmentVariableNames).sort(),
    ports: Array.from(ports).sort((a, b) => a - b),
    limitations,
  };
}

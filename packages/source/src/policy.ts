import { SourceImportError } from './types.js';

/** Reject rather than normalize ambiguous paths before duplicate detection. */
export function validateSourcePath(input: string, directory = false): string {
  if (!input || input.length > 1024 || /[\\\u0000-\u001f\u007f]/u.test(input) || input.startsWith('/') || /^[a-zA-Z]:/.test(input)) {
    throw new SourceImportError('UNSAFE_ENTRY');
  }
  const path = directory && input.endsWith('/') ? input.slice(0, -1) : input;
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new SourceImportError('UNSAFE_ENTRY');
  }
  return path;
}

/** Conservative deny list. Excluded bytes never become source excerpts or deployment bundle members. */
export function isExcludedSourcePath(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  const base = parts.at(-1) || '';
  if (parts.some(p => ['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', '.next', 'coverage', '.cache', '.ssh', '.aws', '.azure', '.docker', '.kube', '.gnupg', '.config', '__macosx'].includes(p))) return true;
  if (parts.some(p => p === '.env' || p.startsWith('.env.') || p === 'credentials' || p === 'secrets' || p === '.secrets')) return true;
  if (/\.(?:pem|key|p12|pfx|keystore|jks|zip|tar|gz|tgz|bz2|xz|7z|rar)$/i.test(base)) return true;
  return /^(?:id_rsa|id_ed25519|id_dsa|id_ecdsa|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(?:\..*)?|service[-_]account.*\.json|secrets?(?:\..*)?)$/.test(base);
}

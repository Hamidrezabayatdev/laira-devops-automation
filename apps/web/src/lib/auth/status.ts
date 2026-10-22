export function isAuthConfigured(): boolean {
  return Boolean(
    process.env.AUTH_GITHUB_ID &&
    process.env.AUTH_GITHUB_SECRET &&
    (process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET),
  );
}

export function getMissingAuthConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.AUTH_GITHUB_ID) missing.push('AUTH_GITHUB_ID');
  if (!process.env.AUTH_GITHUB_SECRET) missing.push('AUTH_GITHUB_SECRET');
  if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) missing.push('AUTH_SECRET');
  return missing;
}

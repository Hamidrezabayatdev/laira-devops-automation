import { isAuthConfigured, getMissingAuthConfig } from '@/lib/auth/status';
import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const configured = isAuthConfigured();
  const missing = getMissingAuthConfig();
  const auth = await resolveAuthenticatedWorkspace(request);

  return Response.json({
    configured,
    missingConfig: missing,
    authenticated: auth.authenticated,
    user: auth.user || null,
  });
}

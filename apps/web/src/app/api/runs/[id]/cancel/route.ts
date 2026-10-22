import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';
import { verifyRequestOrigin } from '@/lib/security/origin';
import { dbAdapter, DatabaseUnavailableError } from '@/lib/db/adapter-bridge';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

  // 1. Same-origin check for browser mutations
  const originResult = verifyRequestOrigin(request);
  if (!originResult.valid) {
    return Response.json(
      {
        error: originResult.reason || 'Forbidden: untrusted origin',
        code: 'ORIGIN_MISMATCH',
        message: originResult.reason || 'Forbidden: untrusted origin',
        retryable: false,
      },
      { status: 403 },
    );
  }

  // 2. Strict tenant authentication & workspace resolution
  const auth = await resolveAuthenticatedWorkspace(request);
  if (!auth.authenticated || !auth.user) {
    const status = auth.status || 401;
    return Response.json(
      {
        error: auth.error || 'Unauthorized',
        code: status === 503 ? 'DB_UNAVAILABLE' : 'UNAUTHORIZED',
        message: auth.error || 'Unauthorized',
        retryable: status === 503,
      },
      { status },
    );
  }

  // 3. Cancel run within tenant scope
  try {
    const result = await dbAdapter.cancelRun(auth.user.workspaceId, id);
    if (!result.run) {
      return Response.json(
        {
          error: `Run with ID '${id}' not found in current workspace.`,
          code: 'RUN_NOT_FOUND',
          message: `Run with ID '${id}' not found in current workspace.`,
          retryable: false,
        },
        { status: 404 },
      );
    }

    if (!result.success) {
      return Response.json(
        {
          error: `Cannot cancel run in state '${result.run.state}'. Run is already terminal.`,
          code: 'RUN_TERMINAL',
          message: `Cannot cancel run in state '${result.run.state}'. Run is already terminal.`,
          run: result.run,
          retryable: false,
        },
        { status: 400 },
      );
    }

    return Response.json(
      { message: 'Run successfully cancelled', run: result.run },
      { status: 200 },
    );
  } catch (err: unknown) {
    if (err instanceof DatabaseUnavailableError) {
      return Response.json(
        {
          error: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
          code: 'DB_UNAVAILABLE',
          message: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
          retryable: true,
        },
        { status: 503 },
      );
    }
    return Response.json(
      {
        error: 'خطا در لغو اجرا',
        code: 'INTERNAL_ERROR',
        message: 'خطا در لغو اجرا',
        retryable: false,
      },
      { status: 500 },
    );
  }
}

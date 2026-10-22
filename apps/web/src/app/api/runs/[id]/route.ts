import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';
import { dbAdapter, DatabaseUnavailableError } from '@/lib/db/adapter-bridge';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

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

  try {
    const run = await dbAdapter.getRun(auth.user.workspaceId, id);
    if (!run) {
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

    return Response.json({ run }, { status: 200 });
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
        error: 'خطا در دریافت اطلاعات اجرا',
        code: 'INTERNAL_ERROR',
        message: 'خطا در دریافت اطلاعات اجرا',
        retryable: false,
      },
      { status: 500 },
    );
  }
}

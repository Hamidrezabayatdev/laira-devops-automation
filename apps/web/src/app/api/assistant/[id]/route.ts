import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';
import { DatabaseUnavailableError } from '@/lib/db/adapter-bridge';
import {
  getAssistantDbAdapter,
  sanitizeAgentOutput,
  sanitizeProgressEvents,
  ALLOWED_ASSISTANT_RUN_TYPES,
} from '@/lib/agent-contract';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

  // 1. Strict tenant authentication & workspace resolution (fail-closed if DB offline)
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

  // 2. Query run strictly scoped to authenticated workspace
  try {
    const adapter = getAssistantDbAdapter();
    const run = await adapter.getAgentRun(auth.user.workspaceId, id);

    if (!run) {
      return Response.json(
        {
          error: `وظیفه با شناسه '${id}' در فضای کاری جاری یافت نشد`,
          code: 'RUN_NOT_FOUND',
          message: `وظیفه با شناسه '${id}' در فضای کاری جاری یافت نشد`,
          retryable: false,
        },
        { status: 404 },
      );
    }

    // Restrict strictly to assistant run types: agent_task and agent_action
    if (!ALLOWED_ASSISTANT_RUN_TYPES.includes(run.type as any)) {
      return Response.json(
        {
          error: `وظیفه با شناسه '${id}' در فضای کاری جاری یافت نشد`,
          code: 'RUN_NOT_FOUND',
          message: `وظیفه با شناسه '${id}' در فضای کاری جاری یافت نشد`,
          retryable: false,
        },
        { status: 404 },
      );
    }

    // 3. Query run events and sanitize to known fields only
    const rawEvents = await adapter.getAgentRunEvents(auth.user.workspaceId, id);
    const progress = sanitizeProgressEvents(rawEvents);

    // 4. Sanitize output allowing only verified consistent proposal + safe message + verification phase
    const sanitizedOutput = sanitizeAgentOutput(run.output, run.status);

    const rawInput =
      run.input && typeof run.input === 'object'
        ? (run.input as Record<string, unknown>)
        : {};
    const task = typeof rawInput.task === 'string' ? rawInput.task : '';
    const repository =
      rawInput.repository && typeof rawInput.repository === 'object'
        ? rawInput.repository
        : undefined;

    let errorStr: string | null = null;
    if (run.error) {
      if (typeof run.error === 'string') {
        errorStr = run.error;
      } else if (
        typeof run.error === 'object' &&
        run.error !== null &&
        typeof (run.error as any).message === 'string'
      ) {
        errorStr = (run.error as any).message;
      } else {
        errorStr = 'خطا در اجرای وظیفه';
      }
    }

    return Response.json(
      {
        runId: run.id,
        status: run.status,
        type: run.type,
        task,
        ...(repository ? { repository } : {}),
        output: sanitizedOutput,
        verificationPhase: sanitizedOutput?.verificationPhase,
        progress,
        error: errorStr,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        finishedAt: run.finishedAt,
      },
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
        error: 'خطا در دریافت اطلاعات وظیفه',
        code: 'INTERNAL_ERROR',
        message: 'خطا در دریافت اطلاعات وظیفه',
        retryable: false,
      },
      { status: 500 },
    );
  }
}

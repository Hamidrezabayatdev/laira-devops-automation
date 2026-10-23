import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';
import { verifyRequestOrigin } from '@/lib/security/origin';
import { DatabaseUnavailableError } from '@/lib/db/adapter-bridge';
import {
  validateAgentTaskInput,
  getAssistantDbAdapter,
} from '@/lib/agent-contract';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024; // 16 KiB bounded payload

export async function POST(request: Request) {
  // 1. Same-origin check for browser state-changing mutations
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

  // 2. Strict tenant authentication & workspace resolution (fail-closed if DB offline)
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

  // 3. Content-Type validation: exact media type application/json is required
  const rawContentType = request.headers.get('content-type') || '';
  const mediaType = rawContentType.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return Response.json(
      {
        error: 'نوع محتوا باید application/json باشد',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'نوع محتوا باید application/json باشد',
        retryable: false,
      },
      { status: 415 },
    );
  }

  // 4. Content-Length pre-check & bounded streaming read
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return Response.json(
      {
        error: 'حجم درخواست بیش از حد مجاز است',
        code: 'PAYLOAD_TOO_LARGE',
        message: 'حجم درخواست بیش از حد مجاز است',
        retryable: false,
      },
      { status: 413 },
    );
  }

  let bodyText = '';
  if (request.body) {
    const reader = request.body.getReader();
    let totalBytes = 0;
    const decoder = new TextDecoder();
    let timeoutId: NodeJS.Timeout | null = null;
    let isTimedOut = false;

    // 10-second timeout to prevent stalled streams
    const readTimeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(new Error('READ_TIMEOUT'));
      }, 10_000);
    });

    try {
      while (true) {
        const { done, value } = await Promise.race([
          reader.read(),
          readTimeoutPromise,
        ]);
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          reader.cancel().catch(() => {});
          return Response.json(
            {
              error: 'حجم درخواست بیش از حد مجاز است',
              code: 'PAYLOAD_TOO_LARGE',
              message: 'حجم درخواست بیش از حد مجاز است',
              retryable: false,
            },
            { status: 413 },
          );
        }
        bodyText += decoder.decode(value, { stream: true });
      }
      bodyText += decoder.decode();
    } catch {
      reader.cancel().catch(() => {});
      if (isTimedOut) {
        return Response.json(
          {
            error: 'مهلت زمانی خواندن بدنه درخواست به پایان رسید',
            code: 'REQUEST_TIMEOUT',
            message: 'مهلت زمانی خواندن بدنه درخواست به پایان رسید',
            retryable: false,
          },
          { status: 408 },
        );
      }
      return Response.json(
        {
          error: 'خطا در خواندن بدنه درخواست',
          code: 'INVALID_REQUEST_BODY',
          message: 'خطا در خواندن بدنه درخواست',
          retryable: false,
        },
        { status: 400 },
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      try {
        reader.releaseLock();
      } catch {
        // Safe ignore
      }
    }
  } else {
    try {
      bodyText = await request.text();
    } catch {
      bodyText = '';
    }
  }

  if (!bodyText || !bodyText.trim()) {
    return Response.json(
      {
        error: 'بدنه درخواست نامعتبر است',
        code: 'INVALID_REQUEST_BODY',
        message: 'بدنه درخواست نامعتبر است',
        retryable: false,
      },
      { status: 400 },
    );
  }

  // 5. Safe JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return Response.json(
      {
        error: 'قالب JSON نامعتبر است',
        code: 'MALFORMED_JSON',
        message: 'قالب JSON نامعتبر است',
        retryable: false,
      },
      { status: 400 },
    );
  }

  // 6. Contract validation: task max 4000 chars, optional github repo, no arbitrary metadata
  const validation = validateAgentTaskInput(parsed);
  if (!validation.valid) {
    return Response.json(
      {
        error: validation.error,
        code: validation.code,
        message: validation.error,
        retryable: false,
      },
      { status: 400 },
    );
  }

  // 7. Create durable agent task run in DB (strictly scoped to auth workspace)
  try {
    const adapter = getAssistantDbAdapter();

    // Owner-scoped precheck for explicit connectionId (fail closed 503 if capability missing)
    if (validation.input.connectionId) {
      if (!adapter.validateConnection) {
        return Response.json(
          {
            error: 'سرویس اعتبارسنجی اتصال در دسترس نیست (503 Service Unavailable)',
            code: 'VALIDATION_UNAVAILABLE',
            message: 'سرویس اعتبارسنجی اتصال در دسترس نیست',
            retryable: true,
          },
          { status: 503 },
        );
      }
      const connCheck = await adapter.validateConnection(auth.user.workspaceId, validation.input.connectionId);
      if (!connCheck.valid) {
        return Response.json(
          {
            error: connCheck.error || 'اتصال نامعتبر است',
            code: connCheck.code || 'INVALID_CONNECTION',
            message: connCheck.error || 'اتصال نامعتبر است',
            retryable: false,
          },
          { status: 400 },
        );
      }
    }

    // Owner-scoped precheck for explicit runtimeEnvironment (fail closed 503 if capability missing)
    if (validation.input.runtimeEnvironment) {
      if (!adapter.validateRuntimeEnvironment) {
        return Response.json(
          {
            error: 'سرویس اعتبارسنجی محیط اجرا در دسترس نیست (503 Service Unavailable)',
            code: 'VALIDATION_UNAVAILABLE',
            message: 'سرویس اعتبارسنجی محیط اجرا در دسترس نیست',
            retryable: true,
          },
          { status: 503 },
        );
      }
      const envCheck = await adapter.validateRuntimeEnvironment(auth.user.workspaceId, validation.input.runtimeEnvironment);
      if (!envCheck.valid) {
        return Response.json(
          {
            error: envCheck.error || 'محیط اجرای نامعتبر است',
            code: envCheck.code || 'INVALID_RUNTIME_ENVIRONMENT',
            message: envCheck.error || 'محیط اجرای نامعتبر است',
            retryable: false,
          },
          { status: 400 },
        );
      }
    }

    const run = await adapter.createAgentRun(auth.user.workspaceId, validation.input);

    return Response.json(
      {
        message: 'درخواست شما با موفقیت ثبت و در صف پردازش قرار گرفت',
        runId: run.id,
        status: run.status || 'queued',
        task: validation.input.task,
        ...(validation.input.repository ? { repository: validation.input.repository } : {}),
        ...(validation.input.connectionId ? { connectionId: validation.input.connectionId } : {}),
        ...(validation.input.runtimeEnvironment ? { runtimeEnvironment: validation.input.runtimeEnvironment } : {}),
        createdAt: run.createdAt,
      },
      { status: 202 },
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
        error: 'خطا در ثبت وظیفه دستیار',
        code: 'INTERNAL_ERROR',
        message: 'خطا در ثبت وظیفه دستیار',
        retryable: false,
      },
      { status: 500 },
    );
  }
}

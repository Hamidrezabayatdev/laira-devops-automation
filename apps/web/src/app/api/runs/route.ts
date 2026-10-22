import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';
import { verifyRequestOrigin } from '@/lib/security/origin';
import { dbAdapter, DatabaseUnavailableError, isAllowedRunType, ALLOWED_RUN_TYPES } from '@/lib/db/adapter-bridge';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024; // 16 KiB bounded payload
const SECRET_KEY_PATTERN = /(?:secret|token|password|auth|bearer|credential|private|key)/i;

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

  // 4. Content-Length pre-check & streaming size cap
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

    // 10 second finite read timeout to prevent stalled bodies
    const readTimeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(new Error('READ_TIMEOUT'));
      }, 10_000);
    });

    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), readTimeoutPromise]);
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          // Non-await safe cancel on overflow and return 413
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
        // Safe ignore if lock already released or stream closed
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

  // 5. Safe JSON parse and object structure validation
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

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Response.json(
      {
        error: 'بدنه درخواست باید یک شیء JSON معتبر باشد',
        code: 'INVALID_PAYLOAD',
        message: 'بدنه درخواست باید یک شیء JSON معتبر باشد',
        retryable: false,
      },
      { status: 400 },
    );
  }

  const rawBody = parsed as Record<string, unknown>;

  // 6. Validate and bound title
  let title: string | undefined;
  if (rawBody.title !== undefined) {
    if (typeof rawBody.title !== 'string') {
      return Response.json(
        {
          error: 'عنوان باید رشته متنی باشد',
          code: 'INVALID_TITLE',
          message: 'عنوان باید رشته متنی باشد',
          retryable: false,
        },
        { status: 400 },
      );
    }
    const trimmedTitle = rawBody.title.trim();
    if (trimmedTitle.length > 200) {
      return Response.json(
        {
          error: 'طول عنوان نباید بیشتر از ۲۰۰ کاراکتر باشد',
          code: 'TITLE_TOO_LONG',
          message: 'طول عنوان نباید بیشتر از ۲۰۰ کاراکتر باشد',
          retryable: false,
        },
        { status: 400 },
      );
    }
    title = trimmedTitle || undefined;
  }

  // 7. Validate run type
  let runType = 'demo_fixture';
  if (rawBody.type !== undefined) {
    if (typeof rawBody.type !== 'string') {
      return Response.json(
        {
          error: 'نوع اجرا باید رشته باشد',
          code: 'INVALID_RUN_TYPE',
          message: 'نوع اجرا باید رشته باشد',
          retryable: false,
        },
        { status: 400 },
      );
    }
    runType = rawBody.type;
  }

  if (!isAllowedRunType(runType)) {
    return Response.json(
      {
        error: `نوع اجرای نامعتبر است. تنها مقادیر مجاز: ${ALLOWED_RUN_TYPES.join(', ')}`,
        code: 'INVALID_RUN_TYPE',
        message: `نوع اجرای نامعتبر است. تنها مقادیر مجاز: ${ALLOWED_RUN_TYPES.join(', ')}`,
        retryable: false,
      },
      { status: 400 },
    );
  }

  // 8. Validate & sanitize metadata (bounded fixture fields, no arbitrary secret echo)
  let safeMetadata: Record<string, unknown> | undefined;
  if (rawBody.metadata !== undefined) {
    if (!rawBody.metadata || typeof rawBody.metadata !== 'object' || Array.isArray(rawBody.metadata)) {
      return Response.json(
        {
          error: 'متادیتا باید یک شیء معتبر باشد',
          code: 'INVALID_METADATA',
          message: 'متادیتا باید یک شیء معتبر باشد',
          retryable: false,
        },
        { status: 400 },
      );
    }

    const rawMeta = rawBody.metadata as Record<string, unknown>;
    const keys = Object.keys(rawMeta);
    if (keys.length > 20) {
      return Response.json(
        {
          error: 'تعداد فیلدهای متادیتا بیش از حد مجاز است',
          code: 'METADATA_TOO_LARGE',
          message: 'تعداد فیلدهای متادیتا بیش از حد مجاز است',
          retryable: false,
        },
        { status: 400 },
      );
    }

    safeMetadata = {};
    for (const key of keys) {
      if (key.length > 50) continue;
      // Filter out secret-bearing field names
      if (SECRET_KEY_PATTERN.test(key)) continue;

      const val = rawMeta[key];
      if (val === null || typeof val === 'boolean' || typeof val === 'number') {
        safeMetadata[key] = val;
      } else if (typeof val === 'string') {
        if (val.length <= 500) {
          safeMetadata[key] = val;
        }
      }
    }
  }

  // 9. Create durable fixture run in real DB (status 202 Accepted)
  try {
    const run = await dbAdapter.createRun(auth.user.workspaceId, {
      title,
      type: runType,
      metadata: safeMetadata,
    });

    return Response.json(
      {
        message: 'Run created successfully and queued for execution',
        run,
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
        error: 'خطا در ثبت اجرا',
        code: 'INTERNAL_ERROR',
        message: 'خطا در ثبت اجرا',
        retryable: false,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
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
    const runs = await dbAdapter.listRuns(auth.user.workspaceId);
    return Response.json({ runs }, { status: 200 });
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
        error: 'خطا در دریافت لیست اجراها',
        code: 'INTERNAL_ERROR',
        message: 'خطا در دریافت لیست اجراها',
        retryable: false,
      },
      { status: 500 },
    );
  }
}

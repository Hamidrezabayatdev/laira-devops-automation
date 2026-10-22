import crypto from 'node:crypto';
import pg from 'pg';
import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';
import { verifyRequestOrigin } from '@/lib/security/origin';
import { dbAdapter, DatabaseUnavailableError } from '@/lib/db/adapter-bridge';
import {
  createConnection,
  listConnections,
  addCredentialVersion,
} from '@laira/db';
import {
  encryptCredential,
  normalizeKey,
} from '@laira/security';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8 * 1024; // 8 KiB bounded JSON payload
const ALLOWED_PROVIDERS = ['liara', 'boxapi'] as const;
type AllowedProvider = (typeof ALLOWED_PROVIDERS)[number];

const ALLOWED_KEYS = new Set(['provider', 'name', 'apiKey']);

export async function GET(request: Request) {
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

  // 2. Owner-only authorization
  if (auth.user.role !== 'owner') {
    return Response.json(
      {
        error: 'تنها مالک فضای کاری مجاز به مشاهده اتصالات است (Forbidden: owner role required)',
        code: 'FORBIDDEN',
        message: 'تنها مالک فضای کاری مجاز به مشاهده اتصالات است',
        retryable: false,
      },
      { status: 403 },
    );
  }

  // 3. Retrieve connections for the authenticated tenant workspace
  try {
    const pool = dbAdapter.getPool();
    const connections = await listConnections(pool, {
      workspaceId: auth.user.workspaceId,
    });

    // Strictly project provider, name, id, status only - NEVER return ciphertext or raw credential
    const safeConnections = connections.map((conn) => ({
      id: conn.id,
      name: conn.name,
      provider: conn.provider,
      status: conn.status === 'active' ? 'configured_unverified' : conn.status,
    }));

    return Response.json({ connections: safeConnections }, { status: 200 });
  } catch (err: unknown) {
    if (err instanceof DatabaseUnavailableError) {
      return Response.json(
        {
          error: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
          code: 'DB_UNAVAILABLE',
          message: 'سرویس پایگاه‌داده در دسترس نیست',
          retryable: true,
        },
        { status: 503 },
      );
    }
    return Response.json(
      {
        error: 'خطای داخلی سرور در دریافت اتصالات',
        code: 'INTERNAL_ERROR',
        message: 'خطای داخلی سرور در دریافت اتصالات',
        retryable: false,
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  // 1. Same-origin verification for browser mutations
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

  // 3. Owner-only authorization
  if (auth.user.role !== 'owner') {
    return Response.json(
      {
        error: 'تنها مالک فضای کاری مجاز به ثبت اتصال است (Forbidden: owner role required)',
        code: 'FORBIDDEN',
        message: 'تنها مالک فضای کاری مجاز به ثبت اتصال است',
        retryable: false,
      },
      { status: 403 },
    );
  }

  // 4. Server master encryption key policy check (fail-closed 503 static error)
  const rawMasterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!rawMasterKey || !rawMasterKey.trim()) {
    return Response.json(
      {
        error: 'سرویس رمزنگاری سرور پیکربندی نشده است (503 Service Unavailable)',
        code: 'ENCRYPTION_KEY_UNAVAILABLE',
        message: 'سرویس رمزنگاری سرور پیکربندی نشده است',
        retryable: false,
      },
      { status: 503 },
    );
  }

  let normalizedMasterKey: Buffer;
  try {
    normalizedMasterKey = normalizeKey(rawMasterKey);
  } catch {
    return Response.json(
      {
        error: 'کلید رمزنگاری سرور نامعتبر است (503 Service Unavailable)',
        code: 'ENCRYPTION_KEY_INVALID',
        message: 'کلید رمزنگاری سرور نامعتبر است',
        retryable: false,
      },
      { status: 503 },
    );
  }

  // 5. Content-Type validation: exact media type application/json is required
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

  // 6. Content-Length pre-check & bounded stream consumption (8 KiB)
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return Response.json(
      {
        error: 'حجم درخواست بیش از حد مجاز است (حداکثر ۸ کیلوبایت)',
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
          reader.cancel().catch(() => {});
          return Response.json(
            {
              error: 'حجم درخواست بیش از حد مجاز است (حداکثر ۸ کیلوبایت)',
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

  // 7. Safe JSON parse
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
        error: 'بدنه درخواست باید یک شیء معتبر JSON باشد',
        code: 'INVALID_REQUEST_BODY',
        message: 'بدنه درخواست باید یک شیء معتبر JSON باشد',
        retryable: false,
      },
      { status: 400 },
    );
  }

  // 8. Strict key validation: disallow extra keys/URL/team if not needed
  const bodyObj = parsed as Record<string, unknown>;
  const keys = Object.keys(bodyObj);
  const extraKeys = keys.filter((k) => !ALLOWED_KEYS.has(k));
  if (extraKeys.length > 0) {
    return Response.json(
      {
        error: `فیلدهای اضافی مجاز نیستند: ${extraKeys.join(', ')}`,
        code: 'EXTRA_KEYS_DISALLOWED',
        message: `فیلدهای اضافی مجاز نیستند: ${extraKeys.join(', ')}`,
        retryable: false,
      },
      { status: 400 },
    );
  }

  // 9. Field-level validation
  const provider = bodyObj.provider;
  if (
    typeof provider !== 'string' ||
    !ALLOWED_PROVIDERS.includes(provider as AllowedProvider)
  ) {
    return Response.json(
      {
        error: `ارائه‌دهنده نامعتبر است. ارائه‌دهندگان مجاز: ${ALLOWED_PROVIDERS.join(', ')}`,
        code: 'INVALID_PROVIDER',
        message: `ارائه‌دهنده نامعتبر است. ارائه‌دهندگان مجاز: ${ALLOWED_PROVIDERS.join(', ')}`,
        retryable: false,
      },
      { status: 400 },
    );
  }

  const name = bodyObj.name;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 80
  ) {
    return Response.json(
      {
        error: 'نام اتصال باید رشته‌ای غیرخالی با حداکثر ۸۰ نویسه باشد',
        code: 'INVALID_NAME',
        message: 'نام اتصال باید رشته‌ای غیرخالی با حداکثر ۸۰ نویسه باشد',
        retryable: false,
      },
      { status: 400 },
    );
  }

  const apiKey = bodyObj.apiKey;
  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    apiKey.length > 4096
  ) {
    return Response.json(
      {
        error: 'کلید دسترسی (apiKey) باید رشته‌ای غیرخالی با حداکثر ۴۰۹۶ نویسه باشد',
        code: 'INVALID_API_KEY',
        message: 'کلید دسترسی (apiKey) باید رشته‌ای غیرخالی با حداکثر ۴۰۹۶ نویسه باشد',
        retryable: false,
      },
      { status: 400 },
    );
  }

  // 10. Generate cryptographically random connection ID & encrypt credential with workspace+connection AAD
  const connectionId = `conn_${crypto.randomUUID().replace(/-/g, '')}`;
  const workspaceId = auth.user.workspaceId;

  let envelope: ReturnType<typeof encryptCredential>;
  try {
    envelope = encryptCredential(
      apiKey.trim(),
      normalizedMasterKey,
      {
        workspaceId,
        connectionId,
        version: 1,
      },
      1,
    );
  } catch {
    return Response.json(
      {
        error: 'خطای داخلی در رمزنگاری کلید دسترسی',
        code: 'ENCRYPTION_FAILED',
        message: 'خطای داخلی در رمزنگاری کلید دسترسی',
        retryable: false,
      },
      { status: 500 },
    );
  }

  // 11. Atomic database transaction: create connection, add credential envelope, update status
  let pool: pg.Pool;
  try {
    pool = dbAdapter.getPool();
  } catch (err: unknown) {
    if (err instanceof DatabaseUnavailableError) {
      return Response.json(
        {
          error: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
          code: 'DB_UNAVAILABLE',
          message: 'سرویس پایگاه‌داده در دسترس نیست',
          retryable: true,
        },
        { status: 503 },
      );
    }
    return Response.json(
      {
        error: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
        code: 'DB_UNAVAILABLE',
        message: 'سرویس پایگاه‌داده در دسترس نیست',
        retryable: true,
      },
      { status: 503 },
    );
  }

  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return Response.json(
      {
        error: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
        code: 'DB_UNAVAILABLE',
        message: 'سرویس پایگاه‌داده در دسترس نیست',
        retryable: true,
      },
      { status: 503 },
    );
  }
  try {
    await client.query('BEGIN');

    await createConnection(
      client,
      { workspaceId },
      {
        id: connectionId,
        name: name.trim(),
        provider,
      },
    );

    await addCredentialVersion(
      client,
      { workspaceId },
      connectionId,
      envelope,
    );

    // Update connection status explicitly to configured_unverified (truthful readiness)
    await client.query(
      `UPDATE app.connections
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND workspace_id = $3`,
      ['configured_unverified', connectionId, workspaceId],
    );

    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Safe ignore rollback error
    }
    return Response.json(
      {
        error: 'خطا در ثبت اتصال در پایگاه داده',
        code: 'DB_TRANSACTION_ERROR',
        message: 'خطا در ثبت اتصال در پایگاه داده',
        retryable: true,
      },
      { status: 500 },
    );
  } finally {
    client.release();
  }

  // 12. Return 201 with truthful status 'configured_unverified' - never claim verified without test execution
  // Ciphertext and raw apiKey are strictly omitted from response
  return Response.json(
    {
      id: connectionId,
      provider,
      status: 'configured_unverified',
    },
    { status: 201 },
  );
}

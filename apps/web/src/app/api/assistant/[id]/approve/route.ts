import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';
import { verifyRequestOrigin } from '@/lib/security/origin';
import { approveAgentAction, getDatabasePool } from '@laira/db';

export const dynamic = 'force-dynamic';

/** Approval is an authenticated owner action, never an agent tool. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!verifyRequestOrigin(request).valid) {
    return Response.json({ code: 'ORIGIN_MISMATCH', error: 'Untrusted origin' }, { status: 403 });
  }
  const auth = await resolveAuthenticatedWorkspace(request);
  if (!auth.authenticated || !auth.user) {
    return Response.json({ code: auth.status === 503 ? 'DB_UNAVAILABLE' : 'UNAUTHORIZED', error: 'Authentication required' }, { status: auth.status || 401 });
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return Response.json({ code: 'UNSUPPORTED_MEDIA_TYPE', error: 'JSON required' }, { status: 415 });
  }
  const { id } = await context.params;
  if (!/^run_[a-zA-Z0-9_-]{1,100}$/.test(id)) {
    return Response.json({ code: 'INVALID_REQUEST', error: 'Invalid approval request' }, { status: 400 });
  }
  let body: unknown;
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ code: 'INVALID_REQUEST', error: 'Invalid approval request' }, { status: 400 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10_000); });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const item = await Promise.race([reader.read(), timeout]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 1024) throw new Error('limit');
      chunks.push(item.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    void reader.cancel().catch(() => {});
    return Response.json({ code: 'INVALID_REQUEST', error: 'Invalid approval request' }, { status: 400 });
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !('proposalHash' in body) || typeof body.proposalHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.proposalHash)) {
    return Response.json({ code: 'INVALID_REQUEST', error: 'Invalid approval request' }, { status: 400 });
  }
  try {
    const run = await approveAgentAction(getDatabasePool(), { workspaceId: auth.user.workspaceId }, {
      sourceRunId: id, proposalHash: body.proposalHash, ownerId: auth.user.id,
    });
    return Response.json({ runId: run.id, status: run.status }, { status: 202 });
  } catch (error) {
    // Do not expose DB errors, proposal data, credential identifiers or provider diagnostics.
    const code = (error as { code?: unknown })?.code;
    const unavailable = code === 'ECONNREFUSED' || code === '57P01';
    return Response.json({ code: unavailable ? 'DB_UNAVAILABLE' : 'APPROVAL_REJECTED', error: unavailable ? 'Service unavailable' : 'Approval is stale, unavailable or does not match this workspace' }, { status: unavailable ? 503 : 409 });
  }
}

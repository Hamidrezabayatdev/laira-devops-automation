import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), origin: vi.fn(), approve: vi.fn(), pool: {} }));
vi.mock('@/lib/auth/session', () => ({ resolveAuthenticatedWorkspace: mocks.auth }));
vi.mock('@/lib/security/origin', () => ({ verifyRequestOrigin: mocks.origin }));
vi.mock('@laira/db', () => ({ approveAgentAction: mocks.approve, getDatabasePool: () => mocks.pool }));
import { POST } from '../src/app/api/assistant/[id]/approve/route';

const hash = 'a'.repeat(64);
const context = { params: Promise.resolve({ id: 'run_source' }) };
const request = (body: unknown = { proposalHash: hash }) => new Request('http://localhost/api/assistant/run_source/approve', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.origin.mockReturnValue({ valid: true });
  mocks.auth.mockResolvedValue({ authenticated: true, user: { id: 'owner', workspaceId: 'ws_owner' } });
  mocks.approve.mockResolvedValue({ id: 'run_action', status: 'queued' });
});

describe('explicit assistant action approval', () => {
  it('binds approval to authenticated owner/workspace and exact hash', async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: 'run_action', status: 'queued' });
    expect(mocks.approve).toHaveBeenCalledWith(mocks.pool, { workspaceId: 'ws_owner' }, { sourceRunId: 'run_source', proposalHash: hash, ownerId: 'owner' });
  });
  it('requires a valid session before creating approval', async () => {
    mocks.auth.mockResolvedValue({ authenticated: false, status: 401 });
    expect((await POST(request(), context)).status).toBe(401);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('rejects a cross-origin approval', async () => {
    mocks.origin.mockReturnValue({ valid: false });
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it.each([{ proposalHash: hash, workspaceId: 'foreign' }, { proposalHash: 'wrong' }, { decision: 'approved' }, { proposalHash: hash, action: {} }])('rejects additional authority or invalid approval data', async body => {
    expect((await POST(request(body), context)).status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('maps stale/foreign approval failure without raw diagnostics', async () => {
    mocks.approve.mockRejectedValue(new Error('PRIVATE_PROVIDER_SECRET_CANARY'));
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('PRIVATE_PROVIDER_SECRET_CANARY');
  });
  it('bounds the request body', async () => {
    expect((await POST(request({ proposalHash: 'a'.repeat(2000) }), context)).status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
});

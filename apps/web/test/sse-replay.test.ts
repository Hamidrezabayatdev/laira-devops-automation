import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET as getEventsRoute } from '@/app/api/runs/[id]/events/route';
import { dbAdapter } from '@/lib/db/adapter-bridge';
import type { Run, RunEvent } from '@/lib/runs/repository';
import { createTestSession } from './helpers/test-session';

describe('Authenticated SSE Monotonic Replay & Terminal Gap Tests', () => {
  const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

  const mockWorkspaceId = 'ws_mock_tenant_1';
  const mockRunId = 'run_deterministic_test_123';

  const mockLookupResult = {
    sessionToken: 'mock_session_token_123',
    userId: 'usr_mock_1',
    workspaceId: mockWorkspaceId,
    user: {
      id: 'usr_mock_1',
      name: 'Test Dev',
      email: 'dev@liara.ir',
      githubNumericId: '152868728',
    },
    workspace: {
      id: mockWorkspaceId,
      name: 'Test Tenant Workspace',
      ownerUserId: 'usr_mock_1',
      githubUserId: '152868728',
    },
  };

  const createMockRun = (state: Run['state']): Run => ({
    id: mockRunId,
    runId: mockRunId,
    workspaceId: mockWorkspaceId,
    title: 'Deterministic Test Run',
    type: 'demo_fixture',
    state,
    status: state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const createMockEvent = (seq: number, type: string): RunEvent => ({
    id: `evt_${seq}`,
    eventId: `evt_${seq}`,
    runId: mockRunId,
    workspaceId: mockWorkspaceId,
    seq,
    sequenceNumber: seq,
    type,
    payload: { seq, type },
    safePayload: { seq, type, info: 'safe-public-data' },
    createdAt: new Date().toISOString(),
    timestamp: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Deterministic Actual-Route Unit Tests (Interleaving & Gap Resolution)', () => {
    it('resolves terminal event gap by draining committed events after terminal state is observed', async () => {
      vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(mockLookupResult as any);

      let getRunCallCount = 0;
      vi.spyOn(dbAdapter, 'getRun').mockImplementation(async () => {
        getRunCallCount++;
        if (getRunCallCount <= 2) {
          return createMockRun('running');
        }
        return createMockRun('succeeded');
      });

      let getEventsCallCount = 0;
      vi.spyOn(dbAdapter, 'getEvents').mockImplementation(async (_ws, _id, _afterSeq) => {
        getEventsCallCount++;
        if (getEventsCallCount === 1) {
          return [createMockEvent(1, 'run_started')];
        }
        if (getEventsCallCount === 2) {
          return [];
        }
        // Post-terminal drain call: returns the final terminal event
        if (getEventsCallCount === 3) {
          return [createMockEvent(2, 'run_completed')];
        }
        return [];
      });

      const req = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
        },
      });

      const res = await getEventsRoute(req, {
        params: Promise.resolve({ id: mockRunId }),
      });

      expect(res.status).toBe(200);
      const sseText = await res.text();

      // Verify event #1 was received
      expect(sseText).toContain('id: 1\nevent: run_started\n');

      // CRITICAL ACCEPTANCE: Verify event #2 (terminal event) was drained after terminal state was observed!
      expect(sseText).toContain('id: 2\nevent: run_completed\n');

      // Verify terminal stream closure comment
      expect(sseText).toContain(': stream closed (run reached terminal state)\n\n');

      // Verify event #2 appeared BEFORE the stream closed
      const idxEvent2 = sseText.indexOf('id: 2\nevent: run_completed');
      const idxClose = sseText.indexOf(': stream closed (run reached terminal state)');
      expect(idxEvent2).toBeGreaterThan(-1);
      expect(idxClose).toBeGreaterThan(idxEvent2);
    });

    it('iteratively drains multiple pages of events (>1000 items) across batches before closing on terminal state', async () => {
      vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(mockLookupResult as any);
      vi.spyOn(dbAdapter, 'getRun').mockResolvedValue(createMockRun('succeeded'));

      // Simulate repository returning batches of 1000, 1000, 500 events (total 2500 events)
      vi.spyOn(dbAdapter, 'getEvents').mockImplementation(async (_ws, _id, afterSeq = 0) => {
        if (afterSeq === 0) {
          const batch: RunEvent[] = [];
          for (let i = 1; i <= 1000; i++) {
            batch.push(createMockEvent(i, i === 1 ? 'run_started' : 'step_progress'));
          }
          return batch;
        } else if (afterSeq === 1000) {
          const batch: RunEvent[] = [];
          for (let i = 1001; i <= 2000; i++) {
            batch.push(createMockEvent(i, 'step_progress'));
          }
          return batch;
        } else if (afterSeq === 2000) {
          const batch: RunEvent[] = [];
          for (let i = 2001; i <= 2500; i++) {
            batch.push(createMockEvent(i, i === 2500 ? 'run_completed' : 'step_progress'));
          }
          return batch;
        }
        return [];
      });

      const req = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
        },
      });

      const res = await getEventsRoute(req, {
        params: Promise.resolve({ id: mockRunId }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();

      // Verify first batch event
      expect(text).toContain('id: 1\n');
      expect(text).toContain('id: 1000\n');
      // Verify second batch event
      expect(text).toContain('id: 1001\n');
      expect(text).toContain('id: 2000\n');
      // Verify third batch event
      expect(text).toContain('id: 2001\n');
      expect(text).toContain('id: 2500\n');
      // Verify stream closed after all 2500 events
      expect(text).toContain(': stream closed (run reached terminal state)\n\n');

      const matches = text.match(/id: /g);
      expect(matches?.length).toBe(2500);
    });

    it('rejects malformed Last-Event-ID values like 2junk or Infinity and falls back safely to sequence 0', async () => {
      vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(mockLookupResult as any);
      vi.spyOn(dbAdapter, 'getRun').mockResolvedValue(createMockRun('succeeded'));

      const queriedSequences: number[] = [];
      vi.spyOn(dbAdapter, 'getEvents').mockImplementation(async (_ws, _id, afterSeq = 0) => {
        queriedSequences.push(afterSeq);
        return [];
      });

      // 1. Test trailing garbage: '2junk'
      queriedSequences.length = 0;
      const reqGarbage = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
          'last-event-id': '2junk',
        },
      });
      await (await getEventsRoute(reqGarbage, { params: Promise.resolve({ id: mockRunId }) })).text();
      expect(queriedSequences[0]).toBe(0); // Safely defaulted to 0

      // 2. Test 'Infinity'
      queriedSequences.length = 0;
      const reqInf = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
          'last-event-id': 'Infinity',
        },
      });
      await (await getEventsRoute(reqInf, { params: Promise.resolve({ id: mockRunId }) })).text();
      expect(queriedSequences[0]).toBe(0);

      // 3. Test negative '-10'
      queriedSequences.length = 0;
      const reqNeg = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
          'last-event-id': '-10',
        },
      });
      await (await getEventsRoute(reqNeg, { params: Promise.resolve({ id: mockRunId }) })).text();
      expect(queriedSequences[0]).toBe(0);

      // 4. Test valid integer '42'
      queriedSequences.length = 0;
      const reqValid = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
          'last-event-id': '42',
        },
      });
      await (await getEventsRoute(reqValid, { params: Promise.resolve({ id: mockRunId }) })).text();
      expect(queriedSequences[0]).toBe(42);
    });

    it('handles >50 batches without false terminal closure, continuing until all batches are drained', async () => {
      vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(mockLookupResult as any);
      vi.spyOn(dbAdapter, 'getRun').mockResolvedValue(createMockRun('succeeded'));

      // 55 batches of 2 items each = 110 items total
      vi.spyOn(dbAdapter, 'getEvents').mockImplementation(async (_ws, _id, afterSeq = 0) => {
        if (afterSeq < 110) {
          const nextSeq1 = afterSeq + 1;
          const nextSeq2 = Math.min(afterSeq + 2, 110);
          if (nextSeq1 === nextSeq2) {
            return [createMockEvent(nextSeq1, 'batch_step')];
          }
          return [
            createMockEvent(nextSeq1, 'batch_step'),
            createMockEvent(nextSeq2, nextSeq2 === 110 ? 'run_completed' : 'batch_step'),
          ];
        }
        return [];
      });

      const req = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
        },
      });

      const res = await getEventsRoute(req, {
        params: Promise.resolve({ id: mockRunId }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();

      // Check first event, batch 50 event (seq 100), and final event 110
      expect(text).toContain('id: 1\n');
      expect(text).toContain('id: 100\n');
      expect(text).toContain('id: 110\nevent: run_completed\n');
      expect(text).toContain(': stream closed (run reached terminal state)\n\n');

      const matches = text.match(/id: /g);
      expect(matches?.length).toBe(110);

      // Verify terminal comment only occurred after the last event #110
      const idx110 = text.indexOf('id: 110\nevent: run_completed');
      const idxClose = text.indexOf(': stream closed (run reached terminal state)');
      expect(idx110).toBeGreaterThan(-1);
      expect(idxClose).toBeGreaterThan(idx110);
    });

    it('strictly enforces cursor > current to eliminate duplicate events from delayed or overlapping repo responses', async () => {
      vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(mockLookupResult as any);
      vi.spyOn(dbAdapter, 'getRun').mockResolvedValue(createMockRun('succeeded'));

      let callCount = 0;
      vi.spyOn(dbAdapter, 'getEvents').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Initial replay returns events #1 and #2
          return [createMockEvent(1, 'run_started'), createMockEvent(2, 'step_1_done')];
        }
        if (callCount === 2) {
          // Post-terminal drain returns overlapping event #2 and new event #3
          return [createMockEvent(2, 'step_1_done'), createMockEvent(3, 'run_completed')];
        }
        return [];
      });

      const req = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
        },
      });

      const res = await getEventsRoute(req, {
        params: Promise.resolve({ id: mockRunId }),
      });

      const text = await res.text();

      // Count occurrences of each event id in output
      const count1 = (text.match(/id: 1\n/g) || []).length;
      const count2 = (text.match(/id: 2\n/g) || []).length;
      const count3 = (text.match(/id: 3\n/g) || []).length;

      expect(count1).toBe(1);
      expect(count2).toBe(1); // EXACTLY ONE, duplicate rejected by strict cursor > currentSeq
      expect(count3).toBe(1);
    });

    it('cancels stream cleanly without errors on client abort', async () => {
      vi.spyOn(dbAdapter, 'lookupWorkspaceBySessionToken').mockResolvedValue(mockLookupResult as any);
      vi.spyOn(dbAdapter, 'getRun').mockResolvedValue(createMockRun('running'));
      vi.spyOn(dbAdapter, 'getEvents').mockResolvedValue([createMockEvent(1, 'run_started')]);

      const req = new Request(`http://localhost:3000/api/runs/${mockRunId}/events`, {
        method: 'GET',
        headers: {
          authorization: 'Bearer mock_session_token_123',
        },
      });

      const res = await getEventsRoute(req, {
        params: Promise.resolve({ id: mockRunId }),
      });

      expect(res.body).toBeDefined();
      const reader = res.body!.getReader();

      // Read initial chunk
      const { value } = await reader.read();
      const decoded = new TextDecoder().decode(value);
      expect(decoded).toContain('id: 1\nevent: run_started\n');

      // Client aborts/cancels stream
      await expect(reader.cancel()).resolves.toBeUndefined();
    });
  });

  describe('Live Integration Database Tests (if DB available)', () => {
    it.skipIf(!hasDb)('streams events formatted with SSE protocol and respects Last-Event-ID replay', async () => {
      const session = await createTestSession({ githubNumericId: '152868728' });
      const workspaceId = session.workspaceId;

      const run = await dbAdapter.createRun(workspaceId, { title: 'SSE Test Run' });
      await dbAdapter.cancelRun(workspaceId, run.runId);

      const req = new Request(`http://localhost:3000/api/runs/${run.runId}/events`, {
        method: 'GET',
        headers: {
          ...session.headers,
          'last-event-id': '1',
        },
      });

      const res = await getEventsRoute(req, {
        params: Promise.resolve({ id: run.runId }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/event-stream');

      const text = await res.text();
      expect(text).not.toContain('id: 1\n');
      expect(text).toContain('id: 2\n');
    });

    it('rejects unauthenticated SSE connection with 401', async () => {
      const req = new Request('http://localhost:3000/api/runs/any-id/events', {
        method: 'GET',
      });

      const res = await getEventsRoute(req, {
        params: Promise.resolve({ id: 'any-id' }),
      });
      expect(res.status).toBe(401);
    });

    it.skipIf(!hasDb)('rejects cross-workspace SSE connection with 404', async () => {
      const session1 = await createTestSession({ githubNumericId: '152868728' });
      const session2 = await createTestSession({ githubNumericId: '999999999' });

      const run = await dbAdapter.createRun(session1.workspaceId, { title: 'Isolated SSE' });

      const req = new Request(`http://localhost:3000/api/runs/${run.runId}/events`, {
        method: 'GET',
        headers: session2.headers,
      });

      const res = await getEventsRoute(req, {
        params: Promise.resolve({ id: run.runId }),
      });
      expect(res.status).toBe(404);
    });
  });
});

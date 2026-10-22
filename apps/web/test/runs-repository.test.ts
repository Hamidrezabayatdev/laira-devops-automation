import { describe, it, expect } from 'vitest';
import { runsRepository } from '@/lib/runs/repository';

describe('RunsRepository & Event Sequence Durability', () => {
  const ws1 = 'ws_gh_111111';
  const ws2 = 'ws_gh_222222';

  it('creates a durable run in queued state with initial sequence event #1', async () => {
    const run = await runsRepository.createRun(ws1, {
      title: 'بررسی پیکربندی برنامه',
      type: 'diagnostic',
    });

    expect(run.runId).toMatch(/^run_/);
    expect(run.workspaceId).toBe(ws1);
    expect(run.state).toBe('queued');

    const events = await runsRepository.getEvents(ws1, run.runId);
    expect(events.length).toBe(1);
    expect(events[0]?.sequenceNumber).toBe(1);
    expect(events[0]?.type).toBe('run.queued');
  });

  it('strictly enforces workspace scope isolation between tenants', async () => {
    const run = await runsRepository.createRun(ws1, {
      title: 'اجرای تننت ۱',
    });

    // Tenant 1 can read its own run
    const found1 = await runsRepository.getRun(ws1, run.runId);
    expect(found1).not.toBeNull();
    expect(found1?.runId).toBe(run.runId);

    // Tenant 2 CANNOT read Tenant 1 run
    const found2 = await runsRepository.getRun(ws2, run.runId);
    expect(found2).toBeNull();

    // Tenant 2 cannot read events
    const events2 = await runsRepository.getEvents(ws2, run.runId);
    expect(events2.length).toBe(0);
  });

  it('appends monotonic events in strictly increasing sequence numbers', async () => {
    const run = await runsRepository.createRun(ws1, { title: 'تست توالی' });

    const e2 = await runsRepository.addEvent(ws1, run.runId, 'run.running', { step: 1 });
    const e3 = await runsRepository.addEvent(ws1, run.runId, 'run.verifying', { step: 2 });
    const e4 = await runsRepository.addEvent(ws1, run.runId, 'run.completed', { step: 3 });

    expect(e2.sequenceNumber).toBe(2);
    expect(e3.sequenceNumber).toBe(3);
    expect(e4.sequenceNumber).toBe(4);

    // Replay with Last-Event-ID = 2
    const replayed = await runsRepository.getEvents(ws1, run.runId, 2);
    expect(replayed.length).toBe(2);
    expect(replayed[0]?.sequenceNumber).toBe(3);
    expect(replayed[1]?.sequenceNumber).toBe(4);
  });

  it('cancels active run and records cancellation event', async () => {
    const run = await runsRepository.createRun(ws1, { title: 'اجرای لغو شدنی' });
    expect(run.state).toBe('queued');

    const result = await runsRepository.cancelRun(ws1, run.runId);
    expect(result.success).toBe(true);
    expect(result.run?.state).toBe('cancelled');

    // Cancelling again returns failure (cannot cancel terminal state)
    const result2 = await runsRepository.cancelRun(ws1, run.runId);
    expect(result2.success).toBe(false);

    // Verify cancellation event was appended
    const events = await runsRepository.getEvents(ws1, run.runId);
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.type).toBe('run.cancelled');
  });
});

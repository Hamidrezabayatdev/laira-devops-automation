import { describe, expect, it } from 'vitest';
import { BoxApiClient } from '../src/boxapi/client.ts';

function client(fetchFn: typeof fetch) {
  return new BoxApiClient({ apiKey: 'offline-cancellation-key', keyMode: 'byok', workspaceId: 'ws_cancel', ownerId: 'owner_cancel', fetchFn });
}

describe('agent cancellation reaches official SDK transport', () => {
  it('does not dispatch a previously aborted request', async () => {
    let calls = 0;
    const api = client(async () => { calls++; return new Response('{}'); });
    const signal = AbortSignal.abort();
    await expect(api.chat({ runId: 'run_preabort', messages: [{ role: 'user', content: 'inspect' }], signal })).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
  it('aborts an in-flight transport without retrying', async () => {
    const controller = new AbortController();
    let calls = 0;
    let observedAbort = false;
    let dispatch!: () => void;
    const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
    const api = client(async (_url, init) => {
      calls++;
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { observedAbort = true; reject(new DOMException('Aborted', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true });
        dispatch();
        if (signal?.aborted) abort();
      });
    });
    const pending = api.chat({ runId: 'run_inflight', messages: [{ role: 'user', content: 'inspect' }], signal: controller.signal });
    const rejection = expect(pending).rejects.toBeDefined();
    await dispatched;
    controller.abort();
    await rejection;
    expect(observedAbort).toBe(true);
    expect(calls).toBe(1);
  });
});

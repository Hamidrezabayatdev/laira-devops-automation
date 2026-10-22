import { resolveAuthenticatedWorkspace } from '@/lib/auth/session';
import { dbAdapter, DatabaseUnavailableError } from '@/lib/db/adapter-bridge';
import type { RunEvent } from '@/lib/runs/repository';

export const dynamic = 'force-dynamic';

function formatSseEvent(event: RunEvent): string {
  const data = JSON.stringify({
    eventId: event.eventId,
    runId: event.runId,
    workspaceId: event.workspaceId,
    sequenceNumber: event.sequenceNumber,
    type: event.type,
    safePayload: event.safePayload,
    timestamp: event.timestamp,
  });

  return `id: ${event.sequenceNumber}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;

  // 1. Authenticate & resolve workspace
  const auth = await resolveAuthenticatedWorkspace(request);
  if (!auth.authenticated || !auth.user) {
    const status = auth.status || 401;
    return new Response(
      JSON.stringify({
        error: auth.error || 'Unauthorized',
        code: status === 503 ? 'DB_UNAVAILABLE' : 'UNAUTHORIZED',
        message: auth.error || 'Unauthorized',
        retryable: status === 503,
      }),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // Narrow user & workspaceId for stream closure
  const authenticatedWorkspaceId = auth.user.workspaceId;

  // 2. Validate run exists within this workspace
  try {
    const run = await dbAdapter.getRun(authenticatedWorkspaceId, id);
    if (!run) {
      return new Response(
        JSON.stringify({
          error: `Run with ID '${id}' not found in current workspace.`,
          code: 'RUN_NOT_FOUND',
          message: `Run with ID '${id}' not found in current workspace.`,
          retryable: false,
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  } catch (err: unknown) {
    if (err instanceof DatabaseUnavailableError) {
      return new Response(
        JSON.stringify({
          error: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
          code: 'DB_UNAVAILABLE',
          message: 'سرویس پایگاه‌داده در دسترس نیست (503 Service Unavailable)',
          retryable: true,
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    return new Response(
      JSON.stringify({
        error: 'Database error',
        code: 'INTERNAL_ERROR',
        message: 'Database error',
        retryable: false,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // 3. Determine monotonic replay starting point from Last-Event-ID header
  // Strict non-negative safe integer validation: rejects '2junk', 'Infinity', negative, floats
  const lastEventIdHeader = request.headers.get('last-event-id');
  let currentSeq = 0;
  if (lastEventIdHeader !== null && lastEventIdHeader !== undefined) {
    const trimmed = lastEventIdHeader.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        currentSeq = parsed;
      }
    }
  }

  // 4. Create SSE response stream with serialized database polling & monotonic replay
  const encoder = new TextEncoder();
  let pollTimeout: NodeJS.Timeout | null = null;
  let isClosed = false;
  let isPolling = false;
  const startTime = Date.now();
  const MAX_POLL_DURATION_MS = 5 * 60 * 1000; // 5 minutes max stream lifetime

  const stream = new ReadableStream({
    async start(controller) {
      const closeStream = (comment?: string) => {
        if (isClosed) return;
        isClosed = true;
        if (pollTimeout) {
          clearTimeout(pollTimeout);
          pollTimeout = null;
        }
        try {
          if (comment) {
            controller.enqueue(encoder.encode(comment));
          }
          controller.close();
        } catch {
          // Stream already terminated
        }
      };

      const emitNewEvents = (events: RunEvent[]) => {
        if (isClosed) return;
        for (const evt of events) {
          if (isClosed) return;
          if (evt.sequenceNumber > currentSeq) {
            try {
              controller.enqueue(encoder.encode(formatSseEvent(evt)));
              currentSeq = evt.sequenceNumber;
            } catch {
              isClosed = true;
              return;
            }
          }
        }
      };

      // Drains available committed events across multiple batches (LIMIT 1000 per page)
      // Returns { exhausted: true } when repository queue is fully drained (empty batch or no progress)
      // Returns { exhausted: false } if MAX_DRAIN_BATCHES was reached before completion
      const drainAllCommittedEvents = async (): Promise<{ exhausted: boolean }> => {
        const MAX_DRAIN_BATCHES = 50; // Bound per tick to prevent blocking the event loop
        let batches = 0;
        while (!isClosed && batches < MAX_DRAIN_BATCHES) {
          if (Date.now() - startTime > MAX_POLL_DURATION_MS) {
            closeStream(': stream closed (timeout reached)\n\n');
            return { exhausted: false };
          }

          batches++;
          const prevSeq = currentSeq;
          const batch = await dbAdapter.getEvents(authenticatedWorkspaceId, id, currentSeq);
          if (isClosed) return { exhausted: false };
          if (!batch || batch.length === 0) {
            return { exhausted: true };
          }

          emitNewEvents(batch);

          // If currentSeq didn't advance, no further progress can be made (fully drained)
          if (currentSeq <= prevSeq) {
            return { exhausted: true };
          }
        }
        return { exhausted: false };
      };

      const pollStep = async () => {
        if (isClosed || isPolling) return;
        isPolling = true;

        try {
          // Check stream expiry
          if (Date.now() - startTime > MAX_POLL_DURATION_MS) {
            closeStream(': stream closed (timeout reached)\n\n');
            return;
          }

          // Fetch new events monotonically
          const newEvents = await dbAdapter.getEvents(authenticatedWorkspaceId, id, currentSeq);
          if (isClosed) return;
          emitNewEvents(newEvents);

          // Check terminal state
          const updatedRun = await dbAdapter.getRun(authenticatedWorkspaceId, id);
          if (isClosed) return;

          const isTerminal =
            updatedRun &&
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(updatedRun.state);

          if (isTerminal) {
            // Drain committed events across batches AFTER terminal state observed
            const drainResult = await drainAllCommittedEvents();
            if (isClosed) return;

            if (drainResult.exhausted) {
              // Only close stream with terminal state comment when all events are fully drained
              closeStream(': stream closed (run reached terminal state)\n\n');
              return;
            } else {
              // Cap limit hit before exhausting all events:
              // Do NOT falsely close! Schedule next serialized poll to continue draining
              if (!isClosed) {
                pollTimeout = setTimeout(pollStep, 50);
              }
              return;
            }
          }

          // Schedule next serialized poll iteration
          if (!isClosed) {
            pollTimeout = setTimeout(pollStep, 500);
          }
        } catch {
          closeStream(': stream error (database polling failed)\n\n');
        } finally {
          isPolling = false;
        }
      };

      try {
        // Initial monotonic replay across existing batches
        const initialDrain = await drainAllCommittedEvents();
        if (isClosed) return;

        // Check if run is already in terminal state
        const currentRun = await dbAdapter.getRun(authenticatedWorkspaceId, id);
        if (isClosed) return;

        const isTerminal =
          currentRun &&
          ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(currentRun.state);

        if (isTerminal && initialDrain.exhausted) {
          // Drain committed events AFTER terminal state observed then close
          const finalDrain = await drainAllCommittedEvents();
          if (isClosed) return;
          if (finalDrain.exhausted) {
            closeStream(': stream closed (run reached terminal state)\n\n');
            return;
          }
        }

        // If not terminal or not yet fully exhausted, schedule serialized poll
        if (!isClosed) {
          pollTimeout = setTimeout(pollStep, 100);
        }
      } catch {
        // Never expose raw internal error; use static safe comment closure
        closeStream(': stream error (database polling failed)\n\n');
      }
    },
    cancel() {
      isClosed = true;
      if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

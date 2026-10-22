'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Mono, MonoChip } from '@/components/ui/ltr';
import { Radio, RefreshCw, X, ShieldCheck } from 'lucide-react';
import type { RunEvent } from '@/lib/runs/repository';

interface RunEventStreamProps {
  runId: string;
  onClose?: () => void;
}

export function RunEventStream({ runId, onClose }: RunEventStreamProps) {
  const [events, setEvents] = React.useState<RunEvent[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [lastEventId, setLastEventId] = React.useState<number>(0);
  const [replayFrom, setReplayFrom] = React.useState<string>('0');
  const [error, setError] = React.useState<string | null>(null);

  const isTerminalRef = React.useRef(false);
  const reconnectTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = React.useRef(0);
  const lastEventIdRef = React.useRef(0);

  const connectSse = React.useCallback(
    (startAfterSequence = 0) => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      setError(null);
      setConnected(true);

      const controller = new AbortController();

      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'x-demo-mode': 'true', // Ensure authorization in demo / test mode
      };
      if (startAfterSequence > 0) {
        headers['last-event-id'] = String(startAfterSequence);
      }

      fetch(`/api/runs/${runId}/events`, {
        headers,
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP error ${response.status}`);
          }
          if (!response.body) throw new Error('ReadableStream not supported');

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const chunk of lines) {
              if (chunk.includes('run reached terminal state')) {
                isTerminalRef.current = true;
              }
              if (!chunk.trim() || chunk.startsWith(':')) continue;

              const chunkLines = chunk.split('\n');
              let dataStr = '';

              for (const line of chunkLines) {
                if (line.startsWith('data:')) dataStr = line.substring(5).trim();
              }

              if (dataStr) {
                try {
                  const parsed = JSON.parse(dataStr) as RunEvent;
                  setEvents((prev) => {
                    // Deduplicate by sequenceNumber
                    if (prev.some((e) => e.sequenceNumber === parsed.sequenceNumber)) {
                      return prev;
                    }
                    return [...prev, parsed].sort(
                      (a, b) => a.sequenceNumber - b.sequenceNumber,
                    );
                  });
                  if (parsed.sequenceNumber) {
                    setLastEventId(parsed.sequenceNumber);
                    lastEventIdRef.current = parsed.sequenceNumber;
                  }
                  if (
                    ['run_completed', 'run_failed', 'run_cancelled', 'outcome_unknown'].includes(
                      parsed.type,
                    )
                  ) {
                    isTerminalRef.current = true;
                  }
                } catch {
                  // Ignore parse error
                }
              }
            }
          }
          setConnected(false);

          // Reconnect with bounded exponential backoff only if nonterminal
          if (!isTerminalRef.current && retryCountRef.current < 5 && !controller.signal.aborted) {
            const attempt = retryCountRef.current;
            retryCountRef.current += 1;
            const backoffMs = Math.min(1000 * Math.pow(1.5, attempt), 8000);
            reconnectTimerRef.current = setTimeout(() => {
              connectSse(lastEventIdRef.current);
            }, backoffMs);
          }
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            setError(err.message);
            setConnected(false);
          }
        });

      return () => {
        controller.abort();
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      };
    },
    [runId],
  );

  React.useEffect(() => {
    isTerminalRef.current = false;
    retryCountRef.current = 0;
    const cleanup = connectSse(parseInt(replayFrom, 10) || 0);
    return cleanup;
  }, [connectSse, replayFrom]);

  return (
    <Card className="border-[#28c1f5]/40 bg-[#1e2026] shadow-xl my-4">
      <CardHeader className="p-4 pb-2 border-b border-[#323644]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio
              className={`h-4 w-4 ${connected ? 'text-emerald-400 animate-pulse' : 'text-zinc-500'}`}
            />
            <CardTitle className="text-sm font-bold text-white">
              جریان زنده رویدادهای اجرا (Authenticated SSE Replay)
            </CardTitle>
            <MonoChip>{runId}</MonoChip>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant={connected ? 'success' : 'secondary'} className="text-[10px]">
              {connected ? 'متصل به جریان' : 'پایان جریان'}
            </Badge>

            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="text-zinc-400 hover:text-white p-1 rounded-md hover:bg-[#323644]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Monotonic sequence & Last-Event-ID toolbar */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs bg-[#181818] p-2 rounded-lg border border-[#323644]">
          <div className="flex items-center gap-2 text-zinc-300">
            <ShieldCheck className="h-4 w-4 text-[#87fcc4]" />
            <span>توالی یکنواخت (Monotonic Sequence):</span>
            <Mono className="text-white font-bold">
              آخرین رویداد #{lastEventId || 0}
            </Mono>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-zinc-400">بازپخش از شماره (Last-Event-ID):</span>
            <input
              type="number"
              min="0"
              value={replayFrom}
              onChange={(e) => setReplayFrom(e.target.value)}
              className="h-6 w-16 rounded border border-[#323644] bg-[#23252D] px-2 text-center text-xs font-mono text-white focus:outline-none focus:border-[#28c1f5]"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                isTerminalRef.current = false;
                retryCountRef.current = 0;
                setEvents([]);
                connectSse(parseInt(replayFrom, 10) || 0);
              }}
              className="h-6 px-2 text-[11px] gap-1"
            >
              <RefreshCw className="h-3 w-3" />
              <span>بازپخش</span>
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-2 max-h-80 overflow-y-auto">
        {error && (
          <div className="p-2 rounded bg-red-950/30 border border-red-500/30 text-red-300 text-xs">
            خطا در دریافت جریان رویدادها: {error}
          </div>
        )}

        {events.length === 0 && !error && (
          <div className="text-center py-6 text-zinc-500 text-xs">
            در حال برقراری اتصال و دریافت رویدادها...
          </div>
        )}

        {events.map((evt) => (
          <div
            key={evt.eventId || evt.sequenceNumber}
            className="flex items-start gap-3 rounded-lg border border-[#323644] bg-[#23252D] p-3 text-xs transition-colors hover:border-zinc-500"
          >
            <div className="flex flex-col items-center justify-center rounded bg-[#181818] px-2 py-1 text-center shrink-0">
              <span className="text-[10px] text-zinc-400">شماره</span>
              <Mono className="text-[#28c1f5] font-bold text-xs">#{evt.sequenceNumber}</Mono>
            </div>

            <div className="flex-1 space-y-1 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="mint" className="text-[10px] py-0">
                    {evt.type}
                  </Badge>
                  <Mono className="text-[10px] text-zinc-400">{evt.eventId}</Mono>
                </div>
                <Mono className="text-[10px] text-zinc-400">{evt.timestamp}</Mono>
              </div>

              <div className="mt-2 rounded bg-[#181818] p-2 text-zinc-300 font-mono text-[11px] overflow-x-auto">
                <pre>{JSON.stringify(evt.safePayload, null, 2)}</pre>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

'use client';

import * as React from 'react';
import { RunItemCard } from './run-item-card';
import { RunEventStream } from './run-event-stream';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Terminal, PlusCircle, RefreshCw, AlertCircle, Info } from 'lucide-react';
import { DEMO_FIXTURE_RUNS, type Run } from '@/lib/runs/repository';

interface RunListProps {
  initialRuns?: Run[];
  onNewRun?: () => void;
  isDemo?: boolean;
}

export function RunList({ initialRuns = [], onNewRun, isDemo = false }: RunListProps) {
  const [runs, setRuns] = React.useState<Run[]>(
    isDemo ? DEMO_FIXTURE_RUNS : initialRuns,
  );
  const [activeStreamRunId, setActiveStreamRunId] = React.useState<string | null>(null);
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);

  const fetchRuns = React.useCallback(async () => {
    if (isDemo) {
      // In demo mode: strictly read-only local fixtures, no network/bypass calls
      setRuns(DEMO_FIXTURE_RUNS);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/runs');
      if (res.ok) {
        const data = await res.json();
        if (data.runs) {
          setRuns(data.runs);
        }
      } else if (res.status === 401) {
        setStatusMessage('جهت مشاهده اجراهای این فضا، ابتدا با گیت‌هاب وارد شوید.');
      }
    } catch {
      // Network failure
    } finally {
      setLoading(false);
    }
  }, [isDemo]);

  React.useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  React.useEffect(() => {
    if (!isDemo && initialRuns.length > 0) {
      setRuns(initialRuns);
    }
  }, [initialRuns, isDemo]);

  const handleCancel = async (runId: string) => {
    if (isDemo) {
      setStatusMessage('محیط دمو صرفاً نمایشی است؛ عملیات لغو در این حالت انجام نمی‌شود.');
      return;
    }

    setCancellingId(runId);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/runs/${runId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage(`اجرای ${runId} با موفقیت لغو شد.`);
        fetchRuns();
      } else {
        setStatusMessage(`خطا در لغو اجرا: ${data.error || res.statusText}`);
      }
    } catch (err) {
      setStatusMessage(`خطا در برقراری ارتباط با سرور.`);
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Action and status toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5 text-[#28c1f5]" />
          <h2 className="text-base font-bold text-white">
            {isDemo ? 'اجراهای پایدار شبیه‌سازی‌شده (Fixture Runs)' : 'لیست اجراهای پایدار (Durable Runs)'}
          </h2>
          <span className="rounded-full bg-[#2a2d37] px-2 py-0.5 text-xs text-zinc-300">
            {runs.length} مورد
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchRuns}
            disabled={loading}
            className="h-8 text-xs gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>به‌روزرسانی</span>
          </Button>

          {!isDemo && onNewRun && (
            <Button
              variant="gradient"
              size="sm"
              onClick={onNewRun}
              className="h-8 text-xs gap-1 font-bold"
            >
              <PlusCircle className="h-3.5 w-3.5" />
              <span>ایجاد اجرای ۲۰۲</span>
            </Button>
          )}
        </div>
      </div>

      {isDemo && (
        <div className="flex items-center gap-2 rounded-lg border border-[#323644] bg-[#23252D]/60 p-3 text-xs text-zinc-400">
          <Info className="h-4 w-4 text-[#28c1f5] shrink-0" />
          <span>
            این بخش به صورت کاملاً نمایشی (Read-Only) ارائه می‌شود و هیچ درخواستی به سرور یا پایگاه داده ارسال نمی‌کند.
          </span>
        </div>
      )}

      {statusMessage && (
        <div className="rounded-lg border border-[#323644] bg-[#23252D] p-3 text-xs text-zinc-200">
          {statusMessage}
        </div>
      )}

      {/* Active SSE Stream Panel */}
      {activeStreamRunId && (
        <RunEventStream
          runId={activeStreamRunId}
          onClose={() => setActiveStreamRunId(null)}
        />
      )}

      {/* Run list or empty state */}
      {runs.length === 0 ? (
        <Card className="border-[#323644] bg-[#23252D]">
          <CardContent className="flex flex-col items-center justify-center p-8 text-center">
            <AlertCircle className="h-10 w-10 text-zinc-500 mb-2" />
            <p className="text-sm font-medium text-zinc-300">هیچ اجرایی در این فضا یافت نشد.</p>
            <p className="text-xs text-zinc-500 mt-1">
              {isDemo
                ? 'داده‌های دمو بارگذاری نشدند.'
                : 'برای شروع فرایند ارزیابی یا استقرار، یک اجرای جدید ثبت کنید.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <RunItemCard
              key={run.runId}
              run={run}
              onCancel={!isDemo ? handleCancel : undefined}
              onViewEvents={(id) => setActiveStreamRunId(id)}
              isCancelling={cancellingId === run.runId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

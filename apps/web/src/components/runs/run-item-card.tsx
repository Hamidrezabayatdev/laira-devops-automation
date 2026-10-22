'use client';

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Mono, MonoChip } from '@/components/ui/ltr';
import { Terminal, XCircle, Eye, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import type { Run } from '@/lib/runs/repository';

interface RunItemCardProps {
  run: Run;
  onCancel?: (runId: string) => void;
  onViewEvents?: (runId: string) => void;
  isCancelling?: boolean;
}

export function RunItemCard({
  run,
  onCancel,
  onViewEvents,
  isCancelling = false,
}: RunItemCardProps) {
  const getStatusBadge = (state: Run['state']) => {
    switch (state) {
      case 'succeeded':
        return (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="h-3 w-3" />
            <span>موفق</span>
          </Badge>
        );
      case 'running':
        return (
          <Badge variant="default" className="gap-1 animate-pulse">
            <Terminal className="h-3 w-3" />
            <span>در حال اجرا</span>
          </Badge>
        );
      case 'queued':
        return (
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            <span>در صف</span>
          </Badge>
        );
      case 'cancelled':
        return (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" />
            <span>لغو شده</span>
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="destructive" className="gap-1">
            <AlertCircle className="h-3 w-3" />
            <span>خطا</span>
          </Badge>
        );
      default:
        return <Badge variant="outline">{state}</Badge>;
    }
  };

  const isTerminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
    run.state,
  );

  return (
    <Card className="hover:border-zinc-500/50 transition-colors">
      <CardHeader className="p-4 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MonoChip>{run.runId}</MonoChip>
            <span className="text-xs text-zinc-400">نوع:</span>
            <Mono className="text-xs text-zinc-300">{run.type}</Mono>
          </div>
          <div className="flex items-center gap-2">
            {getStatusBadge(run.state)}
          </div>
        </div>
        <CardTitle className="text-sm font-semibold text-white mt-2">
          {run.title}
        </CardTitle>
      </CardHeader>

      <CardContent className="p-4 pt-2">
        {run.summary && (
          <p className="text-xs text-zinc-400 mb-3 bg-[#181818] p-2.5 rounded-lg border border-[#323644]">
            {run.summary}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#323644] text-[11px] text-zinc-400">
          <div className="flex items-center gap-2">
            <span>تاریخ ایجاد:</span>
            <Mono className="text-zinc-300">{run.createdAt}</Mono>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onViewEvents?.(run.runId)}
              className="h-7 text-xs gap-1"
            >
              <Eye className="h-3 w-3 text-[#28c1f5]" />
              <span>مشاهده رویدادهای SSE</span>
            </Button>

            {!isTerminal && onCancel && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onCancel(run.runId)}
                disabled={isCancelling}
                className="h-7 text-xs gap-1"
              >
                <XCircle className="h-3 w-3" />
                <span>{isCancelling ? 'در حال لغو...' : 'لغو اجرا'}</span>
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

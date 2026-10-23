'use client';

import * as React from 'react';
import {
  Bot,
  Send,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  StopCircle,
  GitBranch,
  Terminal,
  Zap,
  Link as LinkIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type {
  DeploymentProposal,
  AgentProgressEvent,
} from '@/lib/agent-contract';

export const ALLOWED_COST_SOURCE_URLS = new Set<string>([
  'https://liara.ir/pricing/',
  'https://api.liara.ir/v1/me',
]);

interface AssistantSidebarProps {
  isLiveAiActive?: boolean;
  className?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  repository?: string;
  runId?: string;
  status?: string;
  progress?: AgentProgressEvent[];
  proposedAction?: DeploymentProposal;
  proposalHash?: string;
  executionRunId?: string;
  executionStatus?: string;
  executionPhase?: string;
  executionOutput?: {
    message?: string;
    releaseId?: string;
    httpStatus?: number;
    providerState?: string;
    verificationPhase?: string;
    phase?: string;
  };
  error?: string | null;
  time: string;
}

export function AssistantSidebar({
  isLiveAiActive = false,
  className = '',
}: AssistantSidebarProps) {
  const [isAuthenticated, setIsAuthenticated] = React.useState<boolean>(false);
  const [isAuthLoading, setIsAuthLoading] = React.useState<boolean>(true);
  const [inputTask, setInputTask] = React.useState('');
  const [inputRepo, setInputRepo] = React.useState('');
  const [showRepoField, setShowRepoField] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submittingApproveId, setSubmittingApproveId] = React.useState<string | null>(null);
  const [cancellingRunId, setCancellingRunId] = React.useState<string | null>(null);
  const [activePollRunId, setActivePollRunId] = React.useState<string | null>(null);
  const [activePollExecId, setActivePollExecId] = React.useState<string | null>(null);
  const [generalError, setGeneralError] = React.useState<string | null>(null);

  const [messages, setMessages] = React.useState<ChatMessage[]>([
    {
      id: 'init_welcome',
      role: 'assistant',
      content:
        'سلام! من دستیار عملیاتی دواپس لیارا هستم. وظایف مدیریت، بررسی یا استقرار خود را بنویسید تا پردازش و اجرا گردند.',
      time: 'هم‌اکنون',
    },
  ]);

  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  React.useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 1. Check user authentication on mount
  React.useEffect(() => {
    let isMounted = true;
    fetch('/api/auth/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isMounted) return;
        setIsAuthenticated(Boolean(data?.authenticated));
      })
      .catch(() => {
        if (!isMounted) return;
        setIsAuthenticated(false);
      })
      .finally(() => {
        if (!isMounted) return;
        setIsAuthLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // 2. Polling loop for active assistant run (every 2 seconds, with inflight guard and AbortController)
  React.useEffect(() => {
    if (!activePollRunId) return;

    const controller = new AbortController();
    let inFlight = false;

    const poll = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/assistant/${activePollRunId}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 404) {
            setActivePollRunId(null);
          }
          return;
        }

        const data = await res.json();
        if (controller.signal.aborted) return;

        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.runId === activePollRunId) {
              return {
                ...msg,
                status: data.status,
                content: data.output?.message || msg.content,
                proposedAction: data.output?.proposedAction || msg.proposedAction,
                proposalHash: data.output?.proposalHash || msg.proposalHash,
                progress: data.progress || msg.progress,
                error: data.error,
              };
            }
            return msg;
          }),
        );

        // Stop polling when terminal state is reached or waiting_external with accepted_observed_healthy
        const phase = data.verificationPhase || data.output?.phase || data.output?.verificationPhase;
        if (
          ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(data.status) ||
          (data.status === 'waiting_external' && phase === 'accepted_observed_healthy')
        ) {
          setActivePollRunId(null);
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          // Safe ignore network blips
        }
      } finally {
        inFlight = false;
      }
    };

    poll();
    const interval = setInterval(poll, 2000);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [activePollRunId]);

  // 3. Polling loop for execution run after approval via /api/assistant/[id] (with inflight guard and AbortController)
  React.useEffect(() => {
    if (!activePollExecId) return;

    const controller = new AbortController();
    let inFlight = false;

    const poll = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/assistant/${activePollExecId}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;

        const data = await res.json();
        if (controller.signal.aborted) return;

        const phase = data.verificationPhase || data.output?.phase || data.output?.verificationPhase;

        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.executionRunId === activePollExecId) {
              return {
                ...msg,
                executionStatus: data.status,
                executionPhase: phase,
                executionOutput: data.output,
              };
            }
            return msg;
          }),
        );

        const currentStatus = data.status;
        // Stop polling on terminal states OR waiting_external with accepted_observed_healthy
        if (
          ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(currentStatus) ||
          (currentStatus === 'waiting_external' && phase === 'accepted_observed_healthy')
        ) {
          setActivePollExecId(null);
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          // Safe ignore
        }
      } finally {
        inFlight = false;
      }
    };

    poll();
    const interval = setInterval(poll, 2000);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [activePollExecId]);

  // 4. Handle sending a new agent task
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated || isSubmitting) return;

    const trimmedTask = inputTask.trim();
    if (!trimmedTask) return;

    const trimmedRepo = inputRepo.trim();
    setGeneralError(null);
    setIsSubmitting(true);

    const userMsgId = `user_${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: trimmedTask,
      repository: trimmedRepo || undefined,
      time: 'هم‌اکنون',
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputTask('');
    setInputRepo('');
    setShowRepoField(false);

    try {
      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          task: trimmedTask,
          ...(trimmedRepo ? { repository: trimmedRepo } : {}),
        }),
      });

      const data = await response.json();

      if (response.status === 202 && data.runId) {
        const assistantMsg: ChatMessage = {
          id: `asst_${data.runId}`,
          role: 'assistant',
          runId: data.runId,
          status: data.status || 'queued',
          progress: [],
          content: 'درخواست شما در صف اجرای پایدار ثبت شد.',
          time: 'هم‌اکنون',
        };

        setMessages((prev) => [...prev, assistantMsg]);
        setActivePollRunId(data.runId);
      } else {
        setGeneralError(data.message || data.error || 'خطا در ثبت درخواست');
      }
    } catch {
      setGeneralError('خطا در برقراری ارتباط با سرویس دستیار');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 5. Handle cancelling a run
  const handleCancelRun = async (runId: string) => {
    setCancellingRunId(runId);
    try {
      const res = await fetch(`/api/runs/${runId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (res.ok) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.runId === runId ? { ...msg, status: 'cancelled' } : msg,
          ),
        );
        if (activePollRunId === runId) {
          setActivePollRunId(null);
        }
      }
    } catch {
      // Safe ignore
    } finally {
      setCancellingRunId(null);
    }
  };

  // 6. Handle approval submission ('تأیید و اجرا')
  const handleApproveProposal = async (msg: ChatMessage) => {
    if (!msg.runId || !msg.proposalHash || submittingApproveId) return;

    setSubmittingApproveId(msg.runId);
    try {
      const res = await fetch(`/api/assistant/${msg.runId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          proposalHash: msg.proposalHash,
        }),
      });

      const data = await res.json();
      if (res.status === 202 && data.runId) {
        const execRunId = data.runId;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id
              ? {
                  ...m,
                  executionRunId: execRunId,
                  executionStatus: 'queued',
                }
              : m,
          ),
        );
        // Switch to polling the execution run via /api/assistant/[id]
        setActivePollExecId(execRunId);
      } else {
        setGeneralError(data.message || data.error || 'خطا در ثبت تأیید عملیات');
      }
    } catch {
      setGeneralError('خطا در ارسال تأیید عملیات');
    } finally {
      setSubmittingApproveId(null);
    }
  };

  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'queued':
        return (
          <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/40 bg-amber-500/10">
            در صف پردازش
          </Badge>
        );
      case 'running':
        return (
          <Badge variant="outline" className="text-[10px] text-sky-400 border-sky-500/40 bg-sky-500/10 flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            در حال اجرا
          </Badge>
        );
      case 'waiting_approval':
        return (
          <Badge variant="outline" className="text-[10px] text-purple-400 border-purple-500/40 bg-purple-500/10">
            نیازمند تأیید شما
          </Badge>
        );
      case 'waiting_external':
        return (
          <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/40 bg-amber-500/10 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            در انتظار سرویس خارجی
          </Badge>
        );
      case 'succeeded':
        return (
          <Badge variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/40 bg-emerald-500/10 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            موفق
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="outline" className="text-[10px] text-rose-400 border-rose-500/40 bg-rose-500/10 flex items-center gap-1">
            <XCircle className="h-3 w-3" />
            ناموفق
          </Badge>
        );
      case 'cancelled':
        return (
          <Badge variant="outline" className="text-[10px] text-zinc-400 border-zinc-600 bg-zinc-800">
            لغو شده
          </Badge>
        );
      case 'outcome_unknown':
        return (
          <Badge variant="outline" className="text-[10px] text-amber-300 border-amber-600 bg-amber-950/40">
            وضعیت نامشخص
          </Badge>
        );
      default:
        return null;
    }
  };

  return (
    <aside
      className={`flex flex-col w-[380px] shrink-0 border-r border-[#323644] bg-[#1c1e24] ${className}`}
      dir="rtl"
    >
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-[#323644] px-4 bg-[#21232b]">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-tr from-[#87fcc4] to-[#28c1f5] text-[#181818]">
            <Bot className="h-4 w-4" />
          </div>
          <span className="text-xs font-bold text-white">دستیار عملیاتی لیارا</span>
        </div>

        <Badge
          variant={isLiveAiActive ? 'success' : (isAuthenticated ? 'success' : 'outline')}
          className="text-[10px] py-0 px-2"
        >
          {isLiveAiActive
            ? 'مدل زنده فعال'
            : isAuthLoading
            ? 'بررسی ورود...'
            : isAuthenticated
            ? 'احراز هویت شده'
            : 'ورود الزامی است'}
        </Badge>
      </div>

      {/* Security Warning Banner & Settings Connection Link */}
      <div className="border-b border-[#323644] bg-amber-950/20 px-3 py-2 text-right">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex flex-col text-[11px] leading-tight text-amber-200">
            <span className="font-semibold">خط‌مشی ایمنی داده‌ها:</span>
            <span className="text-zinc-400 mt-0.5">
              از درج توکن‌ها یا کلیدهای محرمانه خودداری فرمایید.
            </span>
            <div className="mt-1 pt-1 border-t border-amber-900/40 flex items-center gap-1 text-[10px] text-[#28c1f5]">
              <LinkIcon className="h-3 w-3 shrink-0" />
              <a href="/settings/connections" className="hover:underline">
                مدیریت اتصال‌های لیارا (/settings/connections)
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Unauthenticated Alert */}
      {!isAuthLoading && !isAuthenticated && (
        <div className="border-b border-rose-900/40 bg-rose-950/30 px-3 py-2 text-right">
          <div className="flex items-center gap-2 text-rose-300 text-[11px]">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>برای ارسال وظایف به دستیار، لطفاً وارد حساب گیت‌هاب شوید.</span>
          </div>
        </div>
      )}

      {/* General Error Banner */}
      {generalError && (
        <div className="border-b border-rose-900/40 bg-rose-950/40 px-3 py-2 text-right text-[11px] text-rose-300 flex items-center justify-between">
          <span>{generalError}</span>
          <button
            type="button"
            onClick={() => setGeneralError(null)}
            className="text-rose-400 hover:text-white mr-2"
          >
            ×
          </button>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => {
          const isWaitingExternalHealthy =
            msg.executionStatus === 'waiting_external' &&
            (msg.executionPhase === 'accepted_observed_healthy' ||
              msg.executionOutput?.phase === 'accepted_observed_healthy');

          return (
            <div
              key={msg.id}
              className={`flex flex-col text-xs leading-relaxed rounded-xl p-3 max-w-[95%] ${
                msg.role === 'assistant'
                  ? 'self-start bg-[#23252D] border border-[#323644] text-zinc-200 ml-auto'
                  : 'self-end bg-[#28c1f5]/15 border border-[#28c1f5]/30 text-white mr-auto'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5 text-[10px] text-zinc-400 gap-2">
                <span className="font-medium text-zinc-300">
                  {msg.role === 'assistant' ? 'دستیار عملیاتی' : 'شما'}
                </span>
                <div className="flex items-center gap-1.5">
                  {msg.status && getStatusBadge(msg.status)}
                  <span>{msg.time}</span>
                </div>
              </div>

              {/* User attached repo indicator */}
              {msg.repository && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-400 bg-[#181818]/70 rounded px-2 py-1 mb-1.5 border border-[#323644]">
                  <GitBranch className="h-3 w-3 text-[#28c1f5]" />
                  <span className="truncate" dir="ltr">{msg.repository}</span>
                </div>
              )}

              {/* Plain React Text content (no HTML) */}
              {msg.content && (
                <div className="whitespace-pre-wrap break-words">{msg.content}</div>
              )}

              {/* Tool Progress Events List */}
              {msg.progress && msg.progress.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-[#323644]/70 space-y-1">
                  <div className="flex items-center gap-1 text-[10px] font-semibold text-zinc-400 mb-1">
                    <Terminal className="h-3 w-3 text-[#28c1f5]" />
                    <span>مراحل اجرای ابزارها ({msg.progress.length}):</span>
                  </div>
                  <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                    {msg.progress.map((prog, idx) => (
                      <div
                        key={idx}
                        className="text-[10px] font-mono bg-[#181818] rounded px-2 py-1 text-zinc-300 border border-[#323644]/50 flex items-start justify-between gap-1"
                      >
                        <span className="truncate">
                          {prog.step ? `[${prog.step}] ` : ''}
                          {prog.message || prog.type}
                        </span>
                        <span className="text-zinc-500 shrink-0 text-[9px]">#{prog.seq}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Run Error Notice */}
              {msg.error && (
                <div className="mt-2 rounded bg-rose-950/40 border border-rose-800/40 p-2 text-[11px] text-rose-300 flex items-start gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-400 shrink-0 mt-0.5" />
                  <span>{msg.error}</span>
                </div>
              )}

              {/* Proposed Action Approval Card */}
              {msg.proposedAction && (
                <div className="mt-3 rounded-lg border border-purple-500/40 bg-purple-950/20 p-3 space-y-2.5 text-right">
                  <div className="flex items-center justify-between border-b border-purple-500/20 pb-1.5">
                    <div className="flex items-center gap-1.5 text-purple-300 font-bold text-xs">
                      <Zap className="h-3.5 w-3.5 text-purple-400" />
                      <span>
                        {msg.proposedAction.kind === 'deploy'
                          ? 'پیشنهاد استقرار پروژه'
                          : msg.proposedAction.kind === 'create_app'
                          ? 'پیشنهاد ایجاد برنامه جدید'
                          : msg.proposedAction.kind === 'restart'
                          ? 'پیشنهاد راه‌اندازی مجدد سرویس'
                          : 'پیشنهاد عملیات'}
                      </span>
                    </div>
                    <Badge variant="outline" className="text-[9px] text-purple-300 border-purple-400/30">
                      نسخه دسترسی: {msg.proposedAction.credentialVersion}
                    </Badge>
                  </div>

                  <div className="space-y-1 text-[11px] text-zinc-300">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-400">
                        {msg.proposedAction.kind === 'create_app' ? 'شناسه برنامه جدید:' : 'شناسه برنامه مقصد:'}
                      </span>
                      <span className="font-mono text-purple-200" dir="ltr">{msg.proposedAction.appId}</span>
                    </div>

                    {msg.proposedAction.kind === 'deploy' && (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">پلتفرم و پورت:</span>
                          <span className="font-mono text-zinc-200" dir="ltr">
                            {msg.proposedAction.platform}:{msg.proposedAction.port}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">سورس مخزن:</span>
                          <span className="font-mono text-zinc-200 truncate max-w-[180px]" dir="ltr">
                            {msg.proposedAction.repository.owner}/{msg.proposedAction.repository.repo}@
                            {msg.proposedAction.repository.commitSha.slice(0, 7)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">دایجست بسته:</span>
                          <span className="font-mono text-zinc-400 truncate max-w-[160px] text-[10px]" dir="ltr">
                            {msg.proposedAction.bundleDigest.slice(0, 16)}...
                          </span>
                        </div>
                        {msg.proposedAction.runtimeEnvironment && (
                          <div className="flex items-center justify-between">
                            <span className="text-zinc-400">محیط اجرا:</span>
                            <span className="font-mono text-zinc-200 text-[10px]" dir="ltr">
                              {msg.proposedAction.runtimeEnvironment.connectionId} (v{msg.proposedAction.runtimeEnvironment.credentialVersion})
                            </span>
                          </div>
                        )}
                      </>
                    )}

                    {msg.proposedAction.kind === 'create_app' && (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">پلتفرم:</span>
                          <span className="font-mono text-zinc-200" dir="ltr">
                            {msg.proposedAction.platform}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">پلن:</span>
                          <span className="font-mono text-zinc-200" dir="ltr">
                            {msg.proposedAction.planId} / {msg.proposedAction.bundlePlanId}
                          </span>
                        </div>
                        {msg.proposedAction.networkId && (
                          <div className="flex items-center justify-between">
                            <span className="text-zinc-400">شبکه:</span>
                            <span className="font-mono text-zinc-200 text-[10px]" dir="ltr">
                              {msg.proposedAction.networkId}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">هزینه ساعتی:</span>
                          <span className="font-mono text-zinc-200" dir="ltr">
                            {msg.proposedAction.cost.hourly} {msg.proposedAction.cost.currency}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">هزینه ماهانه:</span>
                          <span className="font-mono text-zinc-200" dir="ltr">
                            {msg.proposedAction.cost.monthly} {msg.proposedAction.cost.currency}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">منبع استعلام قیمت:</span>
                          {ALLOWED_COST_SOURCE_URLS.has(msg.proposedAction.cost.sourceUrl) ? (
                            <a
                              href={msg.proposedAction.cost.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#28c1f5] hover:underline font-mono text-[10px] truncate max-w-[190px]"
                              dir="ltr"
                            >
                              {msg.proposedAction.cost.sourceUrl}
                            </a>
                          ) : (
                            <span className="font-mono text-zinc-300 text-[10px] truncate max-w-[190px]" dir="ltr">
                              {msg.proposedAction.cost.sourceUrl}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">زمان استعلام هزینه:</span>
                          <span className="font-mono text-zinc-300 text-[10px]" dir="ltr">
                            {msg.proposedAction.cost.checkedAt}
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Explicit Cost & Disruption Warning */}
                  {msg.proposedAction.kind === 'create_app' ? (
                    <div className="rounded bg-amber-950/30 border border-amber-600/30 p-2 text-[10px] text-amber-200/90 leading-relaxed space-y-1">
                      <span className="font-bold block mb-0.5">هشدار هزینه ادواری و ساخت برنامه:</span>
                      <div>
                        محاسبه و صورت‌حساب ادواری از لحظه ایجاد برنامه آغاز می‌گردد. این عملیات فاقد استقرار ضمنی سورس‌کد بوده و هیچ پایگاه‌داده یا دیسک ذخیره‌سازی اضافی به همراه برنامه ایجاد نمی‌شود. این عملیات صرفاً با تأیید صریح شما انجام می‌پذیرد.
                      </div>
                    </div>
                  ) : (
                    <div className="rounded bg-amber-950/30 border border-amber-600/30 p-2 text-[10px] text-amber-200/90 leading-relaxed">
                      <span className="font-bold block mb-0.5">هشدار هزینه و پایداری:</span>
                      استقرار یا راه‌اندازی مجدد ممکن است منجر به تغییر هزینه منابع، وقفه موقت در دسترس‌پذیری سرویس یا ساخت کانتینر جدید گردد. این عملیات صرفاً با تأیید صریح شما انجام می‌شود.
                    </div>
                  )}

                  {/* Execution Status after approval */}
                  {msg.executionRunId && (
                    <div className="pt-2 border-t border-purple-500/20 text-[11px] space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">وضعیت اجرای عملیات:</span>
                        <div className="flex items-center gap-1 font-mono">
                          {isWaitingExternalHealthy ? (
                            <Badge variant="outline" className="text-[10px] text-amber-300 border-amber-500/40 bg-amber-950/40">
                              waiting_external
                            </Badge>
                          ) : msg.executionStatus === 'succeeded' ? (
                            <Badge variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/40 bg-emerald-500/10">
                              succeeded
                            </Badge>
                          ) : msg.executionStatus === 'outcome_unknown' ? (
                            <Badge variant="outline" className="text-[10px] text-amber-300 border-amber-600 bg-amber-950/40">
                              outcome_unknown
                            </Badge>
                          ) : msg.executionStatus === 'failed' ? (
                            <Badge variant="outline" className="text-[10px] text-rose-400 border-rose-500/40 bg-rose-500/10">
                              failed
                            </Badge>
                          ) : (
                            <span className="text-sky-400 flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {msg.executionPhase || msg.executionStatus || 'در صف اجرا'}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Explicit state rendering: waiting_external with accepted_observed_healthy (NOT green success) */}
                      {isWaitingExternalHealthy ? (
                        <div className="rounded bg-amber-950/40 border border-amber-600/40 p-2.5 text-[11px] text-amber-200 space-y-1.5">
                          <div className="flex items-start gap-1.5 font-semibold text-amber-300">
                            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                            <span>درخواست راه‌اندازی مجدد پذیرفته شد؛ سلامت HTTP مشاهده شد، تکمیل راه‌اندازی مجدد تأیید نشده</span>
                          </div>
                          {msg.executionOutput?.message && (
                            <div className="text-zinc-300 text-[10px] leading-relaxed pr-5">
                              {msg.executionOutput.message}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400 pt-1 border-t border-amber-800/30 font-mono" dir="ltr">
                            {msg.executionOutput?.releaseId && (
                              <span>release: {msg.executionOutput.releaseId}</span>
                            )}
                            {msg.executionOutput?.httpStatus !== undefined && (
                              <span>httpStatus: {msg.executionOutput.httpStatus}</span>
                            )}
                            {msg.executionOutput?.providerState && (
                              <span>providerState: {msg.executionOutput.providerState}</span>
                            )}
                          </div>
                        </div>
                      ) : msg.executionStatus === 'succeeded' ? (
                        <div className="space-y-1">
                          <span className="text-emerald-400 font-bold flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            موفق (تایید و اجرا با موفقیت تکمیل شد)
                          </span>
                          {msg.executionOutput?.message && (
                            <div className="text-zinc-300 text-[10px]">{msg.executionOutput.message}</div>
                          )}
                          <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400 font-mono" dir="ltr">
                            {msg.executionOutput?.releaseId && (
                              <span>release: {msg.executionOutput.releaseId}</span>
                            )}
                            {msg.executionOutput?.httpStatus !== undefined && (
                              <span>httpStatus: {msg.executionOutput.httpStatus}</span>
                            )}
                          </div>
                        </div>
                      ) : msg.executionStatus === 'outcome_unknown' ? (
                        <div className="rounded bg-amber-950/30 border border-amber-600/30 p-2 text-[11px] text-amber-300 space-y-1">
                          <span className="font-bold flex items-center gap-1 text-amber-400">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                            وضعیت نامشخص (نیاز به بررسی در پنل لیارا)
                          </span>
                          {msg.executionOutput?.message && (
                            <div className="text-zinc-300 text-[10px]">{msg.executionOutput.message}</div>
                          )}
                        </div>
                      ) : msg.executionStatus === 'failed' ? (
                        <div className="space-y-1 text-rose-400 font-bold flex items-center gap-1">
                          <XCircle className="h-3 w-3" />
                          ناموفق
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* Approve Button */}
                  {!msg.executionRunId && msg.proposalHash && (
                    <button
                      type="button"
                      onClick={() => handleApproveProposal(msg)}
                      disabled={Boolean(submittingApproveId)}
                      className="w-full mt-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 cursor-pointer"
                    >
                      {submittingApproveId === msg.runId ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>در حال ارسال تأیید...</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>تأیید و اجرا</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}

              {/* Cancel Run Button */}
              {msg.runId && (msg.status === 'queued' || msg.status === 'running') && (
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleCancelRun(msg.runId!)}
                    disabled={cancellingRunId === msg.runId}
                    className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-rose-400 disabled:opacity-50 transition-colors"
                  >
                    <StopCircle className="h-3 w-3" />
                    <span>{cancellingRunId === msg.runId ? 'در حال لغو...' : 'لغو درخواست'}</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Composer Form */}
      <form onSubmit={handleSend} className="p-3 border-t border-[#323644] bg-[#21232b] space-y-2">
        {/* Optional Repository Input Field */}
        {showRepoField ? (
          <div className="relative">
            <input
              type="text"
              value={inputRepo}
              onChange={(e) => setInputRepo(e.target.value)}
              placeholder="نشانی مخزن گیت‌هاب: https://github.com/owner/repo"
              className="w-full rounded-lg border border-[#323644] bg-[#181818] py-1.5 pr-2 pl-7 text-[11px] text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-[#28c1f5]"
              dir="ltr"
            />
            <button
              type="button"
              onClick={() => {
                setShowRepoField(false);
                setInputRepo('');
              }}
              className="absolute left-1.5 top-1.5 text-zinc-500 hover:text-zinc-300 text-xs px-1"
              title="حذف مخزن"
            >
              ×
            </button>
          </div>
        ) : (
          <div className="flex justify-between items-center text-[10px] text-zinc-400 px-1">
            <button
              type="button"
              onClick={() => setShowRepoField(true)}
              className="flex items-center gap-1 hover:text-[#28c1f5] transition-colors"
            >
              <GitBranch className="h-3 w-3" />
              <span>افزودن نشانی مخزن گیت‌هاب (اختیاری)</span>
            </button>
            <span className="text-zinc-500">{inputTask.length}/4000</span>
          </div>
        )}

        {/* Task Input & Send */}
        <div className="relative flex items-center">
          <textarea
            rows={2}
            maxLength={4000}
            value={inputTask}
            onChange={(e) => setInputTask(e.target.value)}
            disabled={!isAuthenticated || isSubmitting}
            placeholder={
              isAuthenticated
                ? 'دستور یا وظیفه عملیاتی خود را بنویسید...'
                : 'برای ارسال، ابتدا باید وارد شوید...'
            }
            className="w-full resize-none rounded-lg border border-[#323644] bg-[#181818] py-2 pr-3 pl-10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[#28c1f5] disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              }
            }}
          />
          <button
            type="submit"
            disabled={!isAuthenticated || !inputTask.trim() || isSubmitting}
            className="absolute left-1.5 bottom-2 flex h-7 w-7 items-center justify-center rounded-md bg-[#28c1f5] text-[#181818] hover:bg-[#28c1f5]/90 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] cursor-pointer"
            title="ارسال پیام"
          >
            {isSubmitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="text-center text-[9px] text-zinc-500">
          دستیار در فاز آزمایشی است. تصمیمات اجرایی نیاز به تایید شما دارند.
        </div>
      </form>
    </aside>
  );
}

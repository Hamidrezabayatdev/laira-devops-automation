'use client';

import * as React from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/app-shell';
import { RunList } from '@/components/runs/run-list';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Mono, MonoChip } from '@/components/ui/ltr';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  AlertTriangle,
  Activity,
  Database,
  Sparkles,
  Terminal,
  ShieldCheck,
  ShieldAlert,
  LogIn,
  CheckCircle2,
  History,
  Sliders,
  FileCheck,
} from 'lucide-react';
import type { Run } from '@/lib/runs/repository';

export default function HomePage() {
  const [activeTab, setActiveTab] = React.useState('runs');
  const [isConfigured, setIsConfigured] = React.useState(true);
  const [missingConfigs, setMissingConfigs] = React.useState<string[]>([]);
  const [isAuthenticated, setIsAuthenticated] = React.useState(false);
  const [currentUser, setCurrentUser] = React.useState<{
    id: string;
    githubNumericId: string;
    workspaceId: string;
    name?: string | null;
  } | null>(null);
  const [dbStatus, setDbStatus] = React.useState<'connected' | 'connecting' | 'disconnected'>('connecting');
  const [workerHeartbeat, setWorkerHeartbeat] = React.useState<'active' | 'pending' | 'unknown'>('unknown');
  const [runs, setRuns] = React.useState<Run[]>([]);
  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  const [newRunTitle, setNewRunTitle] = React.useState('');
  const [isCreatingRun, setIsCreatingRun] = React.useState(false);
  const [createFeedback, setCreateFeedback] = React.useState<string | null>(null);

  // Check server configuration, auth status, and health probes on load
  React.useEffect(() => {
    // 1. Fetch Auth & Configuration Status safely from server API
    fetch('/api/auth/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setIsConfigured(data.configured);
          setMissingConfigs(data.missingConfig || []);
          setIsAuthenticated(data.authenticated);
          if (data.user) {
            setCurrentUser(data.user);
          }
        }
      })
      .catch(() => {
        setIsConfigured(false);
        setMissingConfigs(['AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET', 'AUTH_SECRET']);
      });

    // 2. Fetch Readiness Probe safely consuming structured JSON even on 503 (not_ready)
    fetch('/api/health/ready')
      .then(async (res) => {
        try {
          return await res.json();
        } catch {
          return null;
        }
      })
      .then((data) => {
        if (data?.database?.status) {
          setDbStatus(data.database.status);
        }
        if (data?.worker?.heartbeat) {
          setWorkerHeartbeat(data.worker.heartbeat);
        }
      })
      .catch(() => {
        setDbStatus('disconnected');
        setWorkerHeartbeat('pending');
      });

    // 3. Fetch authenticated runs if session exists
    fetch('/api/runs')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.runs) {
          setRuns(data.runs);
        }
      })
      .catch(() => {});
  }, []);

  const handleCreateRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) {
      setCreateFeedback('برای ثبت اجرا، ابتدا وارد حساب کاربری شوید.');
      return;
    }

    setIsCreatingRun(true);
    setCreateFeedback(null);

    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: newRunTitle.trim() || 'اجرای سناریوی آزمایشی فیچر (Demo Fixture)',
          type: 'demo_fixture',
          metadata: { initiator: 'dashboard_console', simulated: true },
        }),
      });

      const data = await response.json();
      if (response.status === 202) {
        setCreateFeedback(`اجرای پایدار با شناسه ${data.run.runId} در وضعیت ۲۰۲ ثبت گردید.`);
        setRuns((prev) => [data.run, ...prev]);
        setNewRunTitle('');
        setTimeout(() => {
          setIsDialogOpen(false);
          setCreateFeedback(null);
        }, 1500);
      } else {
        setCreateFeedback(`خطا در ایجاد اجرا: ${data.error || response.statusText}`);
      }
    } catch (err) {
      setCreateFeedback('خطا در ارتباط با سرور API.');
    } finally {
      setIsCreatingRun(false);
    }
  };

  const currentWorkspaceId = currentUser?.workspaceId || (isAuthenticated ? 'ws_gh_unknown' : 'در انتظار ورود');
  const currentWorkspaceName = currentUser
    ? (currentUser.name ? `فضای کاری ${currentUser.name}` : `فضای کاری ${currentUser.githubNumericId}`)
    : (isAuthenticated ? 'فضای کاری اصلی' : 'فضای کاری مهمان');

  return (
    <AppShell
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onNewRun={isAuthenticated ? () => setIsDialogOpen(true) : undefined}
      isCreatingRun={isCreatingRun}
      workspaceName={currentWorkspaceName}
      workspaceId={currentWorkspaceId}
      workerHeartbeat={workerHeartbeat}
      dbStatus={dbStatus}
      isAuthenticated={isAuthenticated}
      currentUser={currentUser}
    >
      <div className="space-y-6">
        {/* Safe Config-Missing State Banner if GitHub OAuth is missing */}
        {(!isConfigured || missingConfigs.length > 0) && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-5 text-right">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-amber-500/20 p-2 text-amber-400 shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="space-y-2 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-bold text-amber-200">
                    وضعیت امن پیش‌نیازها: تنظیمات احراز هویت گیت‌هاب کامل نشده است (Safe Config-Missing State)
                  </h4>
                  <Badge variant="warning">پیش‌نیاز فاز ۰</Badge>
                </div>
                <p className="text-xs leading-relaxed text-zinc-300">
                  متغیرهای محیطی زیر در سرور تنظیم نشده‌اند. سیستم به جای بروز خطا، این وضعیت را به صورت شفاف نمایش می‌دهد:
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {missingConfigs.map((cfg) => (
                    <MonoChip key={cfg} className="border-amber-500/40 bg-[#181818] text-amber-300">
                      {cfg}
                    </MonoChip>
                  ))}
                </div>
                <div className="pt-2 flex flex-wrap items-center gap-3">
                  <Link href="/demo">
                    <Button variant="outline" size="sm" className="h-8 text-xs border-amber-500/40 text-amber-200 hover:bg-amber-950/40 gap-1.5">
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>مشاهده محیط شبیه‌سازی‌شده (مسیر /demo)</span>
                    </Button>
                  </Link>
                  <span className="text-[11px] text-zinc-500">
                    نمونه شبیه‌سازی‌شده بدون نیاز به اتصال گیت‌هاب قابل مشاهده است.
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Phase 0 Operational Status Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="border-[#323644] bg-[#23252D]">
            <CardHeader className="p-4 pb-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400">مالک فضای کاری</span>
                {isAuthenticated ? (
                  <ShieldCheck className="h-4 w-4 text-[#87fcc4]" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-zinc-500" />
                )}
              </div>
              <CardTitle className="text-sm font-bold text-white mt-1">
                احراز هویت گیت‌هاب
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-1">
              {isAuthenticated && currentUser ? (
                <>
                  <div className="flex items-center gap-1.5 text-xs text-zinc-300">
                    <span>شناسه عددی:</span>
                    <Mono className="text-white font-bold">{currentUser.githubNumericId}</Mono>
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-1">
                    تخصیص یکتای فضای کاری با شناسه ارائه‌دهنده
                  </div>
                </>
              ) : (
                <>
                  <div className="text-xs text-zinc-400">
                    {isConfigured ? 'در انتظار ورود کاربر' : 'پیش‌نیازها تنظیم نشده'}
                  </div>
                  <div className="mt-2">
                    {isConfigured ? (
                      <a href="/api/auth/signin">
                        <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1 w-full">
                          <LogIn className="h-3 w-3" />
                          <span>ورود با گیت‌هاب</span>
                        </Button>
                      </a>
                    ) : (
                      <span className="text-[10px] text-amber-400/80">پیکربندی گیت‌هاب ناقص است</span>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-[#323644] bg-[#23252D]">
            <CardHeader className="p-4 pb-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400">هارت‌بیت ورکر</span>
                <Activity
                  className={`h-4 w-4 ${
                    workerHeartbeat === 'active'
                      ? 'text-emerald-400 animate-pulse'
                      : workerHeartbeat === 'pending'
                      ? 'text-amber-400'
                      : 'text-zinc-500'
                  }`}
                />
              </div>
              <CardTitle className="text-sm font-bold text-white mt-1">
                {workerHeartbeat === 'active'
                  ? 'سیستم هارت‌بیت فعال'
                  : workerHeartbeat === 'pending'
                  ? 'هارت‌بیت ورکر در انتظار'
                  : 'وضعیت ورکر بررسی نشده'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-1">
              <div
                className={`text-xs ${
                  workerHeartbeat === 'active'
                    ? 'text-emerald-400'
                    : workerHeartbeat === 'pending'
                    ? 'text-amber-400'
                    : 'text-zinc-400'
                }`}
              >
                {workerHeartbeat === 'active'
                  ? 'پردازش وظایف پایدار فعال'
                  : workerHeartbeat === 'pending'
                  ? 'ورکر در حال شروع یا خارج از دسترس'
                  : 'در انتظار پاسخ پروب سلامت'}
              </div>
              <div className="text-[10px] text-zinc-500 mt-1">پروب سلامت و اعلام وضعیت بدون افشای لاگ</div>
            </CardContent>
          </Card>

          <Card className="border-[#323644] bg-[#23252D]">
            <CardHeader className="p-4 pb-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400">مخزن پایگاه‌داده</span>
                <Database className="h-4 w-4 text-[#28c1f5]" />
              </div>
              <CardTitle className="text-sm font-bold text-white mt-1">
                {dbStatus === 'connected' ? 'PostgreSQL متصل' : 'دیتابیس در دسترس نیست'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-1">
              <div className="text-xs text-[#28c1f5]">
                {dbStatus === 'connected' ? 'حفاظت از اطلاعات حساس' : 'عدم دسترسی به پایگاه‌داده (Fail-Closed)'}
              </div>
              <div className="text-[10px] text-zinc-500 mt-1">پروب آمادگی بدون افشای رمز عبور</div>
            </CardContent>
          </Card>

          <Card className="border-[#323644] bg-[#23252D]">
            <CardHeader className="p-4 pb-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400">مدل‌های هوش مصنوعی</span>
                <Terminal className="h-4 w-4 text-zinc-500" />
              </div>
              <CardTitle className="text-sm font-bold text-white mt-1">
                غیرفعال (مرحله ۰)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-1">
              <div className="text-xs text-zinc-400">عدم فراخوانی لایو تجاری</div>
              <div className="text-[10px] text-zinc-500 mt-1">اجرای کاملاً قطعی و امن</div>
            </CardContent>
          </Card>
        </div>

        {/* Tab 1: Runs List */}
        {activeTab === 'runs' && (
          <RunList
            initialRuns={runs}
            onNewRun={isAuthenticated ? () => setIsDialogOpen(true) : undefined}
            isDemo={false}
          />
        )}

        {/* Tab 2: Overview */}
        {activeTab === 'overview' && (
          <div className="space-y-4">
            <Card className="border-[#323644] bg-[#23252D]">
              <CardHeader className="p-5 pb-3 border-b border-[#323644]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <History className="h-5 w-5 text-[#28c1f5]" />
                    <CardTitle className="text-sm font-bold text-white">
                      بررسی اجمالی وضعیت فضای کاری و اتوماسیون
                    </CardTitle>
                  </div>
                  <Badge variant="outline">وضعیت سرویس‌ها بررسی نشده</Badge>
                </div>
              </CardHeader>
              <CardContent className="p-5 space-y-4 text-xs">
                <p className="text-zinc-300 leading-relaxed">
                  این فاز فقط اجرای پایدار سناریوی آزمایشی را فراهم می‌کند؛ اجرای دستورات زیرساختی و جمع‌آوری زنده وضعیت سرویس‌ها هنوز پیاده‌سازی نشده است. وضعیت برنامه‌های واقعی این فضای کاری ناشناخته است. برای مشاهده داده‌های نمونه، به نمای شبیه‌سازی دمو مراجعه کنید.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div className="p-3 rounded-lg border border-[#323644] bg-[#181818] space-y-1">
                    <span className="text-[11px] text-zinc-400">تعداد اجراهای ثبت‌شده:</span>
                    <div className="text-lg font-bold text-white">{runs.length} اجرا</div>
                  </div>
                  <div className="p-3 rounded-lg border border-[#323644] bg-[#181818] space-y-1">
                    <span className="text-[11px] text-zinc-400">وضعیت اتصال پایگاه‌داده:</span>
                    <div className="text-sm font-bold text-[#87fcc4]">
                      {dbStatus === 'connected' ? 'پایدار و متصل' : 'در انتظار اتصال'}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg border border-[#323644] bg-[#181818] space-y-1">
                    <span className="text-[11px] text-zinc-400">هوش مصنوعی زنده:</span>
                    <div className="text-sm font-bold text-zinc-400">غیرفعال (محیط ایزوله)</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => setActiveTab('runs')}
                    className="text-xs gap-1.5 font-semibold"
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    <span>مشاهده لیست اجراها (Runs)</span>
                  </Button>
                  <Link href="/demo">
                    <Button variant="outline" size="sm" className="text-xs gap-1.5 border-[#323644] text-zinc-300">
                      <Sparkles className="h-3.5 w-3.5 text-[#87fcc4]" />
                      <span>مشاهده محیط شبیه‌سازی دمو</span>
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Tab 3: Approvals */}
        {activeTab === 'approvals' && (
          <Card className="border-[#323644] bg-[#23252D]">
            <CardHeader className="p-5 pb-3 border-b border-[#323644]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-[#87fcc4]" />
                  <CardTitle className="text-sm font-bold text-white">
                    تأییدیه‌های برنامه‌ریزی زیرساخت (Action Plan Approvals)
                  </CardTitle>
                </div>
                <Badge variant="outline">بدون تغییر معلق</Badge>
              </div>
            </CardHeader>
            <CardContent className="p-6 text-center space-y-4">
              <FileCheck className="h-10 w-10 text-zinc-500 mx-auto" />
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-zinc-200">
                  هیچ طرح تغییری در انتظار تأیید مالک نیست
                </h4>
                <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
                  هرگونه تغییر در زیرساخت ابری پیش از اجرا نیازمند ایجاد طرح مرحله‌بندی‌شده و دریافت تأییدیه صریح از سوی مالک است (Zero-Drift Policy).
                </p>
              </div>
              <div className="pt-2">
                <Link href="/demo">
                  <Button variant="outline" size="sm" className="text-xs gap-1.5 border-[#323644] text-[#87fcc4]">
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>مشاهده نمونه طرح تغییر در محیط دمو</span>
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tab 4: Settings & Preconditions */}
        {activeTab === 'settings' && (
          <Card className="border-[#323644] bg-[#23252D]">
            <CardHeader className="p-5 pb-3 border-b border-[#323644]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sliders className="h-5 w-5 text-[#28c1f5]" />
                  <CardTitle className="text-sm font-bold text-white">
                    تنظیمات و پیش‌نیازهای امنیتی فضای کاری
                  </CardTitle>
                </div>
                <Badge variant="mint">فاز ۰ ایمن</Badge>
              </div>
            </CardHeader>
            <CardContent className="p-5 space-y-4 text-xs">
              <div className="space-y-3">
                <div className="p-3.5 rounded-lg border border-[#323644] bg-[#181818] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-white block">محدوده مالکیت یکتای گیت‌هاب</span>
                    <span className="text-[11px] text-zinc-400">شناسه عددی به عنوان کلید قطعی تفکیک فضاهای کاری استفاده می‌شود.</span>
                  </div>
                  <Mono className="text-zinc-200 bg-[#23252D] px-2.5 py-1 rounded border border-[#323644]">
                    {currentUser?.githubNumericId || 'در انتظار احراز هویت'}
                  </Mono>
                </div>

                <div className="p-3.5 rounded-lg border border-[#323644] bg-[#181818] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-white block">وضعیت دیتابیس Fail-Closed</span>
                    <span className="text-[11px] text-zinc-400">عدم نشت مشخصات اتصال یا رمز عبور در پاسخ‌های خطای سرور.</span>
                  </div>
                  <Badge variant={dbStatus === 'connected' ? 'success' : 'destructive'}>
                    {dbStatus === 'connected' ? 'PostgreSQL متصل' : 'قطع ارتباط (Fail-Closed)'}
                  </Badge>
                </div>

                <div className="p-3.5 rounded-lg border border-[#323644] bg-[#181818] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-white block">عدم فراخوانی لایو به هوش مصنوعی</span>
                    <span className="text-[11px] text-zinc-400">عدم ارسال درخواست یا مصرف اعتبار تا زمان تثبیت کامل ساختار و ابزارها.</span>
                  </div>
                  <Badge variant="outline">غیرفعال (ایمن)</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Dialog for Creating New Run */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent>
            <form onSubmit={handleCreateRun}>
              <DialogHeader>
                <DialogTitle>ایجاد اجرای پایدار جدید (HTTP 202)</DialogTitle>
                <DialogDescription>
                  عنوان اجرای مورد نظر خود را وارد کنید. درخواست در قالب استاندارد ۲۰۲ در پایگاه‌داده ثبت خواهد شد.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-zinc-300">
                    عنوان عملیات اجرایی
                  </label>
                  <Input
                    value={newRunTitle}
                    onChange={(e) => setNewRunTitle(e.target.value)}
                    placeholder="مثال: اجرای سناریوی تست پایدار شبیه‌سازی‌شده (Demo Fixture)"
                    disabled={isCreatingRun}
                  />
                </div>

                {createFeedback && (
                  <div className="rounded-lg bg-[#181818] p-3 text-xs text-zinc-200 border border-[#323644]">
                    {createFeedback}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                  disabled={isCreatingRun}
                >
                  انصراف
                </Button>
                <Button
                  type="submit"
                  variant="gradient"
                  disabled={isCreatingRun}
                  className="font-bold"
                >
                  {isCreatingRun ? 'در حال ثبت...' : 'ثبت و در صف قرار دادن (202)'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}

'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Mono } from '@/components/ui/ltr';
import { RunList } from '@/components/runs/run-list';
import { Server, Database, ShieldCheck, FileText } from 'lucide-react';
import { handleRtlTablistKeyDown } from '@/lib/accessibility/keyboard-nav';

export function DemoView() {
  const [selectedTab, setSelectedTab] = React.useState<'runs' | 'plan' | 'health'>('runs');

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-[#323644] bg-[#23252D]">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">برنامه‌های PaaS شبیه‌سازی‌شده</span>
              <Server className="h-4 w-4 text-[#28c1f5]" />
            </div>
            <CardTitle className="text-xl font-bold text-white mt-1">۲ برنامه</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 text-xs text-zinc-400">
            <Mono className="text-zinc-300">digishop-web</Mono> و <Mono className="text-zinc-300">digishop-api</Mono>
          </CardContent>
        </Card>

        <Card className="border-[#323644] bg-[#23252D]">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">پایگاه داده DBaaS</span>
              <Database className="h-4 w-4 text-[#87fcc4]" />
            </div>
            <CardTitle className="text-xl font-bold text-white mt-1">۱ کلاستر</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 text-xs text-zinc-400">
            PostgreSQL نسخه ۱۶ (منطقه ایران)
          </CardContent>
        </Card>

        <Card className="border-[#323644] bg-[#23252D]">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">وضعیت احراز هویت دمو</span>
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
            </div>
            <CardTitle className="text-xl font-bold text-white mt-1">مالک شبیه‌سازی</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 text-xs text-zinc-400">
            شناسه عددی گیت‌هاب: <Mono className="text-zinc-200">152868728</Mono>
          </CardContent>
        </Card>
      </div>

      {/* Demo Tab Navigation */}
      <div
        role="tablist"
        aria-label="بخش‌های محیط دمو"
        className="flex items-center gap-2 border-b border-[#323644] pb-2"
        onKeyDown={(e) => handleRtlTablistKeyDown(e, e.currentTarget, document.activeElement)}
      >
        <button
          role="tab"
          type="button"
          aria-selected={selectedTab === 'runs'}
          tabIndex={selectedTab === 'runs' ? 0 : -1}
          onClick={() => setSelectedTab('runs')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] ${
            selectedTab === 'runs'
              ? 'bg-[#28c1f5]/20 text-[#28c1f5] font-semibold'
              : 'text-zinc-400 hover:text-white hover:bg-[#23252D]'
          }`}
        >
          اجراهای آزمایشی (Durable Runs)
        </button>

        <button
          role="tab"
          type="button"
          aria-selected={selectedTab === 'plan'}
          tabIndex={selectedTab === 'plan' ? 0 : -1}
          onClick={() => setSelectedTab('plan')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] ${
            selectedTab === 'plan'
              ? 'bg-[#28c1f5]/20 text-[#28c1f5] font-semibold'
              : 'text-zinc-400 hover:text-white hover:bg-[#23252D]'
          }`}
        >
          نمونه طرح تغییر (Action Plan Preview)
        </button>

        <button
          role="tab"
          type="button"
          aria-selected={selectedTab === 'health'}
          tabIndex={selectedTab === 'health' ? 0 : -1}
          onClick={() => setSelectedTab('health')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] ${
            selectedTab === 'health'
              ? 'bg-[#28c1f5]/20 text-[#28c1f5] font-semibold'
              : 'text-zinc-400 hover:text-white hover:bg-[#23252D]'
          }`}
        >
          سلامت سیستم (Health Probes)
        </button>
      </div>

      {/* Tab Contents */}
      {selectedTab === 'runs' && (
        <RunList isDemo={true} />
      )}

      {selectedTab === 'plan' && (
        <Card className="border-[#323644] bg-[#23252D]">
          <CardHeader className="p-5 pb-3 border-b border-[#323644]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-[#87fcc4]" />
                <CardTitle className="text-sm font-bold text-white">
                  طرح عملیاتی تغییر زیرساخت (تغییر پایدار و بازگشت‌پذیر)
                </CardTitle>
              </div>
              <Badge variant="mint">آماده تأیید مالک</Badge>
            </div>
            <div className="mt-2 text-xs text-zinc-400 flex items-center gap-2">
              <span>هش یکتای طرح (Canonical Plan Hash):</span>
              <Mono className="text-zinc-300">
                e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
              </Mono>
            </div>
          </CardHeader>
          <CardContent className="p-5 space-y-4">
            <div className="space-y-2 text-xs">
              <span className="font-semibold text-zinc-200">گام‌های مرحله‌بندی‌شده:</span>
              <div className="space-y-2">
                <div className="p-3 rounded-lg border border-[#323644] bg-[#181818] flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[#2e323d] px-1.5 py-0.5 font-mono text-[10px]">گام ۱</span>
                    <span className="text-zinc-200">بررسی سلامت و نسخه فعلی برنامه</span>
                    <Mono className="text-zinc-400">digishop-web</Mono>
                  </div>
                  <Badge variant="outline" className="text-[10px]">بدون قطعی</Badge>
                </div>

                <div className="p-3 rounded-lg border border-[#323644] bg-[#181818] flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[#2e323d] px-1.5 py-0.5 font-mono text-[10px]">گام ۲</span>
                    <span className="text-zinc-200">افزایش منابع حافظه موقت به ۱ گیگابایت</span>
                    <Mono className="text-zinc-400">plan: g1-standard</Mono>
                  </div>
                  <Badge variant="warning" className="text-[10px]">قطعی کوتاه‌مدت (ری‌استارت)</Badge>
                </div>

                <div className="p-3 rounded-lg border border-[#323644] bg-[#181818] flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[#2e323d] px-1.5 py-0.5 font-mono text-[10px]">گام ۳</span>
                    <span className="text-zinc-200">ارزیابی سه بررسی موفق سلامت پس از ری‌استارت</span>
                    <Mono className="text-zinc-400">GET /health</Mono>
                  </div>
                  <Badge variant="mint" className="text-[10px]">تأیید خودکار</Badge>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-[#323644] flex items-center justify-between text-xs text-zinc-400">
              <span>مدت اعتبار تأییدیه: ۳۰ دقیقه</span>
              <span className="text-amber-300">در حالت دمو تغییرات اعمال نمی‌شوند.</span>
            </div>
          </CardContent>
        </Card>
      )}

      {selectedTab === 'health' && (
        <Card className="border-[#323644] bg-[#23252D]">
          <CardHeader className="p-5 pb-3 border-b border-[#323644]">
            <CardTitle className="text-sm font-bold text-white">
              بررسی پروب‌های سلامت لایو و آمادگی سرویس
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5 space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl border border-[#323644] bg-[#181818] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">پروب زنده‌بودن (Liveness Probe)</span>
                  <Badge variant="success">200 OK</Badge>
                </div>
                <div className="text-zinc-400">مسیر دسترسی:</div>
                <Mono className="text-zinc-200 bg-[#23252D] p-2 rounded block">
                  GET /api/health/live
                </Mono>
                <div className="text-[11px] text-zinc-500">
                  سرویس وب پاسخگو است و پردازش فعال است.
                </div>
              </div>

              <div className="p-4 rounded-xl border border-[#323644] bg-[#181818] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">پروب آمادگی (Readiness Probe)</span>
                  <Badge variant="success">200 READY</Badge>
                </div>
                <div className="text-zinc-400">مسیر دسترسی:</div>
                <Mono className="text-zinc-200 bg-[#23252D] p-2 rounded block">
                  GET /api/health/ready
                </Mono>
                <div className="text-[11px] text-zinc-500">
                  اتصال به پایگاه‌داده تأیید شده و بدون افشای رمز عبور یا خطاهای حساس گزارش می‌شود.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

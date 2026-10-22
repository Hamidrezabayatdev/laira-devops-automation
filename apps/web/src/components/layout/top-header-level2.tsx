'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Mono } from '@/components/ui/ltr';
import { PlusCircle, ChevronLeft, Terminal, CheckCircle2, History, Sliders } from 'lucide-react';
import { handleRtlTablistKeyDown } from '@/lib/accessibility/keyboard-nav';

interface TopHeaderLevel2Props {
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  onNewRun?: () => void;
  isCreatingRun?: boolean;
  isDemo?: boolean;
  projectName?: string;
}

export function TopHeaderLevel2({
  activeTab = 'runs',
  onTabChange,
  onNewRun,
  isCreatingRun = false,
  isDemo = false,
  projectName,
}: TopHeaderLevel2Props) {
  const tabs = [
    { id: 'overview', label: 'بررسی اجمالی', icon: History },
    { id: 'runs', label: 'اجراهای پایدار (Runs)', icon: Terminal },
    { id: 'approvals', label: 'تأییدیه‌های برنامه‌ریزی', icon: CheckCircle2 },
    { id: 'settings', label: 'تنظیمات و پیش‌نیازها', icon: Sliders },
  ];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    handleRtlTablistKeyDown(e, e.currentTarget, document.activeElement);
  };

  const effectiveProjectName =
    projectName || (isDemo ? 'digishop-web (دمو)' : 'سرویس انتخاب نشده');

  return (
    <div className="flex h-12 w-full items-center justify-between border-b border-[#323644] bg-[#1e2026] px-2 sm:px-4 overflow-hidden gap-2">
      {/* Breadcrumb path - honest static labels without deceptive hover cursor, truncated on narrow screens */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-400 select-none shrink-0 min-w-0">
        <span className="hidden md:inline">کنسول لیارا</span>
        <ChevronLeft className="h-3 w-3 text-zinc-600 hidden md:inline shrink-0" />
        <span className="text-zinc-300 font-medium">سرویس</span>
        <ChevronLeft className="h-3 w-3 text-zinc-600 shrink-0" />
        <Mono className="text-[#28c1f5] font-semibold truncate max-w-[85px] xs:max-w-[120px] sm:max-w-none">
          {effectiveProjectName}
        </Mono>
      </div>

      {/* Center Sub-Navigation Tabs - Horizontal scrolling within panel on narrow screens, never overflowing the page */}
      <div
        role="tablist"
        aria-label="بخش‌های کنسول سرویس"
        onKeyDown={handleKeyDown}
        className="flex items-center gap-1 overflow-x-auto py-1 min-w-0 [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onTabChange?.(tab.id)}
              className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-medium rounded-md transition-colors shrink-0 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] ${
                isActive
                  ? 'bg-[#28c1f5]/15 text-[#28c1f5] font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#23252D]'
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Action Button: Create Durable Run */}
      <div className="shrink-0">
        <Button
          variant="gradient"
          size="sm"
          onClick={onNewRun}
          disabled={!onNewRun || isCreatingRun}
          className="text-xs gap-1 sm:gap-1.5 h-8 font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] px-2 sm:px-3 whitespace-nowrap"
          title={!onNewRun ? 'برای ایجاد اجرا ابتدا وارد حساب کاربری شوید' : 'ثبت اجرای پایدار ۲۰۲'}
        >
          <PlusCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden xs:inline">{isCreatingRun ? 'در حال ثبت...' : 'ایجاد اجرای ۲۰۲'}</span>
          <span className="xs:hidden">اجرا +</span>
        </Button>
      </div>
    </div>
  );
}

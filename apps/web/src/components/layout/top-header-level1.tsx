'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Mono } from '@/components/ui/ltr';
import { Activity, Database, Layers, Sparkles, ShieldCheck, ShieldAlert } from 'lucide-react';

export interface TopHeaderLevel1Props {
  workspaceName?: string;
  workspaceId?: string;
  isConfigured?: boolean;
  isDemo?: boolean;
  workerHeartbeat?: 'active' | 'pending' | 'unknown';
  dbStatus?: 'connected' | 'connecting' | 'disconnected' | 'unknown';
  isAuthenticated?: boolean;
  currentUser?: {
    id: string;
    githubNumericId: string;
    workspaceId: string;
    name?: string | null;
  } | null;
}

export function TopHeaderLevel1({
  workspaceName,
  workspaceId,
  isDemo = false,
  workerHeartbeat = isDemo ? 'active' : 'unknown',
  dbStatus = isDemo ? 'connected' : 'unknown',
  isAuthenticated = isDemo ? true : false,
  currentUser = null,
}: TopHeaderLevel1Props) {
  // Honest defaults based on mode and auth state
  const effectiveWorkspaceName =
    workspaceName ||
    (isDemo
      ? 'فضای کاری شبیه‌سازی (دمو)'
      : isAuthenticated && currentUser
      ? (currentUser.name ? `فضای کاری ${currentUser.name}` : `فضای کاری ${currentUser.githubNumericId}`)
      : 'فضای کاری اصلی (مهمان)');

  const effectiveWorkspaceId =
    workspaceId ||
    (isDemo
      ? 'ws_demo_simulation'
      : isAuthenticated && currentUser
      ? currentUser.workspaceId
      : 'در انتظار ورود');

  return (
    <header className="sticky top-0 z-40 flex h-14 w-full items-center justify-between border-b border-[#323644] bg-[#181818]/95 px-2 sm:px-4 backdrop-blur-md overflow-hidden">
      {/* Right side in RTL: Brand & Workspace */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <Link
          href="/"
          className="flex items-center gap-2 group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] shrink-0"
        >
          {/* Liara style mint->cyan gradient icon */}
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-[#87fcc4] to-[#28c1f5] text-[#181818] shadow-sm font-black text-sm shrink-0">
            L
          </div>
          <div className="flex flex-col">
            <span className="text-xs sm:text-sm font-bold tracking-tight text-white group-hover:text-[#28c1f5] transition-colors whitespace-nowrap">
              لیارا DevOps
            </span>
            <span className="text-[10px] text-zinc-400 hidden md:inline">اتوماسیون ایجنت‌محور SRE</span>
          </div>
        </Link>

        <div className="hidden h-5 w-[1px] bg-[#323644] sm:block shrink-0" />

        {/* Workspace selector pill - truncated on 390px mobile screens */}
        <div className="flex items-center gap-1.5 rounded-md border border-[#323644] bg-[#23252D] px-2 py-1 text-xs text-zinc-200 max-w-[125px] xs:max-w-[160px] sm:max-w-xs min-w-0">
          <Layers className="h-3.5 w-3.5 text-[#28c1f5] shrink-0" />
          <span className="truncate">{effectiveWorkspaceName}</span>
          <Mono className="text-[10px] sm:text-[11px] text-zinc-400 truncate hidden sm:inline">
            {effectiveWorkspaceId}
          </Mono>
        </div>
      </div>

      {/* Left side in RTL: Status Indicators & Navigation links */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {/* Heartbeat Status */}
        <div className="hidden md:flex items-center gap-1.5 text-xs text-zinc-300">
          <Activity
            className={`h-3.5 w-3.5 ${
              isDemo
                ? 'text-[#87fcc4]'
                : workerHeartbeat === 'active'
                ? 'text-emerald-400 animate-pulse'
                : workerHeartbeat === 'pending'
                ? 'text-amber-400'
                : 'text-zinc-500'
            }`}
          />
          <span className="text-zinc-400">هارت‌بیت:</span>
          {isDemo ? (
            <Badge variant="outline" className="py-0 text-[10px] text-[#87fcc4] border-[#87fcc4]/40">
              شبیه‌سازی
            </Badge>
          ) : workerHeartbeat === 'active' ? (
            <Badge variant="success" className="py-0 text-[10px]">
              فعال
            </Badge>
          ) : workerHeartbeat === 'pending' ? (
            <Badge variant="warning" className="py-0 text-[10px]">
              در انتظار
            </Badge>
          ) : (
            <Badge variant="secondary" className="py-0 text-[10px]">
              بررسی نشده
            </Badge>
          )}
        </div>

        {/* Database Status */}
        <div className="hidden lg:flex items-center gap-1.5 text-xs text-zinc-300">
          <Database className="h-3.5 w-3.5 text-[#28c1f5]" />
          <span className="text-zinc-400">پستگرس:</span>
          {isDemo ? (
            <Badge variant="outline" className="py-0 text-[10px] text-[#87fcc4] border-[#87fcc4]/40">
              داده دمو (Fixture)
            </Badge>
          ) : dbStatus === 'connected' ? (
            <Badge variant="mint" className="py-0 text-[10px]">
              متصل
            </Badge>
          ) : dbStatus === 'connecting' ? (
            <Badge variant="warning" className="py-0 text-[10px]">
              در حال اتصال...
            </Badge>
          ) : dbStatus === 'disconnected' ? (
            <Badge variant="destructive" className="py-0 text-[10px]">
              قطع ارتباط
            </Badge>
          ) : (
            <Badge variant="secondary" className="py-0 text-[10px]">
              نامشخص
            </Badge>
          )}
        </div>

        {/* Demo route button */}
        {!isDemo ? (
          <Link
            href="/demo"
            className="flex items-center gap-1 rounded-md border border-[#87fcc4]/40 bg-[#87fcc4]/10 px-2 py-1 text-[11px] sm:text-xs font-medium text-[#87fcc4] hover:bg-[#87fcc4]/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#87fcc4] shrink-0"
          >
            <Sparkles className="h-3 w-3 shrink-0" />
            <span>دمو (Fixture)</span>
          </Link>
        ) : (
          <Link
            href="/"
            className="flex items-center gap-1 rounded-md border border-[#323644] bg-[#23252D] px-2 py-1 text-[11px] sm:text-xs font-medium text-zinc-300 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] shrink-0"
          >
            خروج از دمو
          </Link>
        )}

        {/* Security / OAuth status pill - Never default to fake verified 152868728 when unauthenticated */}
        <div className="flex items-center gap-1 text-xs shrink-0 max-w-[125px] xs:max-w-[160px] sm:max-w-none">
          {isDemo ? (
            <>
              <ShieldCheck className="h-4 w-4 text-[#87fcc4] shrink-0" />
              <span className="hidden sm:inline text-zinc-400">مالک شبیه‌سازی:</span>
              <Mono className="text-zinc-200 text-xs truncate">152868728 (دمو)</Mono>
            </>
          ) : isAuthenticated && currentUser ? (
            <>
              <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
              <span className="hidden sm:inline text-zinc-400">مالک تایید شده:</span>
              <Mono className="text-zinc-200 text-xs truncate">{currentUser.githubNumericId}</Mono>
            </>
          ) : (
            <div className="flex items-center gap-1 text-zinc-400 text-[11px] sm:text-xs">
              <ShieldAlert className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
              <span className="text-zinc-400 whitespace-nowrap">احراز هویت:</span>
              <span className="text-amber-400/90 whitespace-nowrap">وارد نشده</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

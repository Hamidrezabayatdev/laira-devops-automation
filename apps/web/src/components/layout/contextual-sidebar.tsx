'use client';

import {
  Server,
  Database,
  HardDrive,
  Globe,
  Settings,
  Bell,
  Cpu,
  FileText,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Mono } from '@/components/ui/ltr';

interface ContextualSidebarProps {
  currentProject?: string;
  className?: string;
  isDemo?: boolean;
}

export function ContextualSidebar({
  currentProject,
  className = '',
  isDemo = false,
}: ContextualSidebarProps) {
  const effectiveProject = currentProject || (isDemo ? 'digishop-web (دمو)' : undefined);

  // Fixture badges shown strictly in demo mode; ordinary mode shows truthful unobserved state
  const navItems = isDemo
    ? [
        { id: 'apps', label: 'برنامه‌های ابری (PaaS)', icon: Server, badge: '۲ فعال (دمو)', implemented: true },
        { id: 'databases', label: 'پایگاه‌های داده (DBaaS)', icon: Database, badge: 'PostgreSQL (دمو)', implemented: false },
        { id: 'disks', label: 'دیسک‌های ذخیره‌سازی', icon: HardDrive, badge: '۱۰ گیگابایت', implemented: false },
        { id: 'domains', label: 'دامنه‌ها و گواهی SSL', icon: Globe, badge: 'فعال', implemented: false },
        { id: 'metrics', label: 'منابع پردازشی و مانیتورینگ', icon: Cpu, implemented: false },
        { id: 'logs', label: 'لاگ‌های ساخت و اجرا', icon: FileText, implemented: false },
        { id: 'incidents', label: 'رخدادها و خطاها', icon: AlertTriangle, alert: true, implemented: false },
        { id: 'inbox', label: 'صندوق پیام‌های سیستمی', icon: Bell, implemented: false },
        { id: 'settings', label: 'تنظیمات فضای کاری', icon: Settings, implemented: false },
      ]
    : [
        { id: 'apps', label: 'برنامه‌های ابری (PaaS)', icon: Server, implemented: true },
        { id: 'databases', label: 'پایگاه‌های داده (DBaaS)', icon: Database, implemented: false },
        { id: 'disks', label: 'دیسک‌های ذخیره‌سازی', icon: HardDrive, implemented: false },
        { id: 'domains', label: 'دامنه‌ها و گواهی SSL', icon: Globe, implemented: false },
        { id: 'metrics', label: 'منابع پردازشی و مانیتورینگ', icon: Cpu, implemented: false },
        { id: 'logs', label: 'لاگ‌های ساخت و اجرا', icon: FileText, implemented: false },
        { id: 'incidents', label: 'رخدادها و خطاها', icon: AlertTriangle, alert: true, implemented: false },
        { id: 'inbox', label: 'صندوق پیام‌های سیستمی', icon: Bell, implemented: false },
        { id: 'settings', label: 'تنظیمات فضای کاری', icon: Settings, implemented: false },
      ];

  return (
    <aside
      className={`flex flex-col w-[240px] shrink-0 border-l border-[#323644] bg-[#1a1c22] p-3 text-right select-none ${className}`}
    >
      <div className="mb-3 px-2 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
          سرویس‌های متصل
        </span>
        {isDemo && (
          <Badge variant="outline" className="px-1.5 py-0 text-[9px] text-[#87fcc4] border-[#87fcc4]/40">
            شبیه‌سازی
          </Badge>
        )}
      </div>

      <nav className="flex flex-col gap-1 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isCurrent = item.id === 'apps';
          const isImplemented = item.implemented;
          return (
            <button
              key={item.id}
              type="button"
              disabled={!isImplemented}
              aria-disabled={!isImplemented}
              title={isImplemented ? undefined : 'در فاز بعدی فعال می‌شود'}
              className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-xs font-medium transition-colors text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] ${
                isCurrent
                  ? 'bg-[#28c1f5]/15 text-[#28c1f5] font-semibold'
                  : isImplemented
                  ? 'text-zinc-400 hover:bg-[#23252D] hover:text-zinc-200'
                  : 'text-zinc-500 cursor-not-allowed opacity-60'
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${isCurrent ? 'text-[#28c1f5]' : isImplemented ? 'text-zinc-400' : 'text-zinc-600'}`} />
                <span>{item.label}</span>
              </div>
              {'badge' in item && item.badge && (
                <Badge
                  variant={isCurrent ? 'default' : 'secondary'}
                  className={`px-1.5 py-0 text-[10px] font-normal ${!isImplemented ? 'opacity-60 text-zinc-400' : ''}`}
                >
                  {item.badge}
                </Badge>
              )}
            </button>
          );
        })}
      </nav>

      {/* Connected Project Details Card in Sidebar */}
      <div className="mt-auto pt-4 border-t border-[#323644]">
        {isDemo ? (
          <div className="rounded-lg border border-[#323644] bg-[#23252D] p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-400">پلن فعلی:</span>
              <Badge variant="mint" className="text-[10px] py-0">
                استاندارد (دمو)
              </Badge>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-zinc-400">شناسه:</span>
              <Mono className="text-[10px] text-zinc-300">{effectiveProject}</Mono>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[11px] text-zinc-400">موقعیت:</span>
              <span className="text-[11px] text-zinc-300">ایران (IR-THR - آزمایشی)</span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-[#323644] bg-[#23252D] p-3 text-right">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold text-zinc-300">وضعیت سرویس‌ها</span>
              <Badge variant="secondary" className="text-[10px] py-0 text-zinc-400">
                بررسی نشده
              </Badge>
            </div>
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              داده مشاهده‌شده‌ای از سرویس‌های این فضای کاری موجود نیست. اتصال و جمع‌آوری زنده هنوز پیاده‌سازی نشده است.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

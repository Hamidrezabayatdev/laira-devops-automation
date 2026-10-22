'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function DemoBanner() {
  return (
    <div className="relative border-b border-amber-500/40 bg-gradient-to-r from-amber-950/40 via-[#23252D] to-amber-950/40 px-4 py-3 text-right">
      <div className="mx-auto flex flex-wrap items-center justify-between gap-3 max-w-6xl">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex flex-col text-xs">
            <span className="font-bold text-amber-200">
              حالت نمایشی (Fixture UI Demo) — محیط شبیه‌سازی‌شده و کاملاً فقط‌خواندنی
            </span>
            <span className="text-zinc-400 mt-0.5">
              این صفحه به منظور ارزیابی پوسته RTL لیارا، جریان داده‌های ترتیبی و دستیار طراحی شده است. هیچ تغییر واقعی در زیرساخت ایجاد نمی‌شود و احراز هویت اصلی دور زده نمی‌شود.
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/">
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1 border-amber-500/30 text-amber-200 hover:bg-amber-950/30">
              <ArrowLeft className="h-3 w-3" />
              <span>بازگشت به صفحه اصلی</span>
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

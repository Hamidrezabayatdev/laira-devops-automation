'use client';

import * as React from 'react';
import { Bot, Send, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface AssistantSidebarProps {
  isLiveAiActive?: boolean;
  className?: string;
}

export function AssistantSidebar({
  isLiveAiActive = false,
  className = '',
}: AssistantSidebarProps) {
  const [inputMessage, setInputMessage] = React.useState('');
  const [messages, setMessages] = React.useState<Array<{ role: 'user' | 'assistant'; content: string; time: string }>>([
    {
      role: 'assistant',
      content:
        'سلام! من دستیار هوشمند دواپس لیارا هستم. در فاز پایه‌ای (Phase 0)، مدل‌های هوش مصنوعی زنده به علت محدودیت‌های ایمنی ارائه‌دهنده غیرفعال هستند و فرآیندها به صورت قطعی (Deterministic) و فیچرپایدار اجرا می‌شوند.',
      time: 'هم‌اکنون',
    },
    {
      role: 'assistant',
      content:
        'شما می‌توانید اجرای پایدار جدیدی ایجاد کنید، جریان رویدادهای SSE با شناسه ترتیبی یکنواخت (Monotonic Sequence) را مشاهده کرده و گزارش سلامت سیستم را بررسی نمایید.',
      time: 'هم‌اکنون',
    },
  ]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;

    const userText = inputMessage.trim();
    setInputMessage('');

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: userText, time: 'هم‌اکنون' },
      {
        role: 'assistant',
        content:
          'پیش‌نیاز مدل زنده: فراخوانی لایو BoxAPI Qwen3.7 در این فاز غیرفعال است تا از فراخوانی بدون تایید جلوگیری شود. برای اجرای درخواست‌های زیرساختی، از دکمه «ایجاد اجرای ۲۰۲» در هدر استفاده کنید.',
        time: 'هم‌اکنون',
      },
    ]);
  };

  return (
    <aside
      className={`flex flex-col w-[380px] shrink-0 border-r border-[#323644] bg-[#1c1e24] ${className}`}
    >
      {/* Assistant Header */}
      <div className="flex h-12 items-center justify-between border-b border-[#323644] px-4 bg-[#21232b]">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-tr from-[#87fcc4] to-[#28c1f5] text-[#181818]">
            <Bot className="h-4 w-4" />
          </div>
          <span className="text-xs font-bold text-white">دستیار عملیاتی لیارا</span>
        </div>

        <Badge
          variant={isLiveAiActive ? 'success' : 'outline'}
          className="text-[10px] py-0 px-2"
        >
          {isLiveAiActive ? 'مدل زنده فعال' : 'فراخوانی مدل غیرفعال (ایمن)'}
        </Badge>
      </div>

      {/* Model & Security Policy Banner */}
      <div className="border-b border-[#323644] bg-amber-950/20 px-3 py-2 text-right">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex flex-col text-[11px] leading-tight text-amber-200">
            <span className="font-semibold">وضعیت هوش مصنوعی فاز ۰:</span>
            <span className="text-zinc-400 mt-0.5">
              عدم اتصال ناخواسته به مدل تجاری. پیش‌نیازها به دقت ارزیابی شده و رفتارهای آزمایشی کاملاً محلی هستند.
            </span>
          </div>
        </div>
      </div>

      {/* Chat Messages Log */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`flex flex-col text-xs leading-relaxed rounded-xl p-3 max-w-[90%] ${
              msg.role === 'assistant'
                ? 'self-start bg-[#23252D] border border-[#323644] text-zinc-200 ml-auto'
                : 'self-end bg-[#28c1f5]/15 border border-[#28c1f5]/30 text-white mr-auto'
            }`}
          >
            <div className="flex items-center justify-between mb-1 text-[10px] text-zinc-400">
              <span>{msg.role === 'assistant' ? 'دستیار SRE' : 'شما'}</span>
              <span>{msg.time}</span>
            </div>
            <div>{msg.content}</div>
          </div>
        ))}
      </div>

      {/* Input Composer */}
      <form onSubmit={handleSend} className="p-3 border-t border-[#323644] bg-[#21232b]">
        <div className="relative flex items-center">
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            placeholder="پیامی بنویسید یا سؤالی بپرسید..."
            className="w-full rounded-lg border border-[#323644] bg-[#181818] py-2 pr-3 pl-10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[#28c1f5]"
          />
          <button
            type="submit"
            disabled={!inputMessage.trim()}
            className="absolute left-1.5 flex h-7 w-7 items-center justify-center rounded-md bg-[#28c1f5] text-[#181818] hover:bg-[#28c1f5]/90 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5]"
            title="ارسال پیام"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1 text-center text-[10px] text-zinc-500">
          استفاده از هوش مصنوعی طبق خط‌مشی ایمنی محدود شده است.
        </div>
      </form>
    </aside>
  );
}

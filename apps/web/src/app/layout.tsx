import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/vazirmatn';
import './globals.css';

export const metadata: Metadata = {
  title: 'لیارا — اتوماسیون ایجنت‌محور DevOps و SRE',
  description:
    'دستیار هوشمند مدیریت زیرساخت ابری لیارا با پشتیبانی بومی از زبان فارسی، جریان رویدادهای پایدار و تأییدیه‌های قطعی تغییر.',
};

export const viewport: Viewport = {
  themeColor: '#181818',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className="dark h-full">
      <body className="flex min-h-full flex-col bg-[#181818] text-zinc-100 antialiased font-sans">
        {children}
      </body>
    </html>
  );
}

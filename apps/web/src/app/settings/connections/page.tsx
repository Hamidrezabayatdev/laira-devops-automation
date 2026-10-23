'use client';

import * as React from 'react';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Mono } from '@/components/ui/ltr';
import {
  ShieldAlert,
  Key,
  Plus,
  Server,
  Cpu,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Lock,
  ArrowRight,
  LogIn,
} from 'lucide-react';

interface ConnectionItem {
  id: string;
  name: string;
  provider: 'liara' | 'boxapi' | string;
  status: string;
}

export default function ConnectionsSettingsPage() {
  const [provider, setProvider] = React.useState<'liara' | 'boxapi'>('liara');
  const [name, setName] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');

  const [isLoading, setIsLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const [connections, setConnections] = React.useState<ConnectionItem[]>([]);
  const [isLoadingConnections, setIsLoadingConnections] = React.useState(true);

  const [isAuthenticated, setIsAuthenticated] = React.useState<boolean | null>(null);
  const [currentUser, setCurrentUser] = React.useState<{
    id: string;
    workspaceId: string;
    role?: string;
  } | null>(null);

  // Check authentication & load existing connections
  const fetchConnections = React.useCallback(async () => {
    setIsLoadingConnections(true);
    try {
      const res = await fetch('/api/connections', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (res.status === 401) {
        setIsAuthenticated(false);
        setConnections([]);
        return;
      }

      if (res.ok) {
        const data = await res.json();
        setConnections(data.connections || []);
      } else {
        const errData = await res.json().catch(() => null);
        setErrorMessage(errData?.error || 'خطا در بارگذاری لیست اتصالات');
      }
    } catch {
      setErrorMessage('خطای ارتباط با سرور در دریافت اتصالات');
    } finally {
      setIsLoadingConnections(false);
    }
  }, []);

  React.useEffect(() => {
    // 1. Check auth status
    fetch('/api/auth/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setIsAuthenticated(data.authenticated);
          if (data.user) {
            setCurrentUser(data.user);
          }
        }
      })
      .catch(() => {
        setIsAuthenticated(false);
      });

    // 2. Fetch connections
    fetchConnections();
  }, [fetchConnections]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!name.trim()) {
      setErrorMessage('لطفاً نام اتصال را وارد کنید');
      return;
    }

    if (name.trim().length > 80) {
      setErrorMessage('نام اتصال نمی‌تواند بیش از ۸۰ نویسه باشد');
      return;
    }

    if (!apiKey.trim()) {
      setErrorMessage('لطفاً کلید دسترسی (API Key) را وارد کنید');
      return;
    }

    if (apiKey.length > 4096) {
      setErrorMessage('کلید دسترسی بیش از حد مجاز است');
      return;
    }

    setIsLoading(true);

    try {
      // POST to /api/connections
      // Notice: apiKey is sent strictly in request body, NEVER in query parameters or URL
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          provider,
          name: name.trim(),
          apiKey: apiKey.trim(),
        }),
      });

      const data = await res.json().catch(() => null);

      if (res.status === 201) {
        // Clear sensitive key immediately from React state upon success
        // Never keep or persist raw credential in localStorage or session state
        setApiKey('');
        setName('');
        setSuccessMessage('اتصال ارائه‌دهنده با موفقیت ایجاد و رمزنگاری شد (پیکربندی‌شده - در انتظار استفاده).');
        await fetchConnections();
      } else {
        setErrorMessage(data?.error || data?.message || 'خطا در ثبت اتصال ارائه‌دهنده');
      }
    } catch {
      setErrorMessage('خطای شبکه در برقراری ارتباط با سرور');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div dir="rtl" className="min-h-screen bg-[#181a20] text-zinc-100 p-4 sm:p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between border-b border-[#323644] pb-4">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Link href="/" className="hover:text-zinc-200 transition-colors flex items-center gap-1">
              <span>صفحه اصلی</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <span className="text-zinc-500">/</span>
            <span className="text-zinc-300 font-medium">تنظیمات</span>
            <span className="text-zinc-500">/</span>
            <span className="text-[#28c1f5] font-semibold">اتصالات و کلیدهای ابری (BYOK)</span>
            {currentUser?.workspaceId && (
              <span className="hidden sm:inline-flex items-center gap-1 text-xs text-zinc-400 mr-2">
                (شناسه فضای کاری: <Mono className="text-zinc-300">{currentUser.workspaceId}</Mono>)
              </span>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchConnections}
            disabled={isLoadingConnections}
            className="border-[#323644] bg-[#22252d] hover:bg-[#2c303b] text-zinc-300"
          >
            <RefreshCw className={`h-3.5 w-3.5 ml-1.5 ${isLoadingConnections ? 'animate-spin' : ''}`} />
            بروزرسانی
          </Button>
        </div>

        {/* Authentication Warning if not logged in */}
        {isAuthenticated === false && (
          <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-sm space-y-1">
              <p className="font-semibold">نیاز به ورود به عنوان مالک فضای کاری</p>
              <p className="text-amber-300/80">
                مدیریت و اتصال کلیدهای ارائه‌دهندگان ابری تنها برای مالکان فضای کاری احراز هویت شده مجاز است. لطفاً ابتدا وارد حساب خود شوید.
              </p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => signIn('github')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-amber-500 text-black hover:bg-amber-400 transition cursor-pointer"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  ورود با گیت‌هاب
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Feedback Banners */}
        {errorMessage && (
          <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-200 flex items-center gap-3 text-sm">
            <ShieldAlert className="h-5 w-5 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 flex items-center gap-3 text-sm">
            <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Form Card: Connect New Provider */}
        <Card className="bg-[#1e2026] border-[#323644] shadow-lg">
          <CardHeader className="border-b border-[#323644]/60 pb-4">
            <div className="flex items-center gap-2">
              <Key className="h-5 w-5 text-[#28c1f5]" />
              <CardTitle className="text-base font-semibold text-zinc-100">
                اتصال ارائه‌دهنده جدید (Connect Provider BYOK)
              </CardTitle>
            </div>
            <CardDescription className="text-xs text-zinc-400">
              کلیدهای دسترسی ارائه‌دهندگان ابری به‌صورت محدود به فضای کاری و با الگوریتم متقارن AES-256-GCM در سرور رمزنگاری می‌شوند.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Provider Selection */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-300 block">
                  انتخاب ارائه‌دهنده سرویس (Provider)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setProvider('liara')}
                    className={`flex items-center gap-3 p-3 rounded-lg border text-right transition-all ${
                      provider === 'liara'
                        ? 'border-[#28c1f5] bg-[#28c1f5]/10 text-zinc-100'
                        : 'border-[#323644] bg-[#22252d] text-zinc-400 hover:border-zinc-500'
                    }`}
                  >
                    <Server className={`h-5 w-5 ${provider === 'liara' ? 'text-[#28c1f5]' : 'text-zinc-500'}`} />
                    <div>
                      <div className="text-sm font-semibold">سرویس ابری لیارا (Liara)</div>
                      <div className="text-xs text-zinc-400">مدیریت برنامه‌ها، دیسک‌ها و پایگاه داده</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setProvider('boxapi')}
                    className={`flex items-center gap-3 p-3 rounded-lg border text-right transition-all ${
                      provider === 'boxapi'
                        ? 'border-[#28c1f5] bg-[#28c1f5]/10 text-zinc-100'
                        : 'border-[#323644] bg-[#22252d] text-zinc-400 hover:border-zinc-500'
                    }`}
                  >
                    <Cpu className={`h-5 w-5 ${provider === 'boxapi' ? 'text-[#28c1f5]' : 'text-zinc-500'}`} />
                    <div>
                      <div className="text-sm font-semibold">ارائه‌دهنده هوش مصنوعی (Box API)</div>
                      <div className="text-xs text-zinc-400">مدل‌های زبانی هوشمند برای برنامه‌ریزی DevOps</div>
                    </div>
                  </button>
                </div>
              </div>

              {/* Connection Name */}
              <div className="space-y-1.5">
                <label htmlFor="conn-name" className="text-xs font-medium text-zinc-300 block">
                  نام اتصال (شناسه نمایشی - غیر محرمانه)
                </label>
                <Input
                  id="conn-name"
                  type="text"
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={provider === 'liara' ? 'مثال: کلید اصلی حساب کاری لیارا' : 'مثال: کلید دسترسی مدل Box API'}
                  className="bg-[#181a20] border-[#323644] text-zinc-100 text-sm focus:border-[#28c1f5]"
                  disabled={isLoading || isAuthenticated === false}
                  required
                />
                <span className="text-[11px] text-zinc-500">حداکثر ۸۰ نویسه. این عنوان تنها برای شناسایی اتصال در فضای کاری استفاده می‌شود.</span>
              </div>

              {/* API Key Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="conn-apikey" className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                    <Lock className="h-3.5 w-3.5 text-amber-400" />
                    <span>کلید دسترسی محرمانه (API Key / Token)</span>
                  </label>
                </div>
                <Input
                  id="conn-apikey"
                  type="password"
                  autoComplete="off"
                  maxLength={4096}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="••••••••••••••••••••••••••••••••••••••••••••••••"
                  className="bg-[#181a20] border-[#323644] text-zinc-100 text-sm font-mono focus:border-[#28c1f5]"
                  disabled={isLoading || isAuthenticated === false}
                  required
                />
                <div className="rounded bg-amber-500/10 border border-amber-500/20 p-2 text-[11px] text-amber-300/90 leading-relaxed">
                  ⚠️ <strong>هشدار امنیتی:</strong> این کلید به‌صورت ایمن با سرور تبادل و در پاکت رمزنگاری ذخیره می‌شود. پس از ثبت موفق، مقدار خام آن به هیچ عنوان مجدداً در رابط کاربری یا پاسخ‌های API بازگردانده نخواهد شد.
                </div>
              </div>

              {/* Submit Button */}
              <div className="pt-2">
                <Button
                  type="submit"
                  disabled={isLoading || isAuthenticated === false}
                  className="w-full sm:w-auto bg-[#28c1f5] hover:bg-[#28c1f5]/90 text-black font-semibold text-sm px-6"
                >
                  {isLoading ? (
                    <RefreshCw className="h-4 w-4 animate-spin ml-2" />
                  ) : (
                    <Plus className="h-4 w-4 ml-2" />
                  )}
                  {isLoading ? 'در حال ثبت و رمزنگاری...' : 'ثبت و اتصال ارائه‌دهنده'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Existing Connections List */}
        <Card className="bg-[#1e2026] border-[#323644]">
          <CardHeader className="border-b border-[#323644]/60 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold text-zinc-100">
                  اتصالات فعال در فضای کاری
                </CardTitle>
                <CardDescription className="text-xs text-zinc-400 mt-1">
                  لیست ارائه‌دهندگان متصل شده به فضای کاری جاری (کلیدها و متن رمزنگاری‌شده در این نما نمایش داده نمی‌شوند)
                </CardDescription>
              </div>
              <Badge variant="outline" className="border-[#323644] text-zinc-400 text-xs">
                {connections.length} اتصال
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {isLoadingConnections ? (
              <div className="py-8 text-center text-sm text-zinc-400 flex items-center justify-center gap-2">
                <RefreshCw className="h-4 w-4 animate-spin text-[#28c1f5]" />
                در حال دریافت اتصالات...
              </div>
            ) : connections.length === 0 ? (
              <div className="py-10 text-center text-sm text-zinc-500">
                هیچ اتصال ارائه‌دهنده‌ای در این فضای کاری ثبت نشده است. از فرم بالا برای اتصال استفاده کنید.
              </div>
            ) : (
              <div className="divide-y divide-[#323644]">
                {connections.map((conn) => (
                  <div key={conn.id} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-zinc-200">{conn.name}</span>
                        <Badge
                          variant="secondary"
                          className={
                            conn.provider === 'liara'
                              ? 'bg-blue-500/10 text-blue-300 border border-blue-500/20 text-xs'
                              : 'bg-purple-500/10 text-purple-300 border border-purple-500/20 text-xs'
                          }
                        >
                          {conn.provider === 'liara' ? 'سرویس لیارا' : 'Box API'}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-zinc-400">
                        <span>شناسه یکتا:</span>
                        <Mono className="text-zinc-300 text-[11px]">{conn.id}</Mono>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={
                          conn.status === 'configured_unverified'
                            ? 'border-amber-500/30 text-amber-300 bg-amber-500/5 text-xs'
                            : 'border-emerald-500/30 text-emerald-300 bg-emerald-500/5 text-xs'
                        }
                      >
                        {conn.status === 'configured_unverified'
                          ? 'پیکربندی‌شده (تأییدنشده)'
                          : 'فعال'}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

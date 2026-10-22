import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ContextualSidebar } from '../src/components/layout/contextual-sidebar';

describe('Ordinary workspace observation boundary', () => {
  it('renders unknown infrastructure without fixture resources or invented zero counts', () => {
    const html = renderToStaticMarkup(createElement(ContextualSidebar));
    expect(html).toContain('بررسی نشده');
    expect(html).toContain('داده مشاهده‌شده‌ای');
    for (const fixture of ['digishop', 'IR-THR', '۲ فعال', 'بدون سرویس فعال', 'استاندارد']) {
      expect(html).not.toContain(fixture);
    }
  });

  it('keeps explicitly labelled sample infrastructure in demo mode only', () => {
    const html = renderToStaticMarkup(createElement(ContextualSidebar, { isDemo: true }));
    expect(html).toContain('شبیه‌سازی');
    expect(html).toContain('digishop-web');
    expect(html).toContain('دمو');
  });
});

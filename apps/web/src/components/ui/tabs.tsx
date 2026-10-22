'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function Tabs({
  value: controlledValue,
  defaultValue,
  onValueChange,
  className,
  children,
  ...props
}: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? '');
  const isControlled = controlledValue !== undefined;
  const activeValue = isControlled ? controlledValue : uncontrolledValue;

  const handleValueChange = React.useCallback(
    (nextVal: string) => {
      if (!isControlled) {
        setUncontrolledValue(nextVal);
      }
      onValueChange?.(nextVal);
    },
    [isControlled, onValueChange],
  );

  return (
    <TabsContext.Provider value={{ value: activeValue, onValueChange: handleValueChange }}>
      <div className={cn('flex flex-col gap-3', className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const listRef = React.useRef<HTMLDivElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (!list) return;

    const tabs = Array.from(
      list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
    );
    if (tabs.length === 0) return;

    const currentIndex = tabs.findIndex((t) => t === document.activeElement);
    if (currentIndex === -1) return;

    let targetIndex = currentIndex;

    // Support RTL keyboard navigation:
    // In RTL, ArrowRight moves to previous tab visually, ArrowLeft moves to next tab.
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      targetIndex = (currentIndex + 1) % tabs.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      targetIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      targetIndex = tabs.length - 1;
    }

    if (targetIndex !== currentIndex) {
      const targetTab = tabs[targetIndex];
      targetTab?.focus();
      targetTab?.click();
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex h-9 items-center justify-start rounded-lg bg-[#23252D] p-1 border border-[#323644] text-zinc-400 gap-1',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({
  value,
  className,
  children,
  ...props
}: TabsTriggerProps) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('TabsTrigger must be used within Tabs');

  const isActive = ctx.value === value;

  return (
    <button
      role="tab"
      type="button"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5]',
        isActive
          ? 'bg-[#2e323d] text-white shadow-xs'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#2a2d37]/50',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({
  value,
  className,
  children,
  ...props
}: TabsContentProps) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('TabsContent must be used within Tabs');

  if (ctx.value !== value) return null;

  return (
    <div
      role="tabpanel"
      tabIndex={0}
      className={cn('focus-visible:outline-none', className)}
      {...props}
    >
      {children}
    </div>
  );
}

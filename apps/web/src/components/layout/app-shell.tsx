'use client';

import * as React from 'react';
import { TopHeaderLevel1, type TopHeaderLevel1Props } from './top-header-level1';
import { TopHeaderLevel2 } from './top-header-level2';
import { ContextualSidebar } from './contextual-sidebar';
import { AssistantSidebar } from './assistant-sidebar';
import { PanelLeft, PanelRight, X } from 'lucide-react';
import {
  handleDialogFocusTrapKeyDown,
  shouldCloseDrawerOnResize,
} from '@/lib/accessibility/keyboard-nav';

export interface AppShellProps extends TopHeaderLevel1Props {
  children: React.ReactNode;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  onNewRun?: () => void;
  isCreatingRun?: boolean;
}

export function AppShell({
  children,
  activeTab = 'runs',
  onTabChange,
  onNewRun,
  isCreatingRun = false,
  isDemo = false,
  workspaceName,
  workspaceId,
  workerHeartbeat,
  dbStatus,
  isAuthenticated,
  currentUser,
}: AppShellProps) {
  const [showMobileAssistant, setShowMobileAssistant] = React.useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = React.useState(false);

  // References to restore focus to trigger buttons upon closing drawers
  const assistantTriggerRef = React.useRef<HTMLButtonElement>(null);
  const servicesTriggerRef = React.useRef<HTMLButtonElement>(null);
  const pendingFocusTriggerRef = React.useRef<HTMLButtonElement | null>(null);

  // References to drawer dialog containers for focus trap & initial focus
  const assistantDialogRef = React.useRef<HTMLDivElement>(null);
  const servicesDialogRef = React.useRef<HTMLDivElement>(null);
  const assistantCloseBtnRef = React.useRef<HTMLButtonElement>(null);
  const servicesCloseBtnRef = React.useRef<HTMLButtonElement>(null);

  const isModalOpen = showMobileAssistant || showMobileSidebar;

  // Prevent both drawers overlap & open one cleanly
  const openAssistant = () => {
    setShowMobileSidebar(false);
    setShowMobileAssistant(true);
  };

  const closeAssistant = () => {
    pendingFocusTriggerRef.current = assistantTriggerRef.current;
    setShowMobileAssistant(false);
  };

  const openSidebar = () => {
    setShowMobileAssistant(false);
    setShowMobileSidebar(true);
  };

  const closeSidebar = () => {
    pendingFocusTriggerRef.current = servicesTriggerRef.current;
    setShowMobileSidebar(false);
  };

  // Keyboard Escape listener & body overflow lock
  React.useEffect(() => {
    if (!isModalOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showMobileAssistant) closeAssistant();
        if (showMobileSidebar) closeSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isModalOpen, showMobileAssistant, showMobileSidebar]);

  // Close drawers upon window resize to desktop breakpoints so hidden dialogs
  // do not leave the background inert or body overflow locked.
  React.useEffect(() => {
    if (!isModalOpen) return;

    const handleResize = () => {
      const width = window.innerWidth;
      if (showMobileAssistant && shouldCloseDrawerOnResize(width, 'assistant')) {
        pendingFocusTriggerRef.current = null;
        setShowMobileAssistant(false);
      }
      if (showMobileSidebar && shouldCloseDrawerOnResize(width, 'services')) {
        pendingFocusTriggerRef.current = null;
        setShowMobileSidebar(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isModalOpen, showMobileAssistant, showMobileSidebar]);

  // Initial focus management when drawers open
  React.useEffect(() => {
    if (showMobileAssistant) {
      assistantCloseBtnRef.current?.focus();
    }
  }, [showMobileAssistant]);

  React.useEffect(() => {
    if (showMobileSidebar) {
      servicesCloseBtnRef.current?.focus();
    }
  }, [showMobileSidebar]);

  // Restore focus to trigger button AFTER inert is removed from background content
  React.useEffect(() => {
    if (!isModalOpen && pendingFocusTriggerRef.current) {
      const trigger = pendingFocusTriggerRef.current;
      pendingFocusTriggerRef.current = null;
      trigger.focus();
    }
  }, [isModalOpen]);

  return (
    <div dir="rtl" className="relative flex min-h-screen w-full flex-col bg-[#181818] text-zinc-100">
      {/* Background container wrapping all page content (headers, toggle bar, and main layout).
          Marked with HTML `inert` attribute while any mobile drawer dialog is open.
          Dialogs are rendered as direct siblings OUTSIDE this container so they are never inert.
      */}
      <div
        inert={isModalOpen ? true : undefined}
        className="flex min-h-screen w-full flex-col flex-1"
      >
        {/* Header Level 1: Global Navigation & Workspace State */}
        <TopHeaderLevel1
          workspaceName={workspaceName}
          workspaceId={workspaceId}
          isDemo={isDemo}
          workerHeartbeat={workerHeartbeat}
          dbStatus={dbStatus}
          isAuthenticated={isAuthenticated}
          currentUser={currentUser}
        />

        {/* Header Level 2: Contextual Navigation & Primary Action */}
        <TopHeaderLevel2
          activeTab={activeTab}
          onTabChange={onTabChange}
          onNewRun={onNewRun}
          isCreatingRun={isCreatingRun}
          isDemo={isDemo}
        />

        {/* Responsive Drawer Toggles Bar:
            Visible below xl breakpoint (when either sidebar is not shown in 3-column desktop layout).
            - Assistant toggle is visible below lg (<1024px)
            - Contextual services toggle is visible below xl (<1280px), ensuring services remain accessible at 1024-1279px!
        */}
        <div className="flex items-center justify-between border-b border-[#323644] bg-[#1e2026] px-4 py-1.5 xl:hidden">
          {/* Assistant Drawer Toggle (screens < lg) */}
          <div className="lg:hidden">
            <button
              ref={assistantTriggerRef}
              type="button"
              aria-expanded={showMobileAssistant}
              aria-controls="mobile-assistant-dialog"
              onClick={showMobileAssistant ? closeAssistant : openAssistant}
              className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-zinc-300 hover:text-white hover:bg-[#23252D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5]"
            >
              <PanelLeft className="h-4 w-4 text-[#28c1f5]" />
              <span>{showMobileAssistant ? 'بستن دستیار' : 'نمایش دستیار هوشمند'}</span>
            </button>
          </div>
          <div className="hidden lg:block" />

          {/* Services Drawer Toggle (screens < xl: accessible at 1024px-1279px as well as mobile!) */}
          <div className="xl:hidden">
            <button
              ref={servicesTriggerRef}
              type="button"
              aria-expanded={showMobileSidebar}
              aria-controls="mobile-services-dialog"
              onClick={showMobileSidebar ? closeSidebar : openSidebar}
              className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-zinc-300 hover:text-white hover:bg-[#23252D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#87fcc4]"
            >
              <PanelRight className="h-4 w-4 text-[#87fcc4]" />
              <span>{showMobileSidebar ? 'بستن سرویس‌ها' : 'سرویس‌های متصل'}</span>
            </button>
          </div>
        </div>

        {/* 3-Column Shell Body:
            In RTL order:
            Right column visually = Contextual Sidebar (order-1, hidden on < xl)
            Center column = Main Workspace Content (order-2)
            Left column visually = Persistent Assistant (order-3, hidden on < lg)
        */}
        <div className="relative flex flex-1 overflow-hidden">
          {/* Contextual Sidebar (Desktop Right visually in RTL) */}
          <div className="hidden xl:flex order-1">
            <ContextualSidebar isDemo={isDemo} />
          </div>

          {/* Center Main Content Area */}
          <main className="flex-1 overflow-y-auto p-4 sm:p-6 order-2 min-w-0">
            <div className="mx-auto max-w-6xl">{children}</div>
          </main>

          {/* Persistent Assistant Sidebar (Desktop Left visually in RTL) */}
          <div className="hidden lg:flex order-3">
            <AssistantSidebar />
          </div>
        </div>
      </div>

      {/* Mobile Assistant Overlay Dialog:
          Accessible WAI-ARIA modal dialog with visible close button, initial focus, focus trap, and background inert
      */}
      {showMobileAssistant && (
        <div
          id="mobile-assistant-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="دستیار هوشمند دواپس"
          onKeyDown={(e) => handleDialogFocusTrapKeyDown(e, assistantDialogRef.current, document.activeElement)}
          className="fixed inset-0 z-50 flex lg:hidden"
        >
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs transition-opacity"
            onClick={closeAssistant}
            aria-hidden="true"
          />
          <div
            ref={assistantDialogRef}
            className="relative z-10 flex flex-col w-full max-w-sm h-full bg-[#1c1e24] shadow-2xl border-l border-[#323644]"
          >
            <div className="flex h-11 items-center justify-between border-b border-[#323644] px-3 bg-[#21232b]">
              <span className="text-xs font-bold text-white">دستیار عملیاتی</span>
              <button
                ref={assistantCloseBtnRef}
                type="button"
                onClick={closeAssistant}
                aria-label="بستن پنجره دستیار"
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-[#2e323d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <AssistantSidebar className="w-full h-full border-r-0" />
            </div>
          </div>
        </div>
      )}

      {/* Mobile Contextual Services Overlay Dialog:
          Accessible WAI-ARIA modal dialog (active on < xl, covering mobile & 1024-1279px range)
      */}
      {showMobileSidebar && (
        <div
          id="mobile-services-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="سرویس‌های متصل"
          onKeyDown={(e) => handleDialogFocusTrapKeyDown(e, servicesDialogRef.current, document.activeElement)}
          className="fixed inset-0 z-50 flex justify-end xl:hidden"
        >
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs transition-opacity"
            onClick={closeSidebar}
            aria-hidden="true"
          />
          <div
            ref={servicesDialogRef}
            className="relative z-10 flex flex-col w-full max-w-xs h-full bg-[#1a1c22] shadow-2xl border-r border-[#323644]"
          >
            <div className="flex h-11 items-center justify-between border-b border-[#323644] px-3 bg-[#21232b]">
              <span className="text-xs font-bold text-white">سرویس‌های متصل</span>
              <button
                ref={servicesCloseBtnRef}
                type="button"
                onClick={closeSidebar}
                aria-label="بستن پنجره سرویس‌ها"
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-[#2e323d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#87fcc4]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <ContextualSidebar isDemo={isDemo} className="w-full h-full border-l-0" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

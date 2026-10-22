/**
 * Production keyboard accessibility and focus management handlers.
 * Shared between components (TopHeaderLevel2, DemoView, AppShell) and unit tests.
 */

export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusableElement {
  focus: () => void;
  click?: () => void;
}

export interface KeyboardNavEvent {
  key: string;
  shiftKey?: boolean;
  preventDefault: () => void;
  currentTarget?: {
    querySelectorAll: <T>(selector: string) => ArrayLike<T>;
  };
}

/**
 * RTL Tablist keyboard navigation handler.
 * - ArrowRight moves to visually previous tab (index - 1)
 * - ArrowLeft moves to visually next tab (index + 1)
 * - Home moves to first tab (index 0)
 * - End moves to last tab (index length - 1)
 */
export function handleRtlTablistKeyDown<T extends FocusableElement>(
  e: KeyboardNavEvent,
  container: { querySelectorAll: <E = T>(selector: string) => ArrayLike<E> } | null,
  activeElement: unknown,
): void {
  const targetContainer = container || e.currentTarget;
  if (!targetContainer) return;

  const tabButtons = Array.from(targetContainer.querySelectorAll<T>('[role="tab"]'));
  if (tabButtons.length === 0) return;

  const currentIndex = tabButtons.findIndex((t) => t === activeElement);
  if (currentIndex === -1) return;

  let targetIndex = currentIndex;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    targetIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    targetIndex = (currentIndex + 1) % tabButtons.length;
  } else if (e.key === 'Home') {
    e.preventDefault();
    targetIndex = 0;
  } else if (e.key === 'End') {
    e.preventDefault();
    targetIndex = tabButtons.length - 1;
  }

  if (targetIndex !== currentIndex) {
    const targetTab = tabButtons[targetIndex];
    targetTab?.focus();
    targetTab?.click?.();
  }
}

/**
 * Modal dialog focus trap handler.
 * - Forward Tab on last focusable element wraps focus back to the first element.
 * - Reverse Shift+Tab on first focusable element wraps focus back to the last element.
 */
export function handleDialogFocusTrapKeyDown<T extends FocusableElement>(
  e: KeyboardNavEvent,
  container: { querySelectorAll: <E = T>(selector: string) => ArrayLike<E> } | null,
  activeElement: unknown,
): void {
  if (e.key !== 'Tab') return;
  if (!container) return;

  const focusable = Array.from(container.querySelectorAll<T>(FOCUSABLE_SELECTOR));
  if (focusable.length === 0) return;

  const firstElement = focusable[0];
  const lastElement = focusable[focusable.length - 1];
  if (!firstElement || !lastElement) return;

  if (e.shiftKey) {
    if (activeElement === firstElement) {
      e.preventDefault();
      lastElement.focus();
    }
  } else {
    if (activeElement === lastElement) {
      e.preventDefault();
      firstElement.focus();
    }
  }
}

/**
 * Viewport breakpoint checker to close mobile drawers upon resizing to desktop.
 * - Assistant sidebar is desktop-persistent at lg (>=1024px)
 * - Services contextual sidebar is desktop-persistent at xl (>=1280px)
 */
export function shouldCloseDrawerOnResize(
  viewportWidth: number,
  drawerType: 'assistant' | 'services',
): boolean {
  if (drawerType === 'assistant' && viewportWidth >= 1024) return true;
  if (drawerType === 'services' && viewportWidth >= 1280) return true;
  return false;
}

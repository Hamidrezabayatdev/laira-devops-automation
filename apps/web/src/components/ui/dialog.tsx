'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import { handleDialogFocusTrapKeyDown } from '@/lib/accessibility/keyboard-nav';

/**
 * Reusable Accessible Modal Primitive
 * - Portals to document.body
 * - Applies actual HTML `inert` to all background body children while active
 * - Restores prior `inert` attributes and body overflow upon unmount/close
 * - Accessible naming via aria-labelledby (linked to DialogTitle) or aria-label
 * - Focus trapping and async focus restoration to previous active trigger
 *
 * Architectural Decision - Nested Modals:
 * Nested modal dialogs are intentionally NOT supported. Attempting to open nested
 * modal dialogs creates competing focus traps and multiple conflicting inert states
 * on the document tree. Sub-flows should be represented via stepped views within a
 * single modal or dedicated pages.
 */

interface DialogContextValue {
  titleId: string;
  descriptionId: string;
  onOpenChange: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

export function Dialog({
  open,
  onOpenChange,
  children,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: DialogProps) {
  const [mounted, setMounted] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);

  const baseId = React.useId();
  const titleId = ariaLabelledBy || `dialog-title-${baseId}`;
  const descriptionId = ariaDescribedBy || `dialog-desc-${baseId}`;

  // SSR safety for portal
  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Capture trigger element before modal opens
  React.useEffect(() => {
    if (open && typeof document !== 'undefined') {
      if (document.activeElement instanceof HTMLElement) {
        triggerRef.current = document.activeElement;
      }
    }
  }, [open]);

  // Inert background and body scroll lock management
  React.useEffect(() => {
    if (!open || !mounted) return;

    const portalEl = containerRef.current;
    if (!portalEl || typeof document === 'undefined') return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Set `inert` on all sibling children of document.body except the portal container
    // or any container that encloses the portal element.
    const originalInerts: Array<{ el: HTMLElement; hadInert: boolean }> = [];
    for (const child of Array.from(document.body.children)) {
      if (
        child instanceof HTMLElement &&
        child !== portalEl &&
        !child.contains(portalEl)
      ) {
        originalInerts.push({ el: child, hadInert: child.hasAttribute('inert') });
        child.setAttribute('inert', '');
      }
    }

    return () => {
      document.body.style.overflow = originalOverflow;
      for (const { el, hadInert } of originalInerts) {
        if (hadInert) {
          el.setAttribute('inert', '');
        } else {
          el.removeAttribute('inert');
        }
      }
    };
  }, [open, mounted]);

  // Initial focus management
  React.useEffect(() => {
    if (!open || !mounted) return;

    const content = contentRef.current;
    if (!content) return;

    // Focus the first focusable element inside the dialog content
    const focusable = content.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length > 0 && focusable[0]) {
      focusable[0].focus();
    } else {
      content.focus();
    }
  }, [open, mounted]);

  // Async focus restoration AFTER modal closes and inert attribute is cleared
  React.useEffect(() => {
    if (!open && triggerRef.current) {
      const trigger = triggerRef.current;
      triggerRef.current = null;
      // Ensure background inert cleanup has executed before restoring focus
      const scheduleFocus =
        typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame
          : (cb: () => void) => setTimeout(cb, 0);

      scheduleFocus(() => {
        trigger.focus();
      });
    }
  }, [open]);

  // Escape key handler
  React.useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange]);

  if (!open || !mounted || typeof document === 'undefined') return null;

  const dialogContent = (
    <DialogContext.Provider value={{ titleId, descriptionId, onOpenChange }}>
      <div
        ref={containerRef}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        {/* Backdrop overlay */}
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-xs transition-opacity"
          onClick={() => onOpenChange(false)}
          aria-hidden="true"
        />

        {/* Modal Dialog Panel */}
        <div
          ref={contentRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabel ? undefined : titleId}
          aria-label={ariaLabel}
          aria-describedby={descriptionId}
          tabIndex={-1}
          onKeyDown={(e) => handleDialogFocusTrapKeyDown(e, contentRef.current, document.activeElement)}
          className={cn(
            'relative z-10 w-full max-w-lg rounded-xl border border-[#323644] bg-[#23252D] p-6 shadow-xl focus:outline-none',
            className,
          )}
        >
          {/* Visible Close Button */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="بستن پنجره"
            className="absolute left-4 top-4 flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-[#2e323d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28c1f5] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          {children}
        </div>
      </div>
    </DialogContext.Provider>
  );

  return createPortal(dialogContent, document.body);
}

export function DialogContent({
  className,
  children,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  const ctx = React.useContext(DialogContext);
  const effectiveLabelledBy = ariaLabelledBy || (!ariaLabel ? ctx?.titleId : undefined);
  const effectiveDescribedBy = ariaDescribedBy || ctx?.descriptionId;

  return (
    <div
      aria-labelledby={effectiveLabelledBy}
      aria-describedby={effectiveDescribedBy}
      aria-label={ariaLabel}
      className={cn('space-y-4', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col space-y-1.5 text-right sm:text-right pl-6', className)}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  id,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  const ctx = React.useContext(DialogContext);
  return (
    <h2
      id={id || ctx?.titleId}
      className={cn('text-lg font-semibold leading-none tracking-tight text-white', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  id,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  const ctx = React.useContext(DialogContext);
  return (
    <p
      id={id || ctx?.descriptionId}
      className={cn('text-xs text-zinc-400 mt-1 leading-relaxed', className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-end gap-2 mt-6', className)}
      {...props}
    />
  );
}

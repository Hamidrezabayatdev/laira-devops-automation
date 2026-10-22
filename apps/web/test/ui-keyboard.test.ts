import { describe, it, expect, vi } from 'vitest';
import {
  handleRtlTablistKeyDown,
  handleDialogFocusTrapKeyDown,
  shouldCloseDrawerOnResize,
  FOCUSABLE_SELECTOR,
  type FocusableElement,
} from '@/lib/accessibility/keyboard-nav';

/**
 * Test Boundary Notice:
 * These are unit tests running in a Node.js test runner using a lightweight mock DOM
 * element hierarchy to verify the EXACT production accessibility handler functions
 * exported by `@/lib/accessibility/keyboard-nav` (used by AppShell, TopHeaderLevel2, and DemoView).
 * End-to-end browser runtime behavior, visual layout, and screenshot verifications are
 * performed by the primary agent in the desktop review pane.
 */

class MockElement implements FocusableElement {
  tagName: string;
  attributes: Record<string, string>;
  disabled: boolean;
  children: MockElement[] = [];
  tabIndex: number = 0;

  constructor(tagName: string, attributes: Record<string, string> = {}, disabled = false) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.disabled = disabled;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  appendChild(child: MockElement): void {
    this.children.push(child);
  }

  focus = vi.fn(() => {
    mockDoc.activeElement = this;
  });

  click = vi.fn();

  querySelectorAll<T>(selector: string): T[] {
    const results: MockElement[] = [];
    const traverse = (node: MockElement) => {
      for (const child of node.children) {
        if (selector === '[role="tab"]' && child.getAttribute('role') === 'tab') {
          results.push(child);
        } else if (selector === FOCUSABLE_SELECTOR) {
          if (
            (child.tagName === 'BUTTON' && !child.disabled) ||
            child.attributes['href'] ||
            (child.tagName === 'INPUT' && !child.disabled)
          ) {
            results.push(child);
          }
        }
        traverse(child);
      }
    };
    traverse(this);
    return results as unknown as T[];
  }
}

const mockDoc = {
  activeElement: null as MockElement | null,
};

describe('Accessibility & Keyboard Navigation Handlers (Unit / Mock DOM Element Tree)', () => {
  describe('handleRtlTablistKeyDown (Production Handler)', () => {
    it('moves to next tab visually on ArrowLeft in RTL layout and calls focus() and click()', () => {
      const container = new MockElement('div', { role: 'tablist' });
      const tab0 = new MockElement('button', { role: 'tab', id: 'tab0' });
      const tab1 = new MockElement('button', { role: 'tab', id: 'tab1' });
      const tab2 = new MockElement('button', { role: 'tab', id: 'tab2' });
      container.appendChild(tab0);
      container.appendChild(tab1);
      container.appendChild(tab2);

      tab0.focus();
      expect(mockDoc.activeElement).toBe(tab0);

      const preventDefault = vi.fn();
      handleRtlTablistKeyDown(
        { key: 'ArrowLeft', preventDefault },
        container,
        mockDoc.activeElement,
      );

      expect(preventDefault).toHaveBeenCalled();
      expect(tab1.focus).toHaveBeenCalled();
      expect(tab1.click).toHaveBeenCalled();
      expect(mockDoc.activeElement).toBe(tab1);
    });

    it('moves to previous tab visually on ArrowRight in RTL layout and wraps from first to last tab', () => {
      const container = new MockElement('div', { role: 'tablist' });
      const tab0 = new MockElement('button', { role: 'tab', id: 'tab0' });
      const tab1 = new MockElement('button', { role: 'tab', id: 'tab1' });
      const tab2 = new MockElement('button', { role: 'tab', id: 'tab2' });
      container.appendChild(tab0);
      container.appendChild(tab1);
      container.appendChild(tab2);

      tab0.focus();
      const preventDefault = vi.fn();
      handleRtlTablistKeyDown(
        { key: 'ArrowRight', preventDefault },
        container,
        mockDoc.activeElement,
      );

      expect(preventDefault).toHaveBeenCalled();
      expect(tab2.focus).toHaveBeenCalled();
      expect(tab2.click).toHaveBeenCalled();
      expect(mockDoc.activeElement).toBe(tab2);
    });

    it('jumps directly to first tab on Home and last tab on End in RTL layout', () => {
      const container = new MockElement('div', { role: 'tablist' });
      const tab0 = new MockElement('button', { role: 'tab', id: 'tab0' });
      const tab1 = new MockElement('button', { role: 'tab', id: 'tab1' });
      const tab2 = new MockElement('button', { role: 'tab', id: 'tab2' });
      container.appendChild(tab0);
      container.appendChild(tab1);
      container.appendChild(tab2);

      tab1.focus();
      handleRtlTablistKeyDown(
        { key: 'Home', preventDefault: vi.fn() },
        container,
        mockDoc.activeElement,
      );
      expect(tab0.focus).toHaveBeenCalled();
      expect(mockDoc.activeElement).toBe(tab0);

      handleRtlTablistKeyDown(
        { key: 'End', preventDefault: vi.fn() },
        container,
        mockDoc.activeElement,
      );
      expect(tab2.focus).toHaveBeenCalled();
      expect(mockDoc.activeElement).toBe(tab2);
    });
  });

  describe('handleDialogFocusTrapKeyDown (Production Handler)', () => {
    it('traps Tab on the last focusable element and wraps focus to the first element', () => {
      const dialog = new MockElement('div', { role: 'dialog' });
      const closeBtn = new MockElement('button', { 'aria-label': 'Close' });
      const input = new MockElement('input', {});
      const submitBtn = new MockElement('button', { type: 'submit' });

      dialog.appendChild(closeBtn);
      dialog.appendChild(input);
      dialog.appendChild(submitBtn);

      submitBtn.focus();
      expect(mockDoc.activeElement).toBe(submitBtn);

      const preventDefault = vi.fn();
      handleDialogFocusTrapKeyDown(
        { key: 'Tab', shiftKey: false, preventDefault },
        dialog,
        mockDoc.activeElement,
      );

      expect(preventDefault).toHaveBeenCalled();
      expect(closeBtn.focus).toHaveBeenCalled();
      expect(mockDoc.activeElement).toBe(closeBtn);
    });

    it('traps Shift+Tab on the first focusable element and wraps focus to the last element', () => {
      const dialog = new MockElement('div', { role: 'dialog' });
      const closeBtn = new MockElement('button', { 'aria-label': 'Close' });
      const submitBtn = new MockElement('button', { type: 'submit' });

      dialog.appendChild(closeBtn);
      dialog.appendChild(submitBtn);

      closeBtn.focus();
      expect(mockDoc.activeElement).toBe(closeBtn);

      const preventDefault = vi.fn();
      handleDialogFocusTrapKeyDown(
        { key: 'Tab', shiftKey: true, preventDefault },
        dialog,
        mockDoc.activeElement,
      );

      expect(preventDefault).toHaveBeenCalled();
      expect(submitBtn.focus).toHaveBeenCalled();
      expect(mockDoc.activeElement).toBe(submitBtn);
    });

    it('does not prevent default when Tab occurs on an intermediate element', () => {
      const dialog = new MockElement('div', { role: 'dialog' });
      const first = new MockElement('button', {});
      const middle = new MockElement('button', {});
      const last = new MockElement('button', {});

      dialog.appendChild(first);
      dialog.appendChild(middle);
      dialog.appendChild(last);

      middle.focus();
      const preventDefault = vi.fn();
      handleDialogFocusTrapKeyDown(
        { key: 'Tab', shiftKey: false, preventDefault },
        dialog,
        mockDoc.activeElement,
      );

      expect(preventDefault).not.toHaveBeenCalled();
    });

    it('safely handles dialog with only a single focusable element (wraps to itself)', () => {
      const dialog = new MockElement('div', { role: 'dialog' });
      const onlyBtn = new MockElement('button', { 'aria-label': 'Close' });
      dialog.appendChild(onlyBtn);

      onlyBtn.focus();
      const preventDefault = vi.fn();
      handleDialogFocusTrapKeyDown(
        { key: 'Tab', shiftKey: false, preventDefault },
        dialog,
        mockDoc.activeElement,
      );

      expect(preventDefault).toHaveBeenCalled();
      expect(onlyBtn.focus).toHaveBeenCalled();
    });

    it('gracefully handles empty container or non-Tab key events', () => {
      const dialog = new MockElement('div', { role: 'dialog' });
      const preventDefault = vi.fn();

      // Non-Tab key
      handleDialogFocusTrapKeyDown(
        { key: 'Escape', shiftKey: false, preventDefault },
        dialog,
        null,
      );
      expect(preventDefault).not.toHaveBeenCalled();

      // Tab on empty dialog container
      handleDialogFocusTrapKeyDown(
        { key: 'Tab', shiftKey: false, preventDefault },
        dialog,
        null,
      );
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('shouldCloseDrawerOnResize (Production Viewport Breakpoint Logic)', () => {
    it('closes assistant drawer at desktop lg breakpoint (>=1024px) but keeps it below 1024px', () => {
      expect(shouldCloseDrawerOnResize(1024, 'assistant')).toBe(true);
      expect(shouldCloseDrawerOnResize(1440, 'assistant')).toBe(true);
      expect(shouldCloseDrawerOnResize(1023, 'assistant')).toBe(false);
      expect(shouldCloseDrawerOnResize(768, 'assistant')).toBe(false);
    });

    it('closes services drawer at desktop xl breakpoint (>=1280px) and keeps it accessible at 1024-1279px', () => {
      expect(shouldCloseDrawerOnResize(1280, 'services')).toBe(true);
      expect(shouldCloseDrawerOnResize(1920, 'services')).toBe(true);
      // Accessible between 1024px and 1279px:
      expect(shouldCloseDrawerOnResize(1279, 'services')).toBe(false);
      expect(shouldCloseDrawerOnResize(1024, 'services')).toBe(false);
      expect(shouldCloseDrawerOnResize(768, 'services')).toBe(false);
    });
  });
});

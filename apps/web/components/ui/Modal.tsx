'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const widths = {
  md: 'sm:max-w-md',
  lg: 'sm:max-w-2xl',
} as const;

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** `lg` for dialogs that are mostly a list or a table; `md` for a form. */
  size?: keyof typeof widths;
}) {
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Callers pass a fresh arrow every render; reading it through a ref keeps the
  // key handler - and the focus it would otherwise re-take - installed once.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setMounted(true);
    // Where focus was when the dialog opened, to hand it back on close:
    // otherwise it falls to <body> and a keyboard user starts again at the top.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      // Tab stays inside the dialog: the page behind it is inert to a mouse,
      // and should be to the keyboard too.
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = focusableIn(dialogRef.current);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      opener?.focus();
    };
  }, []);

  // Into the dialog once it exists: its first field, so typing starts where the
  // dialog is about - never a button, which could put Enter one key away from
  // "Remove" - else the dialog itself.
  useEffect(() => {
    if (!mounted || !dialogRef.current) return;
    const field = dialogRef.current.querySelector<HTMLElement>(
      '[data-modal-body] input:not([disabled]):not([type="hidden"]), [data-modal-body] select:not([disabled]), [data-modal-body] textarea:not([disabled])',
    );
    (field ?? dialogRef.current).focus();
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-40 flex items-end justify-center overflow-y-auto bg-slate-900/50 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* A sheet from the bottom on a phone - thumb-reachable, and the way
          every native dialog on the device already behaves - and a centred
          card from sm up.

          Capped to the viewport, with the BODY scrolling rather than the page.
          Without the cap a dialog simply grew: the branch editor and the weekly
          schedule both run past the bottom of a laptop screen, and the title and
          the Save button went with them - so the one control you opened it for
          was off-screen in both directions.

          dvh where it exists, because mobile browser chrome makes 100vh taller
          than what you can actually see; the vh class stays as the fallback and
          an unsupported dvh declaration is simply dropped. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxHeight: 'calc(100dvh - 2rem)' }}
        className={`animate-sheet-in safe-bottom flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-t-2xl focus:outline-none border border-border bg-surface shadow-pop sm:rounded-xl ${widths[size]}`}
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 id={titleId} className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 flex-none place-items-center rounded-lg text-muted hover:bg-surface-muted hover:text-content"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div data-modal-body className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-none flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

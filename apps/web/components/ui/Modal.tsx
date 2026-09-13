'use client';

import React, { useEffect, useState } from 'react';
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

  useEffect(() => {
    setMounted(true);
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

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
        role="dialog"
        aria-modal="true"
        style={{ maxHeight: 'calc(100dvh - 2rem)' }}
        className={`animate-sheet-in safe-bottom flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-pop sm:rounded-xl ${widths[size]}`}
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
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
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
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

'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
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
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Capped to the viewport, with the BODY scrolling rather than the page.
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
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col rounded-xl border border-border bg-surface shadow-pop"
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 flex-none place-items-center rounded-lg text-muted hover:bg-surface-muted"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-none justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';
import { BrandMark } from '@/components/BrandMark';

interface Tab {
  href: string;
  label: string;
  icon: React.ReactNode;
  match: (p: string) => boolean;
}

const ICON = {
  home: <path d="M3 11 12 3l9 8M5 9v11h5v-6h4v6h5V9" strokeLinecap="round" strokeLinejoin="round" />,
  truck: <><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" strokeLinejoin="round" /><circle cx="7" cy="18" r="1.5" /><circle cx="17" cy="18" r="1.5" /></>,
  cash: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></>,
  leave: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" strokeLinecap="round" /></>,
  pay: <><path d="M12 2v20M17 6H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6" strokeLinecap="round" strokeLinejoin="round" /></>,
};

export default function FieldShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ role: string; userId: string }>('/api/me/ping').then((r) => {
      if (r.ok) { setRole(r.data.role); }
    });
  }, []);

  const driver = role === 'DRIVER';
  const home = driver ? '/driver' : '/employee';
  const tabs: Tab[] = [
    { href: home, label: driver ? 'Trips' : 'Home', icon: driver ? ICON.truck : ICON.home, match: (p) => p === '/employee' || p === '/driver' },
    { href: '/employee/advances', label: 'Advances', icon: ICON.cash, match: (p) => p.startsWith('/employee/advances') },
    { href: '/employee/leave', label: 'Leave', icon: ICON.leave, match: (p) => p.startsWith('/employee/leave') },
    { href: '/employee/payroll', label: 'Pay', icon: ICON.pay, match: (p) => p.startsWith('/employee/payroll') },
  ];

  async function logout() {
    await apiSend('/api/auth/logout');
    window.location.href = '/login';
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 py-2.5">
          <BrandMark />
          <button
            type="button"
            onClick={logout}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted hover:bg-surface-muted hover:text-content"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M10 17l5-5-5-5M15 12H3M21 3v18" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Logout
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-md px-4 py-4">{children}</main>

      {/* The tab bar sits above the phone's home bar, and the active tab is
          marked by an accent bar as well as its colour. */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur" aria-label="Sections">
        <div className="mx-auto flex max-w-md">
          {tabs.map((t) => {
            const active = t.match(pathname);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex flex-1 flex-col items-center gap-1 pb-2 pt-2.5 text-[11px] font-medium transition-colors ${active ? 'text-primary' : 'text-muted hover:text-content'}`}
              >
                <span className={`absolute inset-x-6 top-0 h-0.5 rounded-b ${active ? 'bg-primary' : 'bg-transparent'}`} aria-hidden />
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{t.icon}</svg>
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';

interface Tab {
  href: string;
  label: string;
  icon: React.ReactNode;
  match: (p: string) => boolean;
}

const ICON = {
  home: <path d="M3 11 12 3l9 8M5 9v11h5v-6h4v6h5V9" strokeLinecap="round" strokeLinejoin="round" />,
  cash: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></>,
  leave: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" strokeLinecap="round" /></>,
  pay: <><path d="M12 2v20M17 6H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6" strokeLinecap="round" strokeLinejoin="round" /></>,
};

export default function FieldShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(() => {
    apiGet<{ role: string; userId: string }>('/api/me/ping').then((r) => {
      if (r.ok) { setRole(r.data.role); }
    });
  }, []);

  const home = role === 'DRIVER' ? '/driver' : '/employee';
  const tabs: Tab[] = [
    { href: home, label: role === 'DRIVER' ? 'Trip' : 'Home', icon: ICON.home, match: (p) => p === '/employee' || p === '/driver' },
    { href: '/employee/advances', label: 'Advances', icon: ICON.cash, match: (p) => p.startsWith('/employee/advances') },
    { href: '/employee/leave', label: 'Leave', icon: ICON.leave, match: (p) => p.startsWith('/employee/leave') },
    { href: '/employee/payroll', label: 'Pay', icon: ICON.pay, match: (p) => p.startsWith('/employee/payroll') },
  ];

  async function logout() {
    await apiSend('/api/auth/logout');
    window.location.href = '/login';
  }

  return (
    <div className="min-h-screen bg-surface-muted pb-20">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-white">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h2l.4 2M7 13h10l3-8H5.4M7 13 5.4 5M7 13l-1.6 4h12" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9" cy="20" r="1.5" /><circle cx="17" cy="20" r="1.5" /></svg>
            </span>
            <span className="font-semibold">Shabro2a</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setPwOpen(true)} className="rounded-lg border border-border px-3 py-1.5 text-sm text-content hover:bg-surface-muted">
              Password
            </button>
            <button onClick={logout} className="rounded-lg border border-border px-3 py-1.5 text-sm text-content hover:bg-surface-muted">
              Logout
            </button>
          </div>
        </div>
      </header>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}

      <main className="mx-auto max-w-md px-4 py-4">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface">
        <div className="mx-auto flex max-w-md">
          {tabs.map((t) => {
            const active = t.match(pathname);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${active ? 'text-primary' : 'text-muted'}`}
              >
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

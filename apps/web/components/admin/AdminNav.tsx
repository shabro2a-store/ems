'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { apiSend } from '@/lib/api';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';

export interface NavItem {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/admin', label: 'Dashboard', match: (p: string) => p === '/admin' },
  { href: '/admin/users', label: 'Employees', match: (p: string) => p.startsWith('/admin/users') },
  { href: '/admin/branches', label: 'Branches', match: (p: string) => p.startsWith('/admin/branches') },
  { href: '/admin/punches', label: 'Punches', match: (p: string) => p.startsWith('/admin/punches') },
  { href: '/admin/payroll', label: 'Payroll', match: (p: string) => p.startsWith('/admin/payroll') },
];

export interface AdminNavProps {
  username: string;
  flagCount: number;
}

export default function AdminNav({ username, flagCount }: AdminNavProps) {
  const pathname = usePathname();
  const [pwOpen, setPwOpen] = useState(false);

  async function logout() {
    await apiSend('/api/auth/logout');
    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-white">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3h2l.4 2M7 13h10l3-8H5.4M7 13 5.4 5M7 13l-1.6 4h12" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="9" cy="20" r="1.5" />
              <circle cx="17" cy="20" r="1.5" />
            </svg>
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Shabro2a</div>
            <div className="text-xs text-muted">{username}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {flagCount > 0 && (
            <Link
              href="/admin/flags"
              className="inline-flex items-center gap-1 rounded-full border border-warning/20 bg-warning-subtle px-2.5 py-1 text-xs font-medium text-warning"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              {flagCount} flag{flagCount === 1 ? '' : 's'}
            </Link>
          )}
          <button
            type="button"
            onClick={() => setPwOpen(true)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-content hover:bg-surface-muted"
          >
            Password
          </button>
          <button
            type="button"
            onClick={logout}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-content hover:bg-surface-muted"
          >
            Logout
          </button>
        </div>
      </div>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
      <nav className="mx-auto max-w-6xl overflow-x-auto px-2 sm:px-4">
        <ul className="flex gap-1 py-1.5 text-sm">
          {NAV_ITEMS.map((item) => {
            const active = item.match(pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block whitespace-nowrap rounded-lg px-3 py-1.5 font-medium transition-colors ${
                    active ? 'bg-primary text-white' : 'text-muted hover:bg-surface-muted hover:text-content'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}

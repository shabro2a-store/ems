'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { apiSend } from '@/lib/api';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { BrandMark } from '@/components/BrandMark';

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
  { href: '/admin/trips', label: 'Trips', match: (p: string) => p.startsWith('/admin/trips') },
  { href: '/admin/payroll', label: 'Payroll', match: (p: string) => p.startsWith('/admin/payroll') },
];

export interface AdminNavProps {
  username: string;
}

export default function AdminNav({ username }: AdminNavProps) {
  const pathname = usePathname();
  const [pwOpen, setPwOpen] = useState(false);

  async function logout() {
    await apiSend('/api/auth/logout');
    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <BrandMark subtitle={username} />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPwOpen(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted hover:bg-surface-muted hover:text-content"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" strokeLinecap="round" />
            </svg>
            <span className="hidden sm:inline">Password</span>
          </button>
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
      </div>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
      <nav className="no-scrollbar mx-auto max-w-6xl overflow-x-auto px-2 sm:px-4" aria-label="Admin sections">
        <ul className="flex gap-1 py-1.5 text-sm">
          {NAV_ITEMS.map((item) => {
            const active = item.match(pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
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

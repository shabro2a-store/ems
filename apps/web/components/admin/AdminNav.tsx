'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/admin', label: 'Dashboard', match: (p: string) => p === '/admin' },
  { href: '/admin/users', label: 'Users', match: (p: string) => p.startsWith('/admin/users') },
  { href: '/admin/branches', label: 'Branches', match: (p: string) => p.startsWith('/admin/branches') },
  { href: '/admin/adjustments', label: 'Adjustments', match: (p: string) => p.startsWith('/admin/adjustments') },
  { href: '/admin/punches', label: 'Punches', match: (p: string) => p.startsWith('/admin/punches') },
  { href: '/admin/flags', label: 'Flags', match: (p: string) => p.startsWith('/admin/flags') },
  { href: '/admin/pending', label: 'Pending', match: (p: string) => p.startsWith('/admin/pending') },
  { href: '/admin/payroll', label: 'Payroll', match: (p: string) => p.startsWith('/admin/payroll') },
  { href: '/admin/schedule', label: 'Schedule', match: (p: string) => p.startsWith('/admin/schedule') },
];

export interface AdminNavProps {
  username: string;
  flagCount: number;
}

export default function AdminNav({ username, flagCount }: AdminNavProps) {
  const pathname = usePathname();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-10 bg-white border-b border-gray-200">
      <div className="px-4 py-3 flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">Admin</div>
          <div className="text-sm font-semibold">{username}</div>
        </div>
        <div className="flex items-center gap-2">
          {flagCount > 0 && (
            <span className="rounded-full bg-amber-500 text-white text-xs px-2 py-1">
              {flagCount} flag{flagCount === 1 ? '' : 's'}
            </span>
          )}
          <button
            type="button"
            onClick={logout}
            className="min-h-[44px] rounded bg-gray-200 px-3 py-2 text-sm hover:bg-gray-300"
          >
            Logout
          </button>
        </div>
      </div>
      <nav className="overflow-x-auto border-t border-gray-100 bg-gray-50">
        <ul className="flex gap-1 px-2 py-1 text-sm whitespace-nowrap">
          {NAV_ITEMS.map((item) => {
            const active = item.match(pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block px-3 py-2 rounded ${active ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-200'}`}
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
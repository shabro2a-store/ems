import React from 'react';

/**
 * The one mark on every screen: the cart on the brand blue, the name beside
 * it. Drawn once here so the login page, the admin header and the field
 * shell cannot drift apart, and so the icon matches the home-screen icon
 * the phones already have.
 */
export function CartIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 3h2l.4 2M7 13h10l3-8H5.4M7 13 5.4 5M7 13l-1.6 4h12" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="17" cy="20" r="1.5" />
    </svg>
  );
}

export function BrandMark({ subtitle, size = 'sm' }: { subtitle?: React.ReactNode; size?: 'sm' | 'lg' }) {
  if (size === 'lg') {
    return (
      <div className="flex flex-col items-center text-center">
        <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-white shadow-sm">
          <CartIcon size={28} />
        </span>
        <span className="text-2xl font-semibold tracking-tight">Shabro2a</span>
        {subtitle && <span className="mt-1 text-sm text-muted">{subtitle}</span>}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-primary text-white">
        <CartIcon />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="text-sm font-semibold">Shabro2a</div>
        {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
      </div>
    </div>
  );
}

import type { Metadata, Viewport } from 'next';
import { initSentry } from '@/lib/sentry';
import './globals.css';

if (typeof window === 'undefined') {
  initSentry();
}

export const metadata: Metadata = {
  title: 'Shabro2a',
  description: 'Shabro2a Employee Management',
  manifest: '/manifest.json',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Shabro2a' },
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

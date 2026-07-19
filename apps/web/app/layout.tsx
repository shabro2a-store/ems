import type { Metadata } from 'next';
import { initSentry } from '@/lib/sentry';
import './globals.css';

if (typeof window === 'undefined') {
  initSentry();
}

export const metadata: Metadata = {
  title: 'Supermarket EMS',
  description: 'Employee Management System',
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

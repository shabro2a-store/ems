import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function CallerLayout({ children }: { children: React.ReactNode }) {
  const h = headers();
  const role = h.get('x-user-role');
  const userId = h.get('x-user-id');
  if (!userId) redirect('/login');
  if (role !== 'CALLER') {
    redirect(role === 'ADMIN' ? '/admin' : role === 'DRIVER' ? '/driver' : '/employee');
  }
  return <div className="min-h-screen bg-surface-muted">{children}</div>;
}

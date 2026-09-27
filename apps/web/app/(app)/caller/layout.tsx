import { identity } from '@/lib/auth/identity';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function CallerLayout({ children }: { children: React.ReactNode }) {
  const me = await identity();
  if (!me) redirect('/login');
  const role = me.role;
  const userId = me.userId;
  if (!userId) redirect('/login');
  if (role !== 'CALLER') {
    redirect(role === 'ADMIN' ? '/admin' : role === 'DRIVER' ? '/driver' : '/employee');
  }
  return <div className="min-h-screen bg-surface-muted">{children}</div>;
}

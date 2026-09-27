import { identity } from '@/lib/auth/identity';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db/prisma';
import AdminNav from '@/components/admin/AdminNav';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await identity();
  if (!me) redirect('/login');
  const role = me.role;
  const userId = me.userId;

  if (!userId) redirect('/login');
  if (role !== 'ADMIN') {
    redirect(role === 'DRIVER' ? '/driver' : role === 'CALLER' ? '/caller' : '/employee');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, name: true },
  });

  return (
    <div className="min-h-screen bg-bg">
      <AdminNav username={user?.name || user?.username || 'admin'} />
      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6">{children}</main>
    </div>
  );
}

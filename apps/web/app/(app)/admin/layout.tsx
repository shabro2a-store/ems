import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db/prisma';
import { todayInBeirut, todayInBeirutDateRange } from 'time';
import AdminNav from '@/components/admin/AdminNav';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const h = headers();
  const role = h.get('x-user-role');
  const userId = h.get('x-user-id');

  if (!userId) redirect('/login');
  if (role !== 'ADMIN') {
    redirect(role === 'DRIVER' ? '/driver' : '/employee');
  }

  const { startUtc, endUtc } = todayInBeirutDateRange(todayInBeirut());
  const [user, flagCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { username: true } }),
    prisma.flag.count({ where: { created_at: { gte: startUtc, lt: endUtc } } }),
  ]);

  return (
    <div className="min-h-screen bg-bg">
      <AdminNav username={user?.username ?? 'admin'} flagCount={flagCount} />
      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6">{children}</main>
    </div>
  );
}

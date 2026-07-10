import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import EmployeeHomeClient from './EmployeeHomeClient';

export const dynamic = 'force-dynamic';

export default async function EmployeeHomePage() {
  const h = headers();
  const role = h.get('x-user-role');
  const userId = h.get('x-user-id');
  if (!role || !userId) redirect('/login');
  if (role === 'ADMIN') redirect('/admin');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { branch: true },
  });
  if (!user || !user.branch) {
    return (
      <main className="p-6">
        <h1 className="text-xl font-semibold">Employee home</h1>
        <p className="text-gray-700 mt-2">No branch assigned. Contact your administrator.</p>
      </main>
    );
  }

  return (
    <EmployeeHomeClient
      branch={{
        name: user.branch.name,
        gps_radius_m: user.branch.gps_radius_m,
        gps_accuracy_max_m: user.branch.gps_accuracy_max_m,
      }}
    />
  );
}

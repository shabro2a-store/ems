import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import DriverHomeClient from './DriverHomeClient';

export const dynamic = 'force-dynamic';

export default async function DriverHomePage() {
  const h = headers();
  const role = h.get('x-user-role');
  const userId = h.get('x-user-id');
  if (!role || !userId) redirect('/login');
  if (role === 'ADMIN') redirect('/admin');
  if (role !== 'DRIVER') redirect('/');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { branch: true },
  });
  if (!user || !user.branch) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center">
        <p className="font-medium">No branch assigned</p>
        <p className="mt-1 text-sm text-muted">Contact your administrator to be assigned to a branch.</p>
      </div>
    );
  }

  return (
    <DriverHomeClient
      username={user.name || user.username}
      branch={{
        name: user.branch.name,
        gps_radius_m: user.branch.gps_radius_m,
        gps_accuracy_max_m: user.branch.gps_accuracy_max_m,
        trip_threshold_min: user.branch.trip_threshold_min,
      }}
    />
  );
}
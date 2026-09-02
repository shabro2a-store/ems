import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { retireUser } from '@/lib/services/userDelete';

const Patch = z.object({
  name: z.string().min(1).max(80).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  gpsRadiusM: z.number().int().min(1).max(10_000).optional(),
  gpsAccuracyMaxM: z.number().int().min(1).max(10_000).optional(),
  shiftGraceMin: z.number().int().min(0).max(120).optional(),
  tripThresholdMin: z.number().int().min(1).max(240).optional(),
  isActive: z.boolean().optional(),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  const branches = await prisma.branch.findMany({ orderBy: { name: 'asc' } });
  return NextResponse.json({ ok: true, data: { branches } });
}

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Patch>;
  try {
    body = Patch.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  const before = await prisma.branch.findUnique({ where: { id: ctx.params.id } });
  if (!before) return jsonError('NOT_FOUND', 'Branch not found', 404);

  const branch = await prisma.branch.update({
    where: { id: ctx.params.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.lat !== undefined ? { lat: body.lat } : {}),
      ...(body.lng !== undefined ? { lng: body.lng } : {}),
      ...(body.gpsRadiusM !== undefined ? { gps_radius_m: body.gpsRadiusM } : {}),
      ...(body.gpsAccuracyMaxM !== undefined ? { gps_accuracy_max_m: body.gpsAccuracyMaxM } : {}),
      ...(body.shiftGraceMin !== undefined ? { shift_grace_min: body.shiftGraceMin } : {}),
      ...(body.tripThresholdMin !== undefined ? { trip_threshold_min: body.tripThresholdMin } : {}),
      ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
    },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'branch.update',
    entity: 'Branch',
    entityId: branch.id,
    before: { name: before.name, lat: before.lat, lng: before.lng, gps_radius_m: before.gps_radius_m, gps_accuracy_max_m: before.gps_accuracy_max_m, shift_grace_min: before.shift_grace_min, trip_threshold_min: before.trip_threshold_min, is_active: before.is_active },
    after: { name: branch.name, lat: branch.lat, lng: branch.lng, gps_radius_m: branch.gps_radius_m, gps_accuracy_max_m: branch.gps_accuracy_max_m, shift_grace_min: branch.shift_grace_min, trip_threshold_min: branch.trip_threshold_min, is_active: branch.is_active },
  });

  return NextResponse.json({ ok: true, data: { branch } });
}

export async function DELETE(req: Request, ctx: { params: { id: string } }) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  const branch = await prisma.branch.findUnique({ where: { id: ctx.params.id } });
  if (!branch) return jsonError('NOT_FOUND', 'Branch not found', 404);

  // Same rule as a person, one scale up: the branch goes today, what happened
  // there stays. Punch.branch_id and Trip.branch_id are required foreign keys,
  // so the row itself cannot go without taking a paid month's punches with it.
  const [staff, punchCount, tripCount] = await Promise.all([
    prisma.user.findMany({
      // ADMIN is never touched: the owner may be filed against a branch and
      // retiring him would lock everybody out of the system.
      where: {
        branch_id: branch.id,
        deleted_at: null,
        role: { in: ['EMPLOYEE', 'DRIVER', 'CALLER'] },
      },
      select: { id: true, username: true, name: true },
    }),
    prisma.punch.count({ where: { branch_id: branch.id } }),
    prisma.trip.count({ where: { branch_id: branch.id } }),
  ]);
  const hasHistory = staff.length + punchCount + tripCount > 0;

  if (hasHistory) {
    const now = new Date();
    await prisma.branch.update({
      where: { id: branch.id },
      data: { is_active: false, deleted_at: now },
    });

    // The staff go with it, and this is the part that makes closing a branch
    // mean something. Their accounts are only usable AT a branch - punching
    // resolves the geofence from user.branch, and a branchless account is
    // refused BRANCH_NOT_FOUND at the door. Leaving them assigned to a closed
    // shop would be an account that looks fine on the staff list and fails
    // silently every morning. Anyone who is really moving to another branch
    // should be reassigned BEFORE this, which is why the confirm names them.
    for (const u of staff) {
      await retireUser(prisma, u, now);
      await writeAuditLog({
        actorId: adminId,
        action: 'user.retire',
        entity: 'User',
        entityId: u.id,
        before: { username: u.username, name: u.name, branch_id: branch.id },
        after: {
          deleted_at: now.toISOString(),
          username_freed: u.username,
          reason: `branch ${branch.name} was closed`,
        },
      });
    }

    await writeAuditLog({
      actorId: adminId,
      action: 'branch.close',
      entity: 'Branch',
      entityId: branch.id,
      before: { name: branch.name, is_active: branch.is_active },
      after: {
        is_active: false,
        deleted_at: now.toISOString(),
        reason: 'closed by the owner; records kept so paid months still reconstruct',
        staff_retired: staff.length,
        punches: punchCount,
        trips: tripCount,
      },
    });
    return NextResponse.json({
      ok: true,
      data: { deleted: true, closed: true, staff_retired: staff.length },
    });
  }

  await prisma.branch.delete({ where: { id: branch.id } });
  await writeAuditLog({
    actorId: adminId,
    action: 'branch.delete',
    entity: 'Branch',
    entityId: branch.id,
    before: { name: branch.name },
  });
  return NextResponse.json({ ok: true, data: { deleted: true, closed: false, staff_retired: 0 } });
}

export const dynamic = 'force-dynamic';
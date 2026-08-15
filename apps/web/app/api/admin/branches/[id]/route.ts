import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';

const Patch = z.object({
  name: z.string().min(1).max(80).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  gpsRadiusM: z.number().int().min(1).max(10_000).optional(),
  gpsAccuracyMaxM: z.number().int().min(1).max(10_000).optional(),
  overtimeGraceMin: z.number().int().min(0).max(120).optional(),
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
      ...(body.overtimeGraceMin !== undefined ? { overtime_grace_min: body.overtimeGraceMin } : {}),
      ...(body.tripThresholdMin !== undefined ? { trip_threshold_min: body.tripThresholdMin } : {}),
      ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
    },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'branch.update',
    entity: 'Branch',
    entityId: branch.id,
    before: { name: before.name, lat: before.lat, lng: before.lng, gps_radius_m: before.gps_radius_m, gps_accuracy_max_m: before.gps_accuracy_max_m, overtime_grace_min: before.overtime_grace_min, trip_threshold_min: before.trip_threshold_min, is_active: before.is_active },
    after: { name: branch.name, lat: branch.lat, lng: branch.lng, gps_radius_m: branch.gps_radius_m, gps_accuracy_max_m: branch.gps_accuracy_max_m, overtime_grace_min: branch.overtime_grace_min, trip_threshold_min: branch.trip_threshold_min, is_active: branch.is_active },
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

  // A branch referenced by staff, punches or trips cannot be hard-deleted
  // without losing history — archive it (is_active=false) instead.
  const [userCount, punchCount, tripCount] = await Promise.all([
    prisma.user.count({ where: { branch_id: branch.id } }),
    prisma.punch.count({ where: { branch_id: branch.id } }),
    prisma.trip.count({ where: { branch_id: branch.id } }),
  ]);
  const hasHistory = userCount + punchCount + tripCount > 0;

  if (hasHistory) {
    await prisma.branch.update({ where: { id: branch.id }, data: { is_active: false } });
    await writeAuditLog({
      actorId: adminId,
      action: 'branch.archive',
      entity: 'Branch',
      entityId: branch.id,
      before: { is_active: branch.is_active },
      after: { is_active: false, reason: 'has history', users: userCount, punches: punchCount, trips: tripCount },
    });
    return NextResponse.json({ ok: true, data: { deleted: false, archived: true } });
  }

  await prisma.branch.delete({ where: { id: branch.id } });
  await writeAuditLog({
    actorId: adminId,
    action: 'branch.delete',
    entity: 'Branch',
    entityId: branch.id,
    before: { name: branch.name },
  });
  return NextResponse.json({ ok: true, data: { deleted: true, archived: false } });
}

export const dynamic = 'force-dynamic';
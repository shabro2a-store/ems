import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';

const Create = z.object({
  name: z.string().min(1).max(80),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  gpsRadiusM: z.number().int().min(1).max(10_000).optional(),
  gpsAccuracyMaxM: z.number().int().min(1).max(10_000).optional(),
  shiftGraceMin: z.number().int().min(0).max(120).optional(),
  tripThresholdMin: z.number().int().min(1).max(240).optional(),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  // staff_count so the close confirmation can name how many people go with the
  // branch before it happens, rather than reporting it afterwards.
  const branches = await prisma.branch.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          users: { where: { deleted_at: null, role: { in: ['EMPLOYEE', 'DRIVER', 'CALLER'] } } },
        },
      },
    },
  });
  return NextResponse.json({
    ok: true,
    data: {
      branches: branches.map(({ _count, ...b }) => ({ ...b, staff_count: _count.users })),
    },
  });
}

export async function POST(req: Request) {
  const h = headers();
  const adminId = h.get('x-user-id');
  if (h.get('x-user-role') !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Create>;
  try {
    body = Create.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  const branch = await prisma.branch.create({
    data: {
      name: body.name,
      lat: body.lat ?? 0,
      lng: body.lng ?? 0,
      ...(body.gpsRadiusM !== undefined ? { gps_radius_m: body.gpsRadiusM } : {}),
      ...(body.gpsAccuracyMaxM !== undefined ? { gps_accuracy_max_m: body.gpsAccuracyMaxM } : {}),
      ...(body.shiftGraceMin !== undefined ? { shift_grace_min: body.shiftGraceMin } : {}),
      ...(body.tripThresholdMin !== undefined ? { trip_threshold_min: body.tripThresholdMin } : {}),
    },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'branch.create',
    entity: 'Branch',
    entityId: branch.id,
    after: { name: branch.name, lat: branch.lat, lng: branch.lng },
  });

  return NextResponse.json({ ok: true, data: { branch } });
}

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

const Query = z.object({
  branchId: z.string().optional(),
  userId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(req: Request) {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const url = new URL(req.url);
  const parsed = Query.safeParse({
    branchId: url.searchParams.get('branchId') ?? undefined,
    userId: url.searchParams.get('userId') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return jsonError('INVALID_INPUT', 'Invalid query params: ' + parsed.error.message, 400);
  }

  const { branchId, userId, from, to, limit } = parsed.data;
  const where: Record<string, unknown> = {};
  if (branchId) where.branch_id = branchId;
  if (userId) where.user_id = userId;
  if (from || to) {
    where.at = {};
    if (from) (where.at as Record<string, Date>).gte = new Date(from);
    if (to) (where.at as Record<string, Date>).lte = new Date(to);
  }

  const rows = await prisma.punch.findMany({
    where,
    orderBy: { at: 'desc' },
    take: limit,
    include: {
      user: { select: { id: true, username: true, role: true } },
      branch: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({
    ok: true,
    data: {
      punches: rows.map((p) => ({
        id: p.id,
        user_id: p.user_id,
        branch_id: p.branch_id,
        kind: p.kind,
        at: p.at.toISOString(),
        lat: p.lat,
        lng: p.lng,
        accuracy_m: p.accuracy_m,
        device_fp: p.device_fp,
        user: p.user,
        branch: p.branch,
      })),
    },
  });
}

export const dynamic = 'force-dynamic';

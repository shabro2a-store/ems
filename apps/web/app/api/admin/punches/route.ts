import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

const Query = z.object({
  branchId: z.string().optional(),
  userId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // 200 by default. Staff punch several times a day now - a split shift, a
  // break, a forgotten checkout corrected - so 100 stopped covering a busy
  // month for a single person, let alone a branch.
  limit: z.coerce.number().int().positive().max(500).default(200),
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

  // One more than asked for, purely to answer "is there anything past this?".
  // A count() would be a second trip over the same index for a number nobody
  // reads; the extra row is discarded below.
  const rows = await prisma.punch.findMany({
    where,
    orderBy: { at: 'desc' },
    take: limit + 1,
    include: {
      user: { select: { id: true, username: true, role: true } },
      branch: { select: { id: true, name: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    ok: true,
    data: {
      limit,
      // Older punches match the filter but are not in this response. The screen
      // says so rather than letting the newest 200 read as the whole story.
      has_more: hasMore,
      punches: page.map((p) => ({
        id: p.id,
        user_id: p.user_id,
        branch_id: p.branch_id,
        kind: p.kind,
        at: p.at.toISOString(),
        lat: p.lat,
        lng: p.lng,
        accuracy_m: p.accuracy_m,
        device_fp: p.device_fp,
        corrected: p.corrected,
        correction_reason: p.correction_reason,
        // Its lat/lng are the branch's own, so without this the row reads as a
        // person standing at the shop pressing a button. Nobody did.
        system_generated: p.system_generated,
        user: p.user,
        branch: p.branch,
      })),
    },
  });
}

export const dynamic = 'force-dynamic';

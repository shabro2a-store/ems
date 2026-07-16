import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { writeAuditLog } from '@/lib/services/audit';

const Create = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  role: z.enum(['EMPLOYEE', 'DRIVER', 'ADMIN']),
  branchId: z.string().nullable().optional(),
  hourlyRateCent: z.number().int().nonnegative(),
});

const ROLES_FOR_BRANCH = new Set(['EMPLOYEE', 'DRIVER']);

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const users = await prisma.user.findMany({
    orderBy: { username: 'asc' },
    include: { branch: { select: { id: true, name: true } } },
  });
  return NextResponse.json({ ok: true, data: { users } });
}

export async function POST(req: Request) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const idemKey = req.headers.get('idempotency-key');
  if (!idemKey) return jsonError('INVALID_INPUT', 'Idempotency-Key header is required', 400);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Create>;
  try {
    body = Create.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  if (ROLES_FOR_BRANCH.has(body.role) && !body.branchId) {
    return jsonError('INVALID_INPUT', 'Branch required for non-admin role', 400);
  }

  const cached = await readIdempotentResponse({ userId: adminId, key: idemKey });
  if (cached) return NextResponse.json(cached.response_json, { status: cached.status_code });

  const passwordHash = await bcrypt.hash(body.password, 12);

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        username: body.username,
        password_hash: passwordHash,
        role: body.role,
        branch_id: ROLES_FOR_BRANCH.has(body.role) ? body.branchId : null,
        hourly_rate_cent: body.hourlyRateCent,
        is_active: true,
      },
    });
    if (ROLES_FOR_BRANCH.has(body.role)) {
      await tx.rateChange.create({
        data: {
          user_id: u.id,
          rate_cent: body.hourlyRateCent,
          effective_from: new Date(),
        },
      });
    }
    return u;
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'user.create',
    entity: 'User',
    entityId: user.id,
    after: { username: user.username, role: user.role, branch_id: user.branch_id, hourly_rate_cent: user.hourly_rate_cent },
  });

  const tempPassword = body.password;
  const response = {
    ok: true,
    data: {
      user,
      temp_password: tempPassword,
    },
  };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';
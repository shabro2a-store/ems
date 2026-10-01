import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { readIdempotentResponse, storeIdempotentResponse } from '@/lib/services/idempotency';
import { writeAuditLog } from '@/lib/services/audit';
import { recordOvertimeRate } from '@/lib/services/overtime';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/constants';

const Create = z.object({
  username: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
  role: z.enum(['EMPLOYEE', 'DRIVER', 'ADMIN', 'CALLER']),
  branchId: z.string().nullable().optional(),
  hourlyRateCent: z.number().int().nonnegative(),
  // Per completed trip, drivers only. Ignored for any other role rather than
  // rejected, so a form that always sends it does not have to know.
  tripRateCent: z.number().int().nonnegative().optional(),
  // Optional; null or absent = overtime at the hourly rate (overtime.ts).
  overtimeRateCent: z.number().int().nonnegative().nullable().optional(),
  // Omitted on every normal create, and the column defaults to false: a new
  // account is single-branch until the owner deliberately grants otherwise.
  canRoamBranches: z.boolean().optional(),
});

// Roles that belong to a branch. Callers (POS cashiers) are branch-scoped too but
// are not paid hourly through this system, so they get no RateChange row.
const ROLES_FOR_BRANCH = new Set(['EMPLOYEE', 'DRIVER', 'CALLER']);
const ROLES_WITH_RATE = new Set(['EMPLOYEE', 'DRIVER']);

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const me = await identity();
  if (!me) return unauthorized();
  const role = me.role;
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  // Never send password_hash (or other secrets) to the client — select explicitly.
  // Retired accounts are gone from here for good. They are not "inactive staff
  // you might reactivate" - the login is dead and the username has been handed
  // back, so a row that cannot be logged into or hired again has no business on
  // a staff list. Their records still surface where records belong: payroll for
  // the months they worked, and the punches log.
  const users = await prisma.user.findMany({
    where: { deleted_at: null },
    orderBy: { username: 'asc' },
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      branch_id: true,
      hourly_rate_cent: true,
      // Both rates the edit form starts from. trip_rate_cent was missing, so a
      // driver's edit form opened with an empty "Per trip" box, and saving it
      // sent a value the route refuses - every driver edit failed.
      trip_rate_cent: true,
      overtime_rate_cent: true,
      is_active: true,
      can_roam_branches: true,
      day_start_hour: true,
      telegram_chat_id: true,
      notify_daily_summary: true,
      notify_routine_pings: true,
      created_at: true,
      branch: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json({ ok: true, data: { users } });
}

export async function POST(req: Request) {
  const me = await identity();
  if (!me) return unauthorized();
  const role = me.role;
  const adminId = me.userId;
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

  // Admin accounts cannot be created through the app — there is a single owner
  // account. Managerial roles will be added deliberately when the business grows.
  if (body.role === 'ADMIN') {
    return jsonError('FORBIDDEN', 'Admin accounts cannot be created here', 403);
  }
  if (ROLES_FOR_BRANCH.has(body.role) && !body.branchId) {
    return jsonError('INVALID_INPUT', 'Branch required for non-admin role', 400);
  }
  // One active caller per branch (for now).
  if (body.role === 'CALLER' && body.branchId) {
    const existing = await prisma.user.findFirst({
      where: { role: 'CALLER', branch_id: body.branchId, is_active: true },
      select: { id: true },
    });
    if (existing) return jsonError('CALLER_EXISTS', 'This branch already has a caller', 409);
  }

  const cached = await readIdempotentResponse({ userId: adminId, key: idemKey, scope: new URL(req.url).pathname });
  if (cached) return NextResponse.json(cached.response_json, { status: cached.status_code });

  const passwordHash = await bcrypt.hash(body.password, 12);

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        username: body.username,
        name: body.name?.trim() || null,
        password_hash: passwordHash,
        role: body.role,
        branch_id: ROLES_FOR_BRANCH.has(body.role) ? body.branchId : null,
        hourly_rate_cent: body.hourlyRateCent,
        trip_rate_cent: body.role === 'DRIVER' ? (body.tripRateCent ?? 0) : 0,
        overtime_rate_cent: ROLES_WITH_RATE.has(body.role) ? (body.overtimeRateCent ?? null) : null,
        can_roam_branches: body.canRoamBranches ?? false,
        is_active: true,
      },
    });
    if (ROLES_WITH_RATE.has(body.role)) {
      await tx.rateChange.create({
        data: {
          user_id: u.id,
          rate_cent: body.hourlyRateCent,
          effective_from: new Date(),
        },
      });
    }
    // The per-trip history starts the same way the hourly one does, so a
    // driver's first month prices every trip rather than none of them.
    if (body.role === 'DRIVER' && (body.tripRateCent ?? 0) > 0) {
      await tx.tripRateChange.create({
        data: { user_id: u.id, rate_cent: body.tripRateCent!, effective_from: new Date() },
      });
    }
    if (ROLES_WITH_RATE.has(body.role) && body.overtimeRateCent != null) {
      await recordOvertimeRate(tx, u.id, body.overtimeRateCent, null);
    }
    await writeAuditLog({
      actorId: adminId,
      action: 'user.create',
      entity: 'User',
      entityId: u.id,
      after: {
        username: u.username,
        role: u.role,
        branch_id: u.branch_id,
        hourly_rate_cent: u.hourly_rate_cent,
        overtime_rate_cent: u.overtime_rate_cent,
      },
      db: tx,
    });
    return u;
  });

  // The password is not sent back: the owner typed it, and this answer is kept
  // as the Idempotency-Key replay - it used to sit there, and in every backup,
  // in plain text.
  const { password_hash: _pwh, ...safeUser } = user;
  const response = { ok: true, data: { user: safeUser } };
  await storeIdempotentResponse({ userId: adminId, key: idemKey, scope: new URL(req.url).pathname, status_code: 200, response_json: response });
  return NextResponse.json(response, { status: 200 });
}

export const dynamic = 'force-dynamic';
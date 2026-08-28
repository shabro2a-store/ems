import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { userHistory, hasHistory, deleteUserAndSetup } from '@/lib/services/userDelete';

const Patch = z.object({
  username: z.string().min(1).max(64).optional(),
  name: z.string().max(120).optional(),
  role: z.enum(['EMPLOYEE', 'DRIVER', 'ADMIN', 'CALLER']).optional(),
  branchId: z.string().nullable().optional(),
  hourlyRateCent: z.number().int().nonnegative().optional(),
  // Reference only (see schema.prisma). null clears it back to unset.
  expectedMonthlySalaryCent: z.number().int().nonnegative().nullable().optional(),
  // Clock in and out at any active branch, not only their own. Revoking it
  // bites on the very next punch - nothing about it is cached or copied onto a
  // token, so a shift already in progress finishes under the new rule.
  canRoamBranches: z.boolean().optional(),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
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

  const before = await prisma.user.findUnique({ where: { id: ctx.params.id } });
  if (!before) return jsonError('NOT_FOUND', 'User not found', 404);

  // Protect the single admin account: you can't promote anyone to ADMIN, and you
  // can't change the admin's role (which would demote/lock out the owner).
  if (body.role === 'ADMIN') {
    return jsonError('FORBIDDEN', 'Cannot promote a user to admin', 403);
  }
  if (before.role === 'ADMIN' && body.role !== undefined) {
    return jsonError('FORBIDDEN', 'The admin account cannot be changed', 403);
  }

  // One active caller per branch: block edits that would make a second one.
  const willBeCaller = (body.role ?? before.role) === 'CALLER';
  const targetBranch = body.branchId !== undefined ? body.branchId : before.branch_id;
  if (willBeCaller && targetBranch) {
    const otherCaller = await prisma.user.findFirst({
      where: { role: 'CALLER', branch_id: targetBranch, is_active: true, id: { not: before.id } },
      select: { id: true },
    });
    if (otherCaller) return jsonError('CALLER_EXISTS', 'This branch already has a caller', 409);
  }

  // Username must stay unique.
  if (body.username && body.username !== before.username) {
    const clash = await prisma.user.findUnique({ where: { username: body.username }, select: { id: true } });
    if (clash && clash.id !== before.id) {
      return jsonError('USERNAME_TAKEN', 'That username is already in use', 409);
    }
  }

  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: ctx.params.id },
      data: {
        ...(body.username ? { username: body.username } : {}),
        ...(body.name !== undefined ? { name: body.name.trim() || null } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.branchId !== undefined ? { branch_id: body.branchId } : {}),
        ...(body.hourlyRateCent !== undefined && body.hourlyRateCent !== before.hourly_rate_cent
          ? { hourly_rate_cent: body.hourlyRateCent }
          : {}),
        ...(body.expectedMonthlySalaryCent !== undefined
          ? { expected_monthly_salary_cent: body.expectedMonthlySalaryCent }
          : {}),
        ...(body.canRoamBranches !== undefined
          ? { can_roam_branches: body.canRoamBranches }
          : {}),
      },
    });
    if (body.hourlyRateCent !== undefined && body.hourlyRateCent !== before.hourly_rate_cent) {
      await tx.rateChange.create({
        data: {
          user_id: updated.id,
          rate_cent: body.hourlyRateCent,
          effective_from: new Date(),
        },
      });
    }
    return updated;
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'user.update',
    entity: 'User',
    entityId: user.id,
    before: {
      username: before.username,
      role: before.role,
      branch_id: before.branch_id,
      hourly_rate_cent: before.hourly_rate_cent,
      expected_monthly_salary_cent: before.expected_monthly_salary_cent,
      can_roam_branches: before.can_roam_branches,
    },
    after: {
      username: user.username,
      role: user.role,
      branch_id: user.branch_id,
      hourly_rate_cent: user.hourly_rate_cent,
      expected_monthly_salary_cent: user.expected_monthly_salary_cent,
      can_roam_branches: user.can_roam_branches,
    },
  });

  const { password_hash: _pwh, ...safeUser } = user;
  return NextResponse.json({ ok: true, data: { user: safeUser } });
}

/**
 * Remove a person entirely - or, if that would destroy a record, deactivate
 * them and say so.
 *
 * Same rule and same shape as DELETE /api/admin/branches/[id], deliberately:
 * an account with nothing behind it is a mistake to be swept away, and one with
 * punches behind it is a month that has to stay reconstructible. The owner
 * presses one button either way and the response says which happened, rather
 * than the app refusing and leaving them to work out why.
 *
 * The audit row survives the person: AuditLog.actor_id carries no foreign key,
 * so the record of the deletion is still there when the user is not.
 */
export async function DELETE(req: Request, ctx: { params: { id: string } }) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  const user = await prisma.user.findUnique({ where: { id: ctx.params.id } });
  if (!user) return jsonError('NOT_FOUND', 'User not found', 404);

  // The same guard deactivate carries. Deleting the owner's own account would
  // lock everybody out of the system with no way back in.
  if (user.role === 'ADMIN') {
    return jsonError('FORBIDDEN', 'The admin account cannot be deleted', 403);
  }
  if (user.id === adminId) {
    return jsonError('FORBIDDEN', 'You cannot delete your own account', 403);
  }

  const history = await userHistory(prisma, user.id);

  if (hasHistory(history)) {
    const wasActive = user.is_active;
    if (wasActive) {
      await prisma.user.update({ where: { id: user.id }, data: { is_active: false } });
    }
    await writeAuditLog({
      actorId: adminId,
      action: 'user.deactivate',
      entity: 'User',
      entityId: user.id,
      before: { username: user.username, is_active: wasActive },
      after: { is_active: false, reason: 'delete requested but the person has history', ...history },
    });
    return NextResponse.json({
      ok: true,
      data: { deleted: false, deactivated: true, history },
    });
  }

  await deleteUserAndSetup(prisma, user.id);
  await writeAuditLog({
    actorId: adminId,
    action: 'user.delete',
    entity: 'User',
    entityId: user.id,
    before: {
      username: user.username,
      name: user.name,
      role: user.role,
      branch_id: user.branch_id,
      hourly_rate_cent: user.hourly_rate_cent,
    },
  });
  return NextResponse.json({ ok: true, data: { deleted: true, deactivated: false } });
}

export const dynamic = 'force-dynamic';
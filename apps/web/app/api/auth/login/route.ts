import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { verifyPassword } from '@/lib/auth/password';
import { trustedClientIp } from '@/lib/auth/cookies';
import { issueSession } from '@/lib/auth/issueSession';
import {
  LOGIN_ATTEMPTS_PER_ACCOUNT,
  LOGIN_ACCOUNT_WINDOW_MS,
  LOGIN_ATTEMPTS_PER_ADDRESS,
  LOGIN_ADDRESS_WINDOW_MS,
  SEED_DEFAULT_PASSWORD,
  PASSWORD_MIN_LENGTH,
  BCRYPT_ROUNDS,
} from '@/lib/auth/constants';
import { consumeRateLimit } from '@/lib/services/rateLimit';
import { writeAuditLog } from '@/lib/services/audit';

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  // Only with the seed password, which works for nothing else (see below).
  newPassword: z.string().max(256).optional(),
});

// A real bcrypt hash (cost 12) of a random string nobody knows. Checked when
// the username does not exist, so an unknown name costs the same ~250ms as a
// wrong password and the response time stops saying which usernames are real.
const NO_SUCH_USER_HASH = '$2a$12$k6fta/HOSdqfkwFmC45VR.H/wyrSYOXvL2cV/IeKU743ZyZrmrxpu';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function tooMany(retryAfterSec = 60) {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        message: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      },
    },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  );
}

export async function POST(req: Request) {
  let body: z.infer<typeof LoginBody>;
  try {
    body = LoginBody.parse(await req.json());
  } catch {
    return jsonError('INVALID_INPUT', 'Invalid request body', 400);
  }

  // Per account first: that is the limit an attacker cannot step around by
  // changing the address they claim. Counted for every name tried, real or
  // not, so being limited says nothing about whether the account exists.
  const account = await consumeRateLimit(
    prisma,
    `login:user:${body.username}`,
    LOGIN_ATTEMPTS_PER_ACCOUNT,
    LOGIN_ACCOUNT_WINDOW_MS,
  );
  if (!account.allowed) return tooMany(account.retryAfterSec);
  const ip = trustedClientIp(req);
  if (ip) {
    const address = await consumeRateLimit(prisma, `login:ip:${ip}`, LOGIN_ATTEMPTS_PER_ADDRESS, LOGIN_ADDRESS_WINDOW_MS);
    if (!address.allowed) return tooMany(address.retryAfterSec);
  }

  const user = await prisma.user.findUnique({
    where: { username: body.username },
  });
  // A retired account's hash is a placeholder bcrypt cannot parse, so anyone
  // who cannot sign in is checked against the dummy instead.
  let live = user && user.is_active ? user : null;
  const ok = await verifyPassword(body.password, live?.password_hash ?? NO_SUCH_USER_HASH);
  if (!live || !ok) {
    // Unknown names too: a run of them is what guessing looks like.
    await writeAuditLog({
      actorId: user?.id ?? 'anonymous',
      action: 'auth.login_failed',
      entity: 'User',
      entityId: user?.id ?? body.username,
      after: { username: body.username, ip },
    });
    return jsonError('UNAUTHORIZED', 'Invalid credentials', 401);
  }

  // The seed's admin password is published - it is in the repo and the docs -
  // so it never opens a session: it only lets the owner choose a new one.
  // Staff are left alone; the owner sets their passwords, change-me included.
  if (live.role === 'ADMIN' && body.password === SEED_DEFAULT_PASSWORD) {
    if (!body.newPassword) {
      return jsonError('PASSWORD_CHANGE_REQUIRED', 'Choose a new password to finish signing in.', 403);
    }
    if (body.newPassword.length < PASSWORD_MIN_LENGTH || body.newPassword === SEED_DEFAULT_PASSWORD) {
      return jsonError(
        'INVALID_INPUT',
        `The new password must be at least ${PASSWORD_MIN_LENGTH} characters, and not ${SEED_DEFAULT_PASSWORD}.`,
        400,
      );
    }
    live = await prisma.user.update({
      where: { id: live.id },
      data: { password_hash: await bcrypt.hash(body.newPassword, BCRYPT_ROUNDS), session_version: { increment: 1 } },
    });
    await writeAuditLog({ actorId: live.id, action: 'user.change_password', entity: 'User', entityId: live.id });
  }

  await issueSession(prisma, live);
  await writeAuditLog({ actorId: live.id, action: 'auth.login', entity: 'User', entityId: live.id, after: { ip } });

  return NextResponse.json({
    ok: true,
    data: {
      user: {
        id: live.id,
        username: live.username,
        role: live.role,
        branchId: live.branch_id ?? null,
      },
    },
  });
}

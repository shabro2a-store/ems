import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { verifyPassword } from '@/lib/auth/password';
import { signToken } from '@/lib/auth/jwt';
import { generateCsrfToken } from '@/lib/auth/csrf';
import { sessionExpiryFor } from '@/lib/auth/session';
import { setAuthCookies, getClientIp } from '@/lib/auth/cookies';
import {
  LOGIN_RATE_LIMIT_PER_MIN,
  SEED_DEFAULT_PASSWORD,
} from '@/lib/auth/constants';

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function consumeLoginRateLimit(username: string, ip: string): Promise<boolean> {
  const identifier = `login:${username}:${ip}`;
  const now = new Date();
  const oneMinAgo = new Date(now.getTime() - 60_000);
  const existing = await prisma.rateLimitBucket.findUnique({ where: { identifier } });
  if (!existing) {
    await prisma.rateLimitBucket.create({
      data: { identifier, tokens: LOGIN_RATE_LIMIT_PER_MIN - 1, refilled_at: now },
    });
    return true;
  }
  if (existing.refilled_at < oneMinAgo) {
    await prisma.rateLimitBucket.update({
      where: { identifier },
      data: { tokens: LOGIN_RATE_LIMIT_PER_MIN - 1, refilled_at: now },
    });
    return true;
  }
  if (existing.tokens <= 0) return false;
  await prisma.rateLimitBucket.update({
    where: { identifier },
    data: { tokens: { decrement: 1 } },
  });
  return true;
}

export async function POST(req: Request) {
  const ip = getClientIp(req);

  let body: z.infer<typeof LoginBody>;
  try {
    body = LoginBody.parse(await req.json());
  } catch {
    return jsonError('INVALID_INPUT', 'Invalid request body', 400);
  }

  const allowed = await consumeLoginRateLimit(body.username, ip);
  if (!allowed) {
    return jsonError('RATE_LIMITED', 'Too many login attempts. Try again in a minute.', 429);
  }

  const user = await prisma.user.findUnique({
    where: { username: body.username },
  });

  if (!user || !user.is_active) {
    return jsonError('UNAUTHORIZED', 'Invalid credentials', 401);
  }

  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) {
    return jsonError('UNAUTHORIZED', 'Invalid credentials', 401);
  }

  const now = new Date();
  const lastPunch = await prisma.punch.findFirst({
    where: { user_id: user.id },
    orderBy: { at: 'desc' },
    select: { kind: true },
  });
  const hasOpenPunch = lastPunch?.kind === 'IN';
  const exp = sessionExpiryFor({ role: user.role }, hasOpenPunch, now);
  const accessToken = await signToken(
    { sub: user.id, role: user.role, branchId: user.branch_id ?? null },
    exp,
  );
  const refreshExp = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
  const refreshToken = await signToken(
    { sub: user.id, role: user.role, branchId: user.branch_id ?? null },
    refreshExp,
  );

  const csrf = generateCsrfToken();
  setAuthCookies(accessToken, refreshToken, csrf, exp);

  const mustChangePassword = body.password === SEED_DEFAULT_PASSWORD;

  return NextResponse.json({
    ok: true,
    data: {
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        branchId: user.branch_id ?? null,
      },
      mustChangePassword,
    },
  });
}
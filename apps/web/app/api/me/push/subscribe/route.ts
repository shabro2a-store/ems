import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';

const Body = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Register (or move to this user) a device's push subscription.
export async function POST(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return jsonError('INVALID_INPUT', 'Invalid subscription', 400);
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint: body.endpoint },
    create: { user_id: userId, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth },
    update: { user_id: userId, p256dh: body.keys.p256dh, auth: body.keys.auth },
  });
  return NextResponse.json({ ok: true, data: { subscribed: true } });
}

export const dynamic = 'force-dynamic';

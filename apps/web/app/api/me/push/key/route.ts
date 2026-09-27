import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { vapidPublicKey } from '@/lib/services/push';

// The VAPID public key the client needs to subscribe. Null when push is unconfigured.
export async function GET() {
  const me = await identity();
  if (!me) return unauthorized();
  if (!me.userId) {
    return NextResponse.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  }
  return NextResponse.json({ ok: true, data: { publicKey: vapidPublicKey() } });
}

export const dynamic = 'force-dynamic';

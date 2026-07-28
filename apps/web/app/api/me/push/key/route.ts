import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { vapidPublicKey } from '@/lib/services/push';

// The VAPID public key the client needs to subscribe. Null when push is unconfigured.
export async function GET() {
  const h = headers();
  if (!h.get('x-user-id')) {
    return NextResponse.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  }
  return NextResponse.json({ ok: true, data: { publicKey: vapidPublicKey() } });
}

export const dynamic = 'force-dynamic';

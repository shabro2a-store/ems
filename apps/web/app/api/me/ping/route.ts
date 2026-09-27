import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';

export async function GET() {
  const me = await identity();
  if (!me) return unauthorized();
  return NextResponse.json({
    ok: true,
    data: {
      userId: me.userId,
      role: me.role,
      branchId: me.branchId,
    },
  });
}
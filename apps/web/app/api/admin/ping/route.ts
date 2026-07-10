import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

export async function GET() {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') {
    return NextResponse.json(
      { ok: false, error: { code: 'FORBIDDEN', message: 'Admin only' } },
      { status: 403 },
    );
  }
  return NextResponse.json({
    ok: true,
    data: {
      userId: h.get('x-user-id'),
      role,
      branchId: h.get('x-user-branch-id'),
    },
  });
}
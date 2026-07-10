import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

export async function GET() {
  const h = headers();
  return NextResponse.json({
    ok: true,
    data: {
      userId: h.get('x-user-id'),
      role: h.get('x-user-role'),
      branchId: h.get('x-user-branch-id'),
    },
  });
}
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

/**
 * The receipt photo of one trip, for the owner's review. Served from the
 * database behind the admin session - there is no public URL to a receipt.
 * 404 once the weekly wipe has taken it.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') {
    return NextResponse.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin only' } }, { status: 403 });
  }
  const receipt = await prisma.tripReceipt.findUnique({
    where: { trip_id: params.id },
    select: { mime: true, bytes: true, size: true },
  });
  if (!receipt) {
    return NextResponse.json({ ok: false, error: { code: 'NOT_FOUND', message: 'No photo for this trip' } }, { status: 404 });
  }
  return new Response(new Uint8Array(receipt.bytes), {
    status: 200,
    headers: {
      'Content-Type': receipt.mime,
      'Content-Length': String(receipt.size),
      // The bytes never change; the admin's browser may keep them for the
      // session, nothing in between may.
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export const dynamic = 'force-dynamic';

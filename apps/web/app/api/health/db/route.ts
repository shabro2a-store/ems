import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

const DB_LATENCY_LIMIT_MS = 50;

export async function GET() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'DB_UNREACHABLE',
          message: e instanceof Error ? e.message : 'Database unreachable',
        },
      },
      { status: 503 },
    );
  }
  const latency_ms = Date.now() - started;
  if (latency_ms > DB_LATENCY_LIMIT_MS) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'DB_SLOW',
          message: `DB latency ${latency_ms}ms exceeds limit ${DB_LATENCY_LIMIT_MS}ms`,
        },
      },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, data: { latency_ms } });
}
